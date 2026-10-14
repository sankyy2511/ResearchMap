package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

/* ---------------------------------------------------------------- Python agent client */

type AgentClient struct {
	base, key string
	http      *http.Client
	mu        sync.Mutex
	models    map[string]map[string]string
}

type agentError struct {
	Status     int
	Msg        string
	RetryAfter time.Duration
}

func (e *agentError) Error() string { return fmt.Sprintf("agent %d: %s", e.Status, e.Msg) }

func (ac *AgentClient) post(ctx context.Context, path string, in, out any) error {
	body, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, "POST", ac.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Key", ac.key)
	res, err := ac.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errNoAgent, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != 200 {
		ra, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return &agentError{Status: res.StatusCode, Msg: strings.TrimSpace(string(b)), RetryAfter: time.Duration(ra) * time.Second}
	}
	return json.Unmarshal(b, out)
}

func (ac *AgentClient) Health(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", ac.base+"/health", nil)
	res, err := ac.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var h struct {
		Models map[string]map[string]string `json:"models"`
	}
	_ = json.NewDecoder(res.Body).Decode(&h)
	ac.mu.Lock()
	ac.models = h.Models
	ac.mu.Unlock()
	if res.StatusCode != 200 {
		return errors.New("agent unhealthy")
	}
	return nil
}

func (ac *AgentClient) ReportModel(ctx context.Context) string {
	ac.mu.Lock()
	m := ac.models["report"]["gemini"]
	ac.mu.Unlock()
	if m == "" {
		_ = ac.Health(ctx)
		ac.mu.Lock()
		m = ac.models["report"]["gemini"]
		ac.mu.Unlock()
	}
	if m == "" {
		return "gemini"
	}
	return m
}

/* ---------------------------------------------------------------- pipeline */

// Pipeline runs page analysis in-process with a bounded worker pool. State is persisted on each node
// (ai_stage), so unfinished work is picked up again after a restart.
type Pipeline struct {
	a        *App
	queue    chan string
	mu       sync.Mutex
	inflight map[string]bool // queued or running; stops duplicate tab events from analyzing one node twice
	attempts map[string]int  // Agent 1 failures per node in this process (restart resets; ai_stage<>'ready' is resumed)
	extra    chan struct{}   // bounds background conflict/radar work started after a node is ready
	placeMu  sync.Mutex      // one page at a time picks or creates its topic, so two workers never create the same topic twice
}

// retryDelays: Agent 1 failures are retried in the background so a captured page is never stuck in "failed".
var retryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}

func newPipeline(a *App) *Pipeline {
	return &Pipeline{a: a, queue: make(chan string, 1000), inflight: map[string]bool{}, attempts: map[string]int{}, extra: make(chan struct{}, 2)}
}

func (p *Pipeline) enqueue(nodeID string) {
	p.mu.Lock()
	if p.inflight[nodeID] {
		p.mu.Unlock()
		return
	}
	p.inflight[nodeID] = true
	p.mu.Unlock()
	select {
	case p.queue <- nodeID:
	default:
		p.done(nodeID)
		slog.Warn("pipeline queue full; node will be retried on restart", "node_id", nodeID)
	}
}

func (p *Pipeline) done(nodeID string) {
	p.mu.Lock()
	delete(p.inflight, nodeID)
	p.mu.Unlock()
}

// scheduleRetry re-queues a node whose Agent 1 step failed, with backoff. Returns false when attempts are used up.
func (p *Pipeline) scheduleRetry(nodeID string) (time.Duration, bool) {
	p.mu.Lock()
	n := p.attempts[nodeID]
	p.attempts[nodeID] = n + 1
	p.mu.Unlock()
	if n >= len(retryDelays) {
		return 0, false
	}
	d := retryDelays[n]
	time.AfterFunc(d, func() { p.enqueue(nodeID) })
	return d, true
}

func (p *Pipeline) start(ctx context.Context) {
	// Resume nodes that were mid-pipeline when the server stopped.
	rows, err := p.a.db.Query(ctx, `SELECT id FROM nodes WHERE type='page' AND deleted_at IS NULL AND ai_stage <> 'ready' ORDER BY created_at`)
	if err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				p.enqueue(id)
			}
		}
		rows.Close()
	}
	for i := 0; i < 3; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case id := <-p.queue:
					p.process(ctx, id)
					p.done(id)
				}
			}
		}()
	}
}

type understandOut struct {
	IsResearch        bool      `json:"is_research"`
	IsResearchReason  string    `json:"is_research_reason"`
	PageType          string    `json:"page_type"`
	MainConcept       string    `json:"main_concept"`
	Summary           string    `json:"summary"`
	Topics            []string  `json:"topics"`
	Claims            []claimIn `json:"claims"`
	QuestionsAnswered []string  `json:"questions_answered"`
	Embedding         []float32 `json:"embedding"`
	Fallback          bool      `json:"fallback"`
	FetchedText       string    `json:"fetched_text"`
	FetchedTitle      string    `json:"fetched_title"`
}

type claimIn struct {
	Text      string    `json:"text"`
	Quote     string    `json:"quote"`
	Embedding []float32 `json:"embedding"`
}

func vec(v []float32) *string {
	if len(v) == 0 {
		return nil
	}
	parts := make([]string, len(v))
	for i, f := range v {
		parts[i] = strconv.FormatFloat(float64(f), 'f', 6, 32)
	}
	s := "[" + strings.Join(parts, ",") + "]"
	return &s
}

func (p *Pipeline) job(wsID, kind, status, msg string, nodeID *string, agent int) {
	p.a.publish(wsID, "job.status", nil, gin.H{"kind": kind, "status": status, "message": msg, "node_id": nodeID, "agent": agent})
}

// stage changes ai_stage only; it does not bump version (decision D5) so user edits are not rejected mid-analysis.
func (p *Pipeline) stage(ctx context.Context, nodeID, stage string, extra string) {
	_, _ = p.a.db.Exec(ctx, `UPDATE nodes SET ai_stage=$2, updated_at=now()`+extra+` WHERE id=$1`, nodeID, stage)
	p.a.publishNode(ctx, "node.updated", nodeID, nil)
}

func (p *Pipeline) process(ctx context.Context, nodeID string) {
	a := p.a
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	var wsID, pageID, title, url, content, domain, via string
	var whyRaw []byte
	err := a.db.QueryRow(ctx, `SELECT n.workspace_id, n.page_id, n.title, p.url, p.content_text, p.domain, n.why_opened, n.created_via
		FROM nodes n JOIN pages p ON p.id=n.page_id WHERE n.id=$1 AND n.deleted_at IS NULL`, nodeID).
		Scan(&wsID, &pageID, &title, &url, &content, &domain, &whyRaw, &via)
	if err != nil {
		return
	}
	nid := &nodeID
	p.stage(ctx, nodeID, "analyzing", "")
	p.job(wsID, "analyze_page", "running", "Agent 1 · Analyzing page…", nid, 1)

	// Agent 1 — understand the page (retried: Groq rate limits are common on the free tier).
	var u understandOut
	slog.Info("[AI] Agent 1 started", "workspace_id", wsID, "node_id", nodeID, "page_id", pageID, "content_chars", len(content))
	for attempt := 0; attempt < 3; attempt++ {
		err = a.agent.post(ctx, "/v1/understand", gin.H{"url": url, "title": title, "domain": domain, "content_text": content,
			"fetch_if_short": via == "mcp"}, &u) // AI assistants send snippets: read the full public page
		var ae *agentError
		if err == nil || !(errors.As(err, &ae) && ae.Status == 429) {
			break
		}
		wait := time.Duration(5*(attempt+1)) * time.Second
		if ae.RetryAfter > wait && ae.RetryAfter < time.Minute {
			wait = ae.RetryAfter
		}
		slog.Warn("[AI] Agent 1 rate limited on every key; retrying", "node_id", nodeID, "wait", wait.String())
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
	if err != nil {
		slog.Warn("[AI] Agent 1 failed", "node_id", nodeID, "err", err)
		_, _ = a.db.Exec(ctx, `UPDATE pages SET analysis_status='failed' WHERE id=$1`, pageID)
		p.stage(ctx, nodeID, "failed", ", status='active'")
		msg := "AI unavailable · page saved, analysis failed after all retries"
		if d, ok := p.scheduleRetry(nodeID); ok {
			msg = "AI unavailable · page saved, retrying in " + d.String()
		}
		p.job(wsID, "analyze_page", "failed", msg, nid, 1)
		p.a.logEvent(ctx, wsID, nil, "analysis_failed", gin.H{"node_id": nodeID, "page_id": pageID})
		return
	}
	slog.Info("[AI] Agent 1 completed", "node_id", nodeID, "is_research", u.IsResearch, "page_type", u.PageType, "topics", len(u.Topics), "claims", len(u.Claims), "fallback", u.Fallback)
	if len(u.Embedding) > 0 {
		slog.Info("[GO] embedding generated", "node_id", nodeID, "dims", len(u.Embedding))
	}
	if len(u.FetchedText) > len(content) { // the agent read the full page (no text, or only a snippet, was sent)
		_, _ = a.db.Exec(ctx, `UPDATE pages SET content_text=$2, word_count=$3 WHERE id=$1`, pageID, truncateRunes(u.FetchedText, 20000), len(strings.Fields(u.FetchedText)))
	}
	// Sources added by URL only (MCP add_source) start titled with the bare domain; use the real page title.
	if t := strings.TrimSpace(u.FetchedTitle); t != "" && title == domain {
		title = truncateRunes(t, 500)
		_, _ = a.db.Exec(ctx, `UPDATE pages SET title=$2 WHERE id=$1`, pageID, title)
		_, _ = a.db.Exec(ctx, `UPDATE nodes SET title=$2 WHERE id=$1 AND title=$3`, nodeID, title, domain)
	}
	topics, _ := json.Marshal(nonNil(u.Topics))
	qa, _ := json.Marshal(nonNil(u.QuestionsAnswered))
	status := "done"
	if u.Fallback {
		status = "failed"
	}
	if _, err := a.db.Exec(ctx, `UPDATE pages SET analysis_status=$2, is_research=$3, is_research_reason=$4, page_type=$5, main_concept=$6,
		summary=$7, topics=$8, questions_answered=$9, embedding=$10::vector WHERE id=$1`,
		pageID, status, u.IsResearch, u.IsResearchReason, u.PageType, u.MainConcept, u.Summary, topics, qa, vec(u.Embedding)); err != nil {
		slog.Error("save analysis", "err", err)
	}
	_, _ = a.db.Exec(ctx, `DELETE FROM claims WHERE page_id=$1`, pageID)
	for _, cl := range u.Claims {
		_, _ = a.db.Exec(ctx, `INSERT INTO claims (page_id,text,quote,embedding) VALUES ($1,$2,$3,$4::vector)`, pageID, cl.Text, cl.Quote, vec(cl.Embedding))
	}
	if pg, err := a.loadPage(ctx, pageID); err == nil {
		a.publish(wsID, "page.analyzed", nil, pg)
	}
	p.stage(ctx, nodeID, "understood", "")
	msg := "Agent 1 · Understood: " + u.MainConcept
	if u.Fallback {
		msg = "Agent 1 · AI unavailable, saved basic details only"
	}
	p.job(wsID, "analyze_page", "done", msg, nid, 1)

	if !u.IsResearch && !u.Fallback {
		// A page the goal check found part of the goal is research, whatever kind of page it is (for example a pricing page).
		var onGoal bool
		_ = a.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM goal_checks g JOIN pages p ON p.url_normalized=g.url_normalized
			JOIN sessions s ON s.id=g.session_id AND s.workspace_id=p.workspace_id WHERE p.id=$1 AND g.on_goal)`, pageID).Scan(&onGoal)
		if onGoal {
			u.IsResearch = true
			_, _ = a.db.Exec(ctx, `UPDATE pages SET is_research=true WHERE id=$1`, pageID)
		}
	}
	if !u.IsResearch && !u.Fallback {
		p.memory(ctx, wsID, nodeID, pageID, u, 0, "")
		p.stage(ctx, nodeID, "ready", ", status='inbox'")
		p.job(wsID, "analyze_page", "done", "Moved “"+title+"” to Inbox (not research)", nid, 1)
		return
	}

	// Agent 2 — relationships + placement.
	p.stage(ctx, nodeID, "organizing", "")
	p.job(wsID, "place_page", "running", "Agent 2 · Finding relationships…", nid, 2)
	created, topicName := p.connect(ctx, wsID, nodeID, pageID, u, whyRaw)
	if topicName != "" {
		topicName = p.placeInTopic(ctx, wsID, nodeID, topicName)
		if name := p.nameTopic(ctx, wsID, nodeID); name != "" {
			topicName = name
		}
	}
	p.stage(ctx, nodeID, "connected", "")
	place := ""
	if topicName != "" {
		place = " · placed in “" + topicName + "”"
	}
	slog.Info("[GO] edges persisted", "node_id", nodeID, "count", created, "topic", topicName)
	p.job(wsID, "place_page", "done", fmt.Sprintf("Agent 2 · %d connection(s) found%s", created, place), nid, 2)

	// Agent 3 — deterministic metadata + research memory (no AI).
	p.job(wsID, "metadata", "running", "Agent 3 · Saving research memory…", nid, 3)
	if err := p.memory(ctx, wsID, nodeID, pageID, u, created, topicName); err != nil {
		slog.Warn("[GO] Agent 3 failed", "node_id", nodeID, "err", err)
		p.job(wsID, "metadata", "failed", "Agent 3 · Research memory not saved (page and analysis are kept)", nid, 3)
	} else {
		p.job(wsID, "metadata", "done", "Agent 3 · Research Memory updated", nid, 3)
	}
	p.mu.Lock()
	delete(p.attempts, nodeID)
	p.mu.Unlock()
	p.stage(ctx, nodeID, "ready", ", status='active'")

	// The conflict check and radar refresh do not change this node or its edges, so they run off the worker
	// slot: the next captured page starts Agent 1 → Agent 2 right away instead of queueing behind extra AI calls.
	p.extra <- struct{}{}
	go func() {
		defer func() { <-p.extra }()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		p.checkConflicts(ctx, wsID, nodeID, pageID)
		if r, err := a.computeRadar(ctx, wsID); err == nil {
			a.publish(wsID, "radar.updated", nil, r)
		}
	}()
}

// memory is Agent 3 (spec §14.4): plain Go, no AI. It ties the analysed page to its session (reference number,
// visits/time), records a research-memory event with the Agent 1 + Agent 2 results, and refreshes the node so the
// Research Memory panel (first opened, time spent, previous/next topic) reflects the final placement.
func (p *Pipeline) memory(ctx context.Context, wsID, nodeID, pageID string, u understandOut, edges int, topic string) error {
	a := p.a
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var sessionID, userID *string
	_ = tx.QueryRow(ctx, `SELECT r.session_id, r.added_by FROM session_references r WHERE r.page_id=$1 ORDER BY r.first_accessed_at DESC LIMIT 1`, pageID).
		Scan(&sessionID, &userID)
	// Visits that arrived before (or racing with) the capture are linked to this page.
	if _, err := tx.Exec(ctx, `UPDATE visits SET page_id=$1 WHERE workspace_id=$2 AND page_id IS NULL
		AND url_normalized=(SELECT url_normalized FROM pages WHERE id=$1)`, pageID, wsID); err != nil {
		return err
	}
	var visits int
	var spentMs int64
	if err := tx.QueryRow(ctx, `SELECT count(*), coalesce(sum((extract(epoch FROM ended_at-started_at)*1000)::bigint),0)::bigint
		FROM visits WHERE page_id=$1`, pageID).Scan(&visits, &spentMs); err != nil {
		return err
	}
	payload := mustJSON(gin.H{"session_id": sessionID, "node_id": nodeID, "page_id": pageID, "main_concept": u.MainConcept, "page_type": u.PageType,
		"is_research": u.IsResearch, "topics": nonNil(u.Topics), "topic_group": topic, "edges_created": edges,
		"ai_fallback": u.Fallback, "visits": visits, "time_spent_ms": spentMs})
	if _, err := tx.Exec(ctx, `INSERT INTO events (workspace_id,user_id,kind,payload) VALUES ($1,$2,'page_analyzed',$3)`,
		wsID, userID, payload); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	slog.Info("[GO] Agent 3 research memory saved", "node_id", nodeID, "session_id", sessionID, "visits", visits, "time_spent_ms", spentMs)
	// Neighbours show this page's topic (main_concept) as their previous/next topic: refresh them now it is known.
	var firstVisit *time.Time
	_ = a.db.QueryRow(ctx, `SELECT min(started_at) FROM visits WHERE page_id=$1`, pageID).Scan(&firstVisit)
	if firstVisit != nil {
		uid := ""
		if userID != nil {
			uid = *userID
		}
		a.publishJourney(ctx, wsID, uid, map[string]time.Time{pageID: *firstVisit})
	}
	if sessionID != nil {
		if s, err := a.loadSession(ctx, *sessionID); err == nil {
			a.publish(wsID, "session.updated", nil, s)
		}
	}
	return nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

type candidate struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Title      string   `json:"title"`
	Summary    string   `json:"summary"`
	Topics     []string `json:"topics"`
	Similarity float64  `json:"similarity"`
	IsOpener   bool     `json:"is_opener"`
	Linked     bool     `json:"linked"`
	IsPrevious bool     `json:"is_previous"` // researched right before this page in the same session (time order only)
}

type placeOut struct {
	Edges []struct {
		CandidateID string   `json:"candidate_id"`
		Relation    string   `json:"relation"`
		Direction   string   `json:"direction"`
		Reason      string   `json:"reason"`
		Evidence    []string `json:"evidence"`
		Confidence  float64  `json:"confidence"`
	} `json:"edges"`
	TopicName string `json:"topic_name"`
	Fallback  bool   `json:"fallback"`
}

// connect finds candidates (pgvector + navigation + links + questions), asks Agent 2 to explain relationships,
// validates them and stores at most 3 AI edges. Returns the number of edges created and the chosen topic name.
func (p *Pipeline) connect(ctx context.Context, wsID, nodeID, pageID string, u understandOut, whyRaw []byte) (int, string) {
	a := p.a
	var why struct {
		OpenerNodeID *string `json:"opener_node_id"`
	}
	_ = json.Unmarshal(whyRaw, &why)
	var branch string
	_ = a.db.QueryRow(ctx, `SELECT branch_id FROM nodes WHERE id=$1`, nodeID).Scan(&branch)

	cands := map[string]*candidate{}
	rows, err := a.db.Query(ctx, `SELECT n.id, n.type, n.title, coalesce(p.summary,''), p.topics, 1 - (p.embedding <=> (SELECT embedding FROM pages WHERE id=$2))
		FROM pages p JOIN nodes n ON n.page_id=p.id AND n.deleted_at IS NULL
		WHERE p.workspace_id=$1 AND p.id<>$2 AND p.embedding IS NOT NULL AND (SELECT embedding FROM pages WHERE id=$2) IS NOT NULL
		AND n.status<>'inbox' ORDER BY p.embedding <=> (SELECT embedding FROM pages WHERE id=$2) LIMIT 6`, wsID, pageID)
	if err == nil {
		for rows.Next() {
			var c candidate
			if rows.Scan(&c.ID, &c.Type, &c.Title, &c.Summary, &c.Topics, &c.Similarity) == nil && c.Similarity >= 0.5 {
				cands[c.ID] = &c
			}
		}
		rows.Close()
	}
	// Research context: the page captured right before this one in the same tracking session. Time order alone is
	// not a relationship, so it is only offered to Agent 2 (scored on content, no structure bonus), never auto-linked.
	var prev candidate
	if a.db.QueryRow(ctx, `WITH me AS (SELECT session_id, first_accessed_at FROM session_references WHERE page_id=$3 ORDER BY first_accessed_at DESC LIMIT 1)
		SELECT n.id, n.type, n.title, coalesce(p.summary,''), coalesce(p.topics,'[]'::jsonb),
			coalesce(1 - (p.embedding <=> (SELECT embedding FROM pages WHERE id=$3)), 0)
		FROM me JOIN session_references r ON r.session_id=me.session_id AND r.first_accessed_at < me.first_accessed_at
		JOIN pages p ON p.id=r.page_id JOIN nodes n ON n.page_id=p.id AND n.type='page' AND n.deleted_at IS NULL AND n.status<>'inbox'
		WHERE n.workspace_id=$1 AND n.id<>$2 ORDER BY r.first_accessed_at DESC LIMIT 1`, wsID, nodeID, pageID).
		Scan(&prev.ID, &prev.Type, &prev.Title, &prev.Summary, &prev.Topics, &prev.Similarity) == nil {
		if ex, ok := cands[prev.ID]; ok {
			ex.IsPrevious = true
		} else {
			prev.IsPrevious = true
			cands[prev.ID] = &prev
		}
	}
	var linkedURLs []string
	_ = a.db.QueryRow(ctx, `SELECT coalesce(ARRAY(SELECT jsonb_array_elements_text(outgoing_links)), '{}') FROM pages WHERE id=$1`, pageID).Scan(&linkedURLs)
	norm := make([]string, 0, len(linkedURLs))
	for _, l := range linkedURLs {
		norm = append(norm, normalizeURL(l))
	}
	extra, _ := a.db.Query(ctx, `SELECT n.id, n.type, n.title, coalesce(p.summary,''), coalesce(p.topics,'[]'::jsonb),
		coalesce(n.id = $3, false) AS opener, coalesce(p.url_normalized = ANY($4), false) AS linked
		FROM nodes n LEFT JOIN pages p ON p.id=n.page_id WHERE n.workspace_id=$1 AND n.deleted_at IS NULL AND n.id<>$2
		AND (n.id=$3 OR p.url_normalized = ANY($4) OR (n.type='question' AND n.title ILIKE ANY(SELECT '%'||x||'%' FROM jsonb_array_elements_text($5::jsonb) x)))
		LIMIT 6`, wsID, nodeID, why.OpenerNodeID, norm, mustJSON(u.Topics))
	if extra != nil {
		for extra.Next() {
			var c candidate
			if extra.Scan(&c.ID, &c.Type, &c.Title, &c.Summary, &c.Topics, &c.IsOpener, &c.Linked) == nil {
				if ex, ok := cands[c.ID]; ok {
					ex.IsOpener, ex.Linked = c.IsOpener, c.Linked
				} else {
					cands[c.ID] = &c
				}
			}
		}
		extra.Close()
	}

	created := 0
	insertEdge := func(src, dst, rel, origin, state, reason string, evidence []string, conf float64) {
		var rejected bool
		_ = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM edges WHERE state='rejected' AND ((source_id=$1 AND target_id=$2) OR (source_id=$2 AND target_id=$1)))`, src, dst).Scan(&rejected)
		if rejected {
			return // the user rejected this pair; never suggest it again
		}
		var id string
		err := a.db.QueryRow(ctx, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,reason,evidence,confidence,origin,state)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
			wsID, branch, src, dst, rel, reason, mustJSON(nonNil(evidence)), conf, origin, state).Scan(&id)
		if err == nil {
			created++
			if e, err := a.loadEdge(ctx, id); err == nil {
				a.publish(wsID, "edge.created", nil, e)
			}
		}
	}
	// Navigation trail: deterministic, confidence 1.
	var opener *candidate
	for _, c := range cands {
		if c.IsOpener {
			opener = c
		}
		if c.Linked && !c.IsOpener {
			insertEdge(nodeID, c.ID, "links_to", "link", "accepted", "This page links to it.", []string{"Hyperlink on the page"}, 1)
		}
	}
	if opener != nil && opener.Type != "question" {
		insertEdge(opener.ID, nodeID, "opened_from", "navigation", "accepted", "Opened from this page (link click).", []string{"Navigation trail"}, 1)
	}

	var topics []string
	trows, _ := a.db.Query(ctx, `SELECT title FROM nodes WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL`, wsID)
	if trows != nil {
		for trows.Next() {
			var t string
			if trows.Scan(&t) == nil {
				topics = append(topics, t)
			}
		}
		trows.Close()
	}
	list := make([]*candidate, 0, len(cands))
	for _, c := range cands {
		list = append(list, c)
	}
	// Agent 2 reads at most 8 candidates: keep navigation/research context first, then the most similar,
	// instead of Go's random map order (which could drop the opener before the AI ever saw it).
	rank := func(c *candidate) int {
		switch {
		case c.IsOpener:
			return 0
		case c.IsPrevious:
			return 1
		case c.Linked:
			return 2
		}
		return 3
	}
	sort.SliceStable(list, func(i, j int) bool {
		if ri, rj := rank(list[i]), rank(list[j]); ri != rj {
			return ri < rj
		}
		return list[i].Similarity > list[j].Similarity
	})
	if len(list) > 8 {
		list = list[:8]
	}
	slog.Info("[GO] candidates retrieved", "node_id", nodeID, "count", len(list), "has_opener", opener != nil, "has_previous", prev.ID != "")
	slog.Info("[AI] Agent 2 started", "node_id", nodeID)
	var out placeOut
	// Retried on 429 like Agent 1: a rate limit is temporary, and the similarity-only fallback loses the explained relations.
	for attempt := 0; attempt < 3; attempt++ {
		err = a.agent.post(ctx, "/v1/place", gin.H{"page": gin.H{"title": u.MainConcept, "summary": u.Summary, "topics": u.Topics, "page_type": u.PageType},
			"candidates": list, "existing_topics": topics}, &out)
		var ae *agentError
		if err == nil || !(errors.As(err, &ae) && ae.Status == 429) {
			break
		}
		wait := time.Duration(3*(attempt+1)) * time.Second
		if ae.RetryAfter > wait && ae.RetryAfter < 30*time.Second {
			wait = ae.RetryAfter
		}
		slog.Warn("[AI] Agent 2 rate limited; retrying", "node_id", nodeID, "wait", wait.String())
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
	if err != nil {
		slog.Warn("[AI] Agent 2 failed; using similarity only", "node_id", nodeID, "err", err)
		out.Fallback = true
	} else {
		slog.Info("[AI] Agent 2 completed", "node_id", nodeID, "edges_proposed", len(out.Edges), "topic", out.TopicName, "fallback", out.Fallback)
	}
	if out.Fallback {
		// Honest fallback: similarity-only edges, clearly labelled as not explained by AI.
		for _, c := range list {
			if c.Similarity >= 0.6 && created < 3 {
				insertEdge(c.ID, nodeID, "same_topic", "embedding", "suggested", "Similar content (AI explanation not available)", nil, math.Round(c.Similarity*100)/100)
			}
		}
		if opener != nil && opener.Type == "question" {
			insertEdge(opener.ID, nodeID, "opened_from", "navigation", "accepted", "Opened from this search.", []string{"Navigation trail"}, 1)
		}
		if len(u.Topics) > 0 {
			return created, u.Topics[0]
		}
		return created, ""
	}
	type scored struct {
		src, dst, rel, reason string
		ev                    []string
		conf                  float64
	}
	var ss []scored
	for _, e := range out.Edges {
		c, ok := cands[e.CandidateID]
		if !ok || !relations[e.Relation] || e.Relation == "opened_from" || e.Relation == "links_to" || strings.TrimSpace(e.Reason) == "" {
			continue // never accept edges to nodes we did not offer, or unknown relation types
		}
		structure := 0.0
		if c.IsOpener || c.Linked {
			structure = 1
		}
		conf := 0.6*clamp(e.Confidence) + 0.3*clamp(c.Similarity) + 0.1*structure
		if c.Similarity == 0 && c.Type == "question" && c.IsOpener {
			conf = 0.6*clamp(e.Confidence) + 0.3*0.7 + 0.1
		}
		conf = math.Round(conf*100) / 100
		if conf < 0.5 {
			continue
		}
		src, dst := c.ID, nodeID
		if e.Direction == "new_to_candidate" {
			src, dst = nodeID, c.ID
		}
		if e.Relation == "answers" && c.Type == "question" {
			src, dst = c.ID, nodeID
		}
		ss = append(ss, scored{src, dst, e.Relation, e.Reason, e.Evidence, conf})
	}
	sort.Slice(ss, func(i, j int) bool { return ss[i].conf > ss[j].conf })
	aiCount := 0
	for _, s := range ss {
		if aiCount == 3 {
			break
		}
		before := created
		insertEdge(s.src, s.dst, s.rel, "ai", "suggested", s.reason, s.ev, s.conf)
		if created > before {
			aiCount++
		}
	}
	if opener != nil && opener.Type == "question" && aiCount == 0 {
		insertEdge(opener.ID, nodeID, "opened_from", "navigation", "accepted", "Opened from this search.", []string{"Navigation trail"}, 1)
	}
	return created, strings.TrimSpace(out.TopicName)
}

func clamp(f float64) float64 { return math.Max(0, math.Min(1, f)) }

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

var topicColors = []string{"#7b5cf0", "#f08a6c", "#2f6fbf", "#3f8a2e", "#c9544f", "#a86f00", "#0f9d8a"}

// placeInTopic moves the node into the named topic group (creating it if needed), unless the user locked its group.
func (p *Pipeline) placeInTopic(ctx context.Context, wsID, nodeID, topicName string) string {
	p.placeMu.Lock()
	defer p.placeMu.Unlock()
	a := p.a
	topicName = truncateRunes(topicName, 60)
	var locked bool
	var parent *string
	var branch string
	if a.db.QueryRow(ctx, `SELECT group_locked, parent_id, branch_id FROM nodes WHERE id=$1`, nodeID).Scan(&locked, &parent, &branch) != nil || locked || parent != nil {
		return "" // the user (or an earlier run) already decided the group
	}
	var topicID string
	// Spec §14.5: a new node goes next to its strongest connected node. If that node is already in a topic,
	// join it instead of opening a second group under a differently worded AI name.
	_ = a.db.QueryRow(ctx, `SELECT o.parent_id FROM edges e
		JOIN nodes o ON o.id = CASE WHEN e.source_id=$1 THEN e.target_id ELSE e.source_id END
		JOIN nodes t ON t.id=o.parent_id AND t.type='topic' AND t.deleted_at IS NULL
		WHERE (e.source_id=$1 OR e.target_id=$1) AND e.state<>'rejected' AND e.confidence>=0.7 AND o.deleted_at IS NULL
		ORDER BY e.confidence DESC LIMIT 1`, nodeID).Scan(&topicID)
	if topicID == "" {
		_ = a.db.QueryRow(ctx, `SELECT id FROM nodes WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL AND lower(title)=lower($2) LIMIT 1`, wsID, topicName).Scan(&topicID)
	}
	if topicID == "" {
		var maxX *float64
		var n int
		_ = a.db.QueryRow(ctx, `SELECT max(x + coalesce(width,300)), (SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='topic')
			FROM nodes WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL AND id<>$2`, wsID, nodeID).Scan(&maxX, &n)
		x := 0.0
		if maxX != nil {
			x = *maxX + 80
		}
		if err := a.db.QueryRow(ctx, `INSERT INTO nodes (workspace_id,branch_id,type,title,body,x,y,width,height,created_via,ai_stage)
			VALUES ($1,$2,'topic',$3,$4,$5,0,600,320,'ai','ready') RETURNING id`, wsID, branch, topicName, topicColors[n%len(topicColors)], x).Scan(&topicID); err != nil {
			return ""
		}
		a.publishNode(ctx, "node.created", topicID, nil)
	}
	if _, err := a.db.Exec(ctx, `UPDATE nodes SET parent_id=$2, version=version+1, updated_at=now() WHERE id=$1`, nodeID, topicID); err != nil {
		return ""
	}
	for _, id := range a.packTopic(ctx, topicID) {
		a.publishNode(ctx, "node.updated", id, nil)
	}
	var title string
	_ = a.db.QueryRow(ctx, `SELECT title FROM nodes WHERE id=$1`, topicID).Scan(&title)
	return title
}

// nameTopic names the page's AI cluster from all of its pages (the first page alone often gave a narrow name,
// such as "Jenkins elections"). Clusters the user created are never renamed. Returns the new name, or "".
func (p *Pipeline) nameTopic(ctx context.Context, wsID, nodeID string) string {
	a := p.a
	var topicID string
	if a.db.QueryRow(ctx, `SELECT t.id FROM nodes n JOIN nodes t ON t.id=n.parent_id AND t.type='topic' AND t.created_via='ai'
		WHERE n.id=$1`, nodeID).Scan(&topicID) != nil {
		return ""
	}
	rows, err := a.db.Query(ctx, `SELECT n.title, coalesce(pg.summary,'') FROM nodes n LEFT JOIN pages pg ON pg.id=n.page_id
		WHERE n.parent_id=$1 AND n.deleted_at IS NULL ORDER BY n.created_at LIMIT 12`, topicID)
	if err != nil {
		return ""
	}
	pages := []gin.H{}
	for rows.Next() {
		var title, summary string
		if rows.Scan(&title, &summary) == nil {
			pages = append(pages, gin.H{"title": title, "summary": summary})
		}
	}
	rows.Close()
	var goal string
	_ = a.db.QueryRow(ctx, `SELECT coalesce(goal,'') FROM sessions WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 1`, wsID).Scan(&goal)
	var out struct {
		Name string `json:"name"`
	}
	if a.agent.post(ctx, "/v1/topic_name", gin.H{"pages": pages, "goal": goal}, &out) != nil || strings.TrimSpace(out.Name) == "" {
		return ""
	}
	name := truncateRunes(strings.TrimSpace(out.Name), 60)
	if tag, err := a.db.Exec(ctx, `UPDATE nodes SET title=$2, version=version+1, updated_at=now() WHERE id=$1 AND title<>$2`, topicID, name); err == nil && tag.RowsAffected() > 0 {
		a.publishNode(ctx, "node.updated", topicID, nil)
	}
	return name
}

// packTopic lays children of a topic in a grid (same constants as frontend/lib/graph/layout.ts packTopic),
// skipping children whose position the user locked. Returns ids of changed nodes (topic included).
func (a *App) packTopic(ctx context.Context, topicID string) []string {
	rows, err := a.db.Query(ctx, `SELECT id, type, position_locked FROM nodes WHERE parent_id=$1 AND deleted_at IS NULL ORDER BY created_at`, topicID)
	if err != nil {
		return nil
	}
	type ch struct {
		id, typ string
		locked  bool
	}
	var cs []ch
	for rows.Next() {
		var c ch
		if rows.Scan(&c.id, &c.typ, &c.locked) == nil {
			cs = append(cs, c)
		}
	}
	rows.Close()
	sizes := map[string][2]float64{"page": {300, 230}, "question": {248, 118}, "note": {236, 150}, "finding": {252, 146}}
	n := len(cs)
	cols := 3
	if n <= 1 {
		cols = 1
	} else if n <= 4 {
		cols = 2
	}
	const gap, top, side, bottom = 24.0, 64.0, 24.0, 24.0
	cellW := 300 + gap
	rowH := map[int]float64{}
	for i, c := range cs {
		r := i / cols
		rowH[r] = math.Max(rowH[r], sizes[c.typ][1])
	}
	changed := []string{}
	y := top
	for r := 0; r*cols < n; r++ {
		for col := 0; col < cols && r*cols+col < n; col++ {
			c := cs[r*cols+col]
			if !c.locked {
				_, _ = a.db.Exec(ctx, `UPDATE nodes SET x=$2, y=$3, version=version+1 WHERE id=$1`, c.id, side+float64(col)*cellW, y)
				changed = append(changed, c.id)
			}
		}
		y += rowH[r] + gap
	}
	w := math.Max(280, side*2+float64(min(n, cols))*cellW-gap)
	h := math.Max(160, y-gap+bottom)
	_, _ = a.db.Exec(ctx, `UPDATE nodes SET width=$2, height=$3, version=version+1 WHERE id=$1`, topicID, w, h)
	return append(changed, topicID)
}

/* ---------------------------------------------------------------- conflicts */

func (p *Pipeline) checkConflicts(ctx context.Context, wsID, nodeID, pageID string) {
	a := p.a
	rows, err := a.db.Query(ctx, `SELECT c1.text, c1.quote, c2.text, c2.quote, n2.id, p2.title, p2.url, p1.title, p1.url
		FROM claims c1 JOIN pages p1 ON p1.id=c1.page_id
		JOIN LATERAL (SELECT c2.* FROM claims c2 JOIN pages px ON px.id=c2.page_id
		   WHERE px.workspace_id=$1 AND c2.page_id<>c1.page_id AND c2.embedding IS NOT NULL AND c1.embedding IS NOT NULL
		   AND 1-(c2.embedding <=> c1.embedding) >= 0.72 ORDER BY c2.embedding <=> c1.embedding LIMIT 2) c2 ON true
		JOIN pages p2 ON p2.id=c2.page_id JOIN nodes n2 ON n2.page_id=p2.id AND n2.deleted_at IS NULL
		WHERE c1.page_id=$2 LIMIT 8`, wsID, pageID)
	if err != nil {
		return
	}
	type pair struct{ aText, aQuote, bText, bQuote, otherNode, bTitle, bURL, aTitle, aURL string }
	var pairs []pair
	for rows.Next() {
		var x pair
		if rows.Scan(&x.aText, &x.aQuote, &x.bText, &x.bQuote, &x.otherNode, &x.bTitle, &x.bURL, &x.aTitle, &x.aURL) == nil {
			pairs = append(pairs, x)
		}
	}
	rows.Close()
	if len(pairs) == 0 {
		return
	}
	in := []gin.H{}
	for _, x := range pairs {
		in = append(in, gin.H{"a": gin.H{"claim": x.bText, "quote": x.bQuote, "title": x.bTitle}, "b": gin.H{"claim": x.aText, "quote": x.aQuote, "title": x.aTitle}})
	}
	p.job(wsID, "check_conflicts", "running", "Checking claims for conflicts…", &nodeID, 2)
	var out struct {
		Results []struct {
			Index          int      `json:"index"`
			Label          string   `json:"label"`
			Topic          string   `json:"topic"`
			KeyDifferences []string `json:"key_differences"`
			PossibleReason []string `json:"possible_reasons"`
			Context        string   `json:"context"`
			HowToEvaluate  []string `json:"how_to_evaluate"`
			Confidence     float64  `json:"confidence"`
		} `json:"results"`
	}
	if err := a.agent.post(ctx, "/v1/conflicts/check", gin.H{"pairs": in}, &out); err != nil {
		p.job(wsID, "check_conflicts", "failed", "Conflict check skipped (AI unavailable)", &nodeID, 2)
		return
	}
	found := 0
	for _, r := range out.Results {
		if r.Index < 0 || r.Index >= len(pairs) || r.Confidence < 0.6 {
			continue
		}
		// Only real disagreements reach Conflict Radar; "different context" pairs do not disagree.
		if r.Label != "contradict" && r.Label != "partially_contradict" {
			continue
		}
		x := pairs[r.Index]
		// Both pages run this check, so the pair arrives once in each order; one conflict per pair.
		var dup bool
		_ = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conflicts WHERE (node_a_id=$1 AND node_b_id=$2) OR (node_a_id=$2 AND node_b_id=$1))`,
			x.otherNode, nodeID).Scan(&dup)
		if dup {
			continue
		}
		var addedA, addedB string
		_ = a.db.QueryRow(ctx, `SELECT coalesce((SELECT CASE WHEN created_via='mcp' THEN 'AI assistant ('||coalesce(n.client_name,'MCP')||')' ELSE u.name END FROM nodes n LEFT JOIN users u ON u.id=n.created_by WHERE n.id=$1),'Unknown'),
			coalesce((SELECT CASE WHEN created_via='mcp' THEN 'AI assistant ('||coalesce(n.client_name,'MCP')||')' ELSE u.name END FROM nodes n LEFT JOIN users u ON u.id=n.created_by WHERE n.id=$2),'Unknown')`,
			x.otherNode, nodeID).Scan(&addedA, &addedB)
		analysis := gin.H{"topic": r.Topic, "label": r.Label, "confidence": r.Confidence,
			"claims": []gin.H{
				{"node_id": x.otherNode, "added_by": addedA, "claim": x.bText, "quote": x.bQuote, "ref": nil, "title": x.bTitle, "url": x.bURL, "fragment_url": textFragmentURL(x.bURL, x.bQuote)},
				{"node_id": nodeID, "added_by": addedB, "claim": x.aText, "quote": x.aQuote, "ref": nil, "title": x.aTitle, "url": x.aURL, "fragment_url": textFragmentURL(x.aURL, x.aQuote)},
			},
			"key_differences": nonNil(r.KeyDifferences), "possible_reasons": nonNil(r.PossibleReason), "context": r.Context, "how_to_evaluate": nonNil(r.HowToEvaluate)}
		var cid string
		if err := a.db.QueryRow(ctx, `INSERT INTO conflicts (workspace_id,node_a_id,node_b_id,label,analysis,confidence) VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (node_a_id,node_b_id) DO NOTHING RETURNING id`, wsID, x.otherNode, nodeID, r.Label, mustJSON(analysis), r.Confidence).Scan(&cid); err != nil {
			continue
		}
		found++
		var branch string
		_ = a.db.QueryRow(ctx, `SELECT branch_id FROM nodes WHERE id=$1`, nodeID).Scan(&branch)
		var eid string
		// Only create a contradicts edge for actual contradictions; different_context is not a contradiction.
		// Agent 2 may already have drawn a contradicts edge for this pair (either direction); never add a second one.
		if r.Label == "contradict" || r.Label == "partially_contradict" {
			if a.db.QueryRow(ctx, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,reason,evidence,confidence,origin,state)
				SELECT $1,$2,$3,$4,'contradicts',$5,$6,$7,'ai','suggested'
				WHERE NOT EXISTS (SELECT 1 FROM edges WHERE relation='contradicts' AND ((source_id=$3 AND target_id=$4) OR (source_id=$4 AND target_id=$3)))
				ON CONFLICT DO NOTHING RETURNING id`,
				wsID, branch, x.otherNode, nodeID, "The sources make claims that seem to disagree: "+r.Topic, mustJSON(nonNil(r.KeyDifferences)), r.Confidence).Scan(&eid) == nil {
				if e, err := a.loadEdge(ctx, eid); err == nil {
					a.publish(wsID, "edge.created", nil, e)
				}
			}
		}
		if cs, err := a.conflictsWhere(ctx, "WHERE id=$1", cid); err == nil && len(cs) == 1 {
			a.publish(wsID, "conflict.detected", nil, cs[0])
		}
	}
	p.job(wsID, "check_conflicts", "done", fmt.Sprintf("Conflict check done · %d potential conflict(s)", found), &nodeID, 2)
}

type Conflict struct {
	ID             string          `json:"id" db:"id"`
	WorkspaceID    string          `json:"workspace_id" db:"workspace_id"`
	NodeAID        string          `json:"node_a_id" db:"node_a_id"`
	NodeBID        string          `json:"node_b_id" db:"node_b_id"`
	Label          string          `json:"label" db:"label"`
	Analysis       json.RawMessage `json:"analysis" db:"analysis"`
	Confidence     float32         `json:"confidence" db:"confidence"`
	Status         string          `json:"status" db:"status"`
	ResolutionNote *string         `json:"resolution_note" db:"resolution_note"`
	ResolvedBy     *string         `json:"resolved_by" db:"resolved_by"`
	CrossBranch    bool            `json:"cross_branch" db:"cross_branch"`
	CreatedAt      time.Time       `json:"created_at" db:"created_at"`
}

func (a *App) conflictsWhere(ctx context.Context, where string, args ...any) ([]Conflict, error) {
	return collect[Conflict](ctx, a.db, `SELECT c.id,c.workspace_id,c.node_a_id,c.node_b_id,c.label,c.analysis,c.confidence,c.status,c.resolution_note,
		c.resolved_by, coalesce((SELECT na.branch_id<>nb.branch_id FROM nodes na, nodes nb WHERE na.id=c.node_a_id AND nb.id=c.node_b_id), false) AS cross_branch,
		c.created_at FROM (SELECT * FROM conflicts `+where+`) c ORDER BY c.created_at DESC`, args...)
}

func (a *App) listConflicts(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	cs, err := a.conflictsWhere(c, "WHERE workspace_id=$1", c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, cs)
	return nil
}

func (a *App) updateConflict(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "conflicts", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		Status         string  `json:"status"`
		ResolutionNote *string `json:"resolution_note"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	switch b.Status {
	case "open", "kept_both", "resolved", "dismissed":
	default:
		return httpx400("Invalid status")
	}
	u := currentUser(c)
	if _, err := a.db.Exec(c, `UPDATE conflicts SET status=$2, resolution_note=coalesce($3,resolution_note), resolved_by=$4 WHERE id=$1`, id, b.Status, b.ResolutionNote, u.ID); err != nil {
		return err
	}
	cs, err := a.conflictsWhere(c, "WHERE id=$1", id)
	if err != nil || len(cs) == 0 {
		return err
	}
	a.logEvent(c, wsID, &u.ID, "conflict_"+b.Status, gin.H{"conflict_id": id})
	a.publish(wsID, "conflict.updated", &u.ID, cs[0])
	c.JSON(200, cs[0])
	return nil
}

func (a *App) methodology(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "conflicts", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	cs, err := a.conflictsWhere(c, "WHERE id=$1", id)
	if err != nil || len(cs) == 0 {
		return err
	}
	var out struct {
		Checklist []gin.H `json:"checklist"`
	}
	if err := a.agent.post(c, "/v1/conflicts/methodology", gin.H{"analysis": cs[0].Analysis}, &out); err != nil {
		return aiUnavailable()
	}
	c.JSON(200, gin.H{"conflict_id": id, "checklist": out.Checklist})
	return nil
}

/* ---------------------------------------------------------------- report builder */

var citeRe = regexp.MustCompile(`\[(\d+)\]`)
var multiCiteRe = regexp.MustCompile(`\[\d+(?:\s*,\s*\d+)+\]`)

// maxReportSources is how many pages the AI reads when it writes the report: the ones the person spent most time on.
const maxReportSources = 12

func (a *App) buildReport(ctx context.Context, s *Session) {
	fail := func(err error) {
		slog.Warn("report failed", "session_id", s.ID, "err", err)
		_, _ = a.db.Exec(ctx, `UPDATE reports SET status='failed' WHERE session_id=$1`, s.ID)
		a.publish(s.WorkspaceID, "job.status", nil, gin.H{"kind": "report", "status": "failed", "message": "AI unavailable — statistics still work"})
	}
	stats, err := a.computeStats(ctx, s)
	if err != nil {
		fail(err)
		return
	}
	refs, err := a.references(ctx, s.ID)
	if err != nil {
		fail(err)
		return
	}
	valid := map[int]bool{}
	refByNode := map[string]int{}
	byPage := map[string]Reference{}
	for _, r := range refs {
		valid[r.RefNumber] = true
		byPage[r.PageID] = r
		if r.NodeID != nil {
			refByNode[*r.NodeID] = r.RefNumber
		}
	}
	// The pages the person spent most time on first, then the other sources of the session, with what each page says.
	type pick struct {
		ref     Reference
		minutes int64
	}
	picks, seen := []pick{}, map[string]bool{}
	for _, p := range stats["time_per_page"].([]gin.H) {
		if id, _ := p["page_id"].(*string); id != nil {
			if r, ok := byPage[*id]; ok && !seen[*id] {
				seen[*id] = true
				picks = append(picks, pick{r, p["ms"].(int64) / 60000})
			}
		}
	}
	for _, r := range refs {
		if !seen[r.PageID] {
			seen[r.PageID] = true
			picks = append(picks, pick{r, 0})
		}
	}
	sources := []gin.H{}
	for _, pk := range picks {
		if len(sources) == maxReportSources {
			break
		}
		r := pk.ref
		var summary string
		_ = a.db.QueryRow(ctx, `SELECT coalesce(summary,'') FROM pages WHERE id=$1`, r.PageID).Scan(&summary)
		points := []string{}
		if rows, err := a.db.Query(ctx, `SELECT text FROM claims WHERE page_id=$1 LIMIT 3`, r.PageID); err == nil {
			for rows.Next() {
				var t string
				if rows.Scan(&t) == nil {
					points = append(points, truncateRunes(t, 200))
				}
			}
			rows.Close()
		}
		sources = append(sources, gin.H{"ref": r.RefNumber, "title": truncateRunes(r.Title, 120), "site": r.Domain,
			"minutes": pk.minutes, "summary": truncateRunes(summary, 500), "key_points": points})
	}
	// Findings the person wrote themselves, with the pages that support them.
	findings := []gin.H{}
	if frows, err := a.db.Query(ctx, `SELECT n.id, n.title FROM nodes n WHERE n.workspace_id=$1 AND n.type='finding' AND n.deleted_at IS NULL`, s.WorkspaceID); err == nil {
		type fnd struct{ id, title string }
		var fs []fnd
		for frows.Next() {
			var f fnd
			if frows.Scan(&f.id, &f.title) == nil {
				fs = append(fs, f)
			}
		}
		frows.Close()
		for _, f := range fs {
			refsF := []int{}
			if er, err := a.db.Query(ctx, `SELECT source_id FROM edges WHERE target_id=$1 AND relation='supports'`, f.id); err == nil {
				for er.Next() {
					var sid string
					if er.Scan(&sid) == nil && refByNode[sid] > 0 {
						refsF = append(refsF, refByNode[sid])
					}
				}
				er.Close()
			}
			findings = append(findings, gin.H{"text": f.title, "refs": refsF, "ai_generated": false})
		}
	}
	var wsTitle string
	_ = a.db.QueryRow(ctx, `SELECT title FROM workspaces WHERE id=$1`, s.WorkspaceID).Scan(&wsTitle)

	var out struct {
		Summary   string `json:"summary"`
		KeyPoints []struct {
			Text string `json:"text"`
			Refs []int  `json:"refs"`
		} `json:"key_points"`
	}
	input := gin.H{"workspace_title": wsTitle, "goal": goalText(s), "sources": sources, "own_findings": findings,
		"active_minutes": stats["active_ms"].(int64) / 60000, "total_minutes": stats["total_duration_ms"].(int64) / 60000}
	if s.GoalOnMs+s.GoalOffMs > 0 { // say nothing about goal time when none was measured
		input["goal_minutes_on"], input["goal_minutes_off"] = s.GoalOnMs/60000, s.GoalOffMs/60000
	}
	err = a.agent.post(ctx, "/v1/report", input, &out)
	if err != nil {
		fail(err)
		return
	}
	// "[1, 2]" becomes "[1][2]" so each citation links to its source; citations to unknown references are removed.
	summary := multiCiteRe.ReplaceAllStringFunc(out.Summary, func(m string) string {
		return "[" + strings.Join(strings.FieldsFunc(m[1:len(m)-1], func(r rune) bool { return r == ',' || r == ' ' }), "][") + "]"
	})
	summary = citeRe.ReplaceAllStringFunc(summary, func(m string) string {
		n, _ := strconv.Atoi(m[1 : len(m)-1])
		if valid[n] {
			return m
		}
		return ""
	})
	for _, kp := range out.KeyPoints {
		rs := []int{}
		for _, r := range kp.Refs {
			if valid[r] {
				rs = append(rs, r)
			}
		}
		if len(rs) > 0 {
			findings = append(findings, gin.H{"text": kp.Text, "refs": rs, "ai_generated": true})
		}
	}
	content := gin.H{"summary": strings.TrimSpace(summary), "key_findings": findings}
	if _, err := a.db.Exec(ctx, `UPDATE reports SET status='ready', content=$2 WHERE session_id=$1`, s.ID, mustJSON(content)); err != nil {
		fail(err)
		return
	}
	a.publish(s.WorkspaceID, "job.status", nil, gin.H{"kind": "report", "status": "done", "message": "Session report ready"})
}
