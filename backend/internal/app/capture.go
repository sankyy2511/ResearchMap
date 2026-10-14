package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

/* ---------------------------------------------------------------- sessions */

func (a *App) requireSession(c *gin.Context, id, role string) (*Session, error) {
	s, err := a.loadSession(c, id)
	if err != nil {
		return nil, httpx.NotFound("Session")
	}
	if _, err := a.requireWS(c, s.WorkspaceID, role); err != nil {
		return nil, err
	}
	return s, nil
}

func (a *App) startSession(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	u := currentUser(c)
	var b struct {
		Goal *string `json:"goal"` // optional; nil keeps the goal of an already running session
	}
	_ = c.ShouldBindJSON(&b)
	ss, err := collect[Session](c, a.db, sessionSelect+"WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.state<>'stopped'"+humanSession, wsID, u.ID)
	if err != nil {
		return err
	}
	if len(ss) > 0 {
		return a.respondSession(c, &ss[0], b.Goal, 200)
	}
	branch, err := a.writeBranch(c, wsID, u.ID)
	if err != nil {
		return err
	}
	var id string
	err = a.db.QueryRow(c, `INSERT INTO sessions (workspace_id,user_id,branch_id,title)
		VALUES ($1,$2,$3,'Research on ' || to_char(now(), 'FMDD Mon')) RETURNING id`, wsID, u.ID, branch).Scan(&id)
	if isUnique(err) { // a parallel request already started one
		ss, _ = collect[Session](c, a.db, sessionSelect+"WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.state<>'stopped'"+humanSession, wsID, u.ID)
		if len(ss) > 0 {
			return a.respondSession(c, &ss[0], b.Goal, 200)
		}
	}
	if err != nil {
		return err
	}
	s, err := a.loadSession(c, id)
	if err != nil {
		return err
	}
	a.logEvent(c, wsID, &u.ID, "session_started", gin.H{"session_id": id})
	return a.respondSession(c, s, b.Goal, 201)
}

// respondSession applies an optional goal to the session, then sends and broadcasts its latest state.
func (a *App) respondSession(c *gin.Context, s *Session, goal *string, status int) error {
	u := currentUser(c)
	if goal != nil {
		if err := a.setGoal(c, s, *goal, &u.ID); err != nil {
			return err
		}
		var err error
		if s, err = a.loadSession(c, s.ID); err != nil {
			return err
		}
	}
	a.publish(s.WorkspaceID, "session.updated", &u.ID, s)
	c.JSON(status, s)
	return nil
}

func (a *App) sessionTransition(c *gin.Context, sql string, args ...any) error {
	s, err := a.requireSession(c, c.Param("id"), "editor")
	if err != nil {
		return err
	}
	if _, err := a.db.Exec(c, sql, append([]any{s.ID}, args...)...); err != nil {
		return err
	}
	s, err = a.loadSession(c, s.ID)
	if err != nil {
		return err
	}
	a.publish(s.WorkspaceID, "session.updated", &currentUser(c).ID, s)
	c.JSON(200, s)
	return nil
}

func (a *App) stopSession(c *gin.Context) error {
	var b struct {
		OpenTabs []string `json:"open_tabs"`
	}
	_ = c.ShouldBindJSON(&b)
	if b.OpenTabs == nil {
		b.OpenTabs = []string{}
	}
	tabs, _ := json.Marshal(b.OpenTabs)
	return a.sessionTransition(c, `UPDATE sessions SET
		paused_ms = paused_ms + CASE WHEN state='paused' AND paused_at IS NOT NULL THEN (extract(epoch FROM now()-paused_at)*1000)::bigint ELSE 0 END,
		state='stopped', paused_at=NULL, ended_at=coalesce(ended_at, now()), open_tabs=$2 WHERE id=$1 AND state<>'stopped'`, tabs)
}

func (a *App) pauseSession(c *gin.Context) error {
	return a.sessionTransition(c, `UPDATE sessions SET state='paused', paused_at=now() WHERE id=$1 AND state='active'`)
}

func (a *App) resumeSession(c *gin.Context) error {
	return a.sessionTransition(c, `UPDATE sessions SET paused_ms = paused_ms + (extract(epoch FROM now()-coalesce(paused_at,now()))*1000)::bigint,
		paused_at=NULL, state='active' WHERE id=$1 AND state='paused'`)
}

func (a *App) listSessions(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	ss, err := collect[Session](c, a.db, sessionSelect+"WHERE s.workspace_id=$1 ORDER BY s.started_at DESC", c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, ss)
	return nil
}

// extensionState tells the extension which session (if any) this user is tracking, so it can resume after a restart.
func (a *App) extensionState(c *gin.Context) error {
	u := currentUser(c)
	ss, err := collect[Session](c, a.db, sessionSelect+"WHERE s.user_id=$1 AND s.state<>'stopped'"+humanSession+" ORDER BY s.started_at DESC LIMIT 1", u.ID)
	if err != nil {
		return err
	}
	out := gin.H{"user": u, "session": nil, "workspace": nil}
	if len(ss) > 0 {
		var title string
		var settings json.RawMessage
		_ = a.db.QueryRow(c, `SELECT title, settings FROM workspaces WHERE id=$1`, ss[0].WorkspaceID).Scan(&title, &settings)
		out["session"] = ss[0]
		out["workspace"] = gin.H{"id": ss[0].WorkspaceID, "title": title, "settings": settings}
	}
	c.JSON(200, out)
	return nil
}

/* ---------------------------------------------------------------- capture */

type capturePageReq struct {
	URL           string            `json:"url"`
	Title         string            `json:"title"`
	FaviconURL    *string           `json:"favicon_url"`
	Meta          map[string]string `json:"meta"`
	ContentText   string            `json:"content_text"`
	OutgoingLinks []string          `json:"outgoing_links"`
	OpenerURL     *string           `json:"opener_url"`
	SearchQuery   *string           `json:"search_query"`
	Transition    string            `json:"transition"`
	TabID         *int              `json:"tab_id"`
	WorkspaceID   string            `json:"workspace_id"`
	ClientName    string            `json:"-"` // MCP client name (server-set, never from the request body)
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

func (a *App) blocked(ctx context.Context, wsID, domain string) bool {
	return blockedIn(a.blocklist(ctx, wsID), domain)
}

func (a *App) blocklist(ctx context.Context, wsID string) []string {
	var list []string
	_ = a.db.QueryRow(ctx, `SELECT coalesce(ARRAY(SELECT jsonb_array_elements_text(settings->'blocklist')), '{}') FROM workspaces WHERE id=$1`, wsID).Scan(&list)
	return list
}

func blockedIn(list []string, domain string) bool {
	for _, b := range list {
		b = strings.ToLower(strings.TrimSpace(b))
		if b != "" && (domain == b || strings.HasSuffix(domain, "."+b)) {
			return true
		}
	}
	return false
}

func (a *App) activeSession(ctx context.Context, wsID, userID string) *Session {
	ss, _ := collect[Session](ctx, a.db, sessionSelect+"WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.state<>'stopped'"+humanSession, wsID, userID)
	if len(ss) == 0 {
		return nil
	}
	return &ss[0]
}

func (a *App) capturePage(c *gin.Context) error {
	var b capturePageReq
	if err := bind(c, &b); err != nil {
		return err
	}
	slog.Info("[GO] capture received", "workspace_id", b.WorkspaceID, "domain", domainOf(b.URL), "content_chars", len(b.ContentText), "transition", b.Transition)
	if b.WorkspaceID == "" {
		return httpx.BadRequest("workspace_id is required")
	}
	if _, err := a.requireWS(c, b.WorkspaceID, "editor"); err != nil {
		return err
	}
	u := currentUser(c)
	if !isHTTPURL(b.URL) {
		return httpx.Validation("Only http(s) pages can be captured")
	}
	domain := domainOf(b.URL)
	if a.blocked(c, b.WorkspaceID, domain) {
		return httpx.Forbidden(domain + " is on the blocklist")
	}
	session := a.activeSession(c, b.WorkspaceID, u.ID)
	if u.TokenKind == "extension" && (session == nil || session.State != "active") {
		return httpx.NewError(409, httpx.CodeConflict, "Tracking is not active for this workspace")
	}
	res, err := a.ingestPage(c, u, b, session, createdVia(u, b.Transition))
	if err != nil {
		return err
	}
	c.JSON(200, res)
	return nil
}

func createdVia(u *User, transition string) string {
	switch {
	case u.TokenKind == "mcp":
		return "mcp"
	case transition == "manual":
		return "manual"
	case u.TokenKind == "extension":
		return "extension"
	}
	return "manual"
}

// ingestPage is the single page-ingestion path used by the extension, manual "Add page", import and MCP.
// It creates the node immediately (status analyzing, ai_stage captured) and queues the AI pipeline.
func (a *App) ingestPage(ctx context.Context, u *User, b capturePageReq, session *Session, via string) (gin.H, error) {
	norm := normalizeURL(b.URL)
	title := truncateRunes(strings.TrimSpace(b.Title), 500)
	if title == "" {
		title = domainOf(b.URL)
	}
	content := truncateRunes(strings.TrimSpace(b.ContentText), 20000)
	if len(b.OutgoingLinks) > 200 {
		b.OutgoingLinks = b.OutgoingLinks[:200]
	}
	links, _ := json.Marshal(b.OutgoingLinks)
	if b.OutgoingLinks == nil {
		links = []byte("[]")
	}
	sum := sha256.Sum256([]byte(content))
	meta := func(k string) *string {
		if v := strings.TrimSpace(b.Meta[k]); v != "" {
			v = truncateRunes(v, 1000)
			return &v
		}
		return nil
	}
	var published *time.Time
	if p := meta("published_time"); p != nil {
		if t, err := time.Parse(time.RFC3339, *p); err == nil {
			published = &t
		}
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize captures of the same URL so retries and parallel tabs never create duplicate nodes.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, b.WorkspaceID+"|"+norm); err != nil {
		return nil, err
	}
	var pageID string
	err = tx.QueryRow(ctx, `INSERT INTO pages (workspace_id,url,url_normalized,domain,title,favicon_url,og_image_url,site_name,author,
		published_at,lang,content_text,content_hash,word_count,outgoing_links) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (workspace_id,url_normalized) DO UPDATE SET
		  content_text = CASE WHEN pages.content_text='' THEN EXCLUDED.content_text ELSE pages.content_text END,
		  content_hash = CASE WHEN pages.content_text='' THEN EXCLUDED.content_hash ELSE pages.content_hash END
		RETURNING id`,
		b.WorkspaceID, b.URL, norm, domainOf(b.URL), title, b.FaviconURL, meta("og_image"), meta("site_name"), meta("author"),
		published, meta("lang"), content, hex.EncodeToString(sum[:]), len(strings.Fields(content)), links).Scan(&pageID)
	if err != nil {
		return nil, err
	}
	var existing string
	_ = tx.QueryRow(ctx, `SELECT id FROM nodes WHERE page_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, pageID).Scan(&existing)
	if session != nil {
		if _, err := tx.Exec(ctx, `INSERT INTO session_references (session_id,page_id,ref_number,added_by)
			VALUES ($1,$2,(SELECT coalesce(max(ref_number),0)+1 FROM session_references WHERE session_id=$1),$3) ON CONFLICT DO NOTHING`,
			session.ID, pageID, u.ID); err != nil {
			return nil, err
		}
	}
	// Visits flushed before the page existed are linked now.
	var linkedFrom *time.Time
	if err := tx.QueryRow(ctx, `WITH l AS (UPDATE visits SET page_id=$1 WHERE workspace_id=$2 AND url_normalized=$3 AND page_id IS NULL RETURNING started_at)
		SELECT min(started_at) FROM l`, pageID, b.WorkspaceID, norm).Scan(&linkedFrom); err != nil {
		return nil, err
	}
	refreshJourney := func() {
		if linkedFrom == nil {
			return
		}
		go func() {
			bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			a.publishJourney(bg, b.WorkspaceID, u.ID, map[string]time.Time{pageID: *linkedFrom})
		}()
	}
	if existing != "" {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		refreshJourney()
		return gin.H{"node_id": existing, "page_id": pageID, "is_new": false}, nil
	}

	// Why was this opened? Link to the opener page node or the question node of the search.
	var openerID, openerTitle *string
	var openerType string
	if b.SearchQuery != nil && strings.TrimSpace(*b.SearchQuery) != "" {
		_ = tx.QueryRow(ctx, `SELECT id,title,type FROM nodes WHERE workspace_id=$1 AND type='question' AND deleted_at IS NULL AND lower(title)=lower($2) LIMIT 1`,
			b.WorkspaceID, strings.TrimSpace(*b.SearchQuery)).Scan(&openerID, &openerTitle, &openerType)
	}
	if openerID == nil && b.OpenerURL != nil && isHTTPURL(*b.OpenerURL) {
		_ = tx.QueryRow(ctx, `SELECT n.id,n.title,n.type FROM nodes n JOIN pages p ON p.id=n.page_id WHERE n.workspace_id=$1 AND n.deleted_at IS NULL
			AND p.url_normalized=$2 LIMIT 1`, b.WorkspaceID, normalizeURL(*b.OpenerURL)).Scan(&openerID, &openerTitle, &openerType)
	}
	if openerTitle != nil && openerType == "question" {
		t := "Search: “" + *openerTitle + "”"
		openerTitle = &t
	}
	transition := b.Transition
	if transition == "" {
		transition = "link"
	}
	why, _ := json.Marshal(gin.H{"opener_node_id": openerID, "opener_url": b.OpenerURL, "opener_title": openerTitle,
		"search_query": b.SearchQuery, "transition": transition, "note": nil, "opened_at": time.Now().UTC()})

	x, y := a.placement(ctx, tx, b.WorkspaceID, openerID)
	branch := ""
	if via == "mcp" {
		branch = a.agentBranch(ctx, b.WorkspaceID)
	} else if session != nil {
		branch = session.BranchID
	}
	if branch == "" {
		if branch, err = a.writeBranch(ctx, b.WorkspaceID, u.ID); err != nil {
			return nil, err
		}
	}
	var nodeID string
	if err := tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id,branch_id,type,page_id,title,x,y,status,ai_stage,why_opened,created_by,created_via,client_name)
		VALUES ($1,$2,'page',$3,$4,$5,$6,'analyzing','captured',$7,$8,$9,NULLIF($10,'')) RETURNING id`,
		b.WorkspaceID, branch, pageID, title, x, y, why, u.ID, via, b.ClientName).Scan(&nodeID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	refreshJourney()
	// The node is saved: answer now and broadcast it in the background, loading page and node concurrently (each load
	// is several round trips to a possibly remote database). Then the AI pipeline and bookkeeping follow.
	// ctx may be the request's gin.Context (pooled after the handler returns), so use a fresh context here.
	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var page *Page
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			if p, err := a.loadPage(bg, pageID); err == nil {
				page = p
			}
		}()
		node, nodeErr := a.loadNode(bg, nodeID)
		wg.Wait()
		if page != nil {
			a.publish(b.WorkspaceID, "page.created", &u.ID, page)
		}
		if nodeErr == nil {
			a.publish(b.WorkspaceID, "node.created", &u.ID, node)
		}
		a.pipeline.enqueue(nodeID)
		a.logEvent(bg, b.WorkspaceID, &u.ID, "node_added", gin.H{"node_id": nodeID, "title": title})
		a.touch(bg, b.WorkspaceID)
		if session != nil && via != "mcp" { // an assistant's session is not the user's tracking session
			if s, err := a.loadSession(bg, session.ID); err == nil {
				a.publish(b.WorkspaceID, "session.updated", nil, s)
			}
		}
	}()
	sid := ""
	if session != nil {
		sid = session.ID
	}
	slog.Info("[GO] node created", "workspace_id", b.WorkspaceID, "session_id", sid, "node_id", nodeID, "page_id", pageID, "via", via)
	return gin.H{"node_id": nodeID, "page_id": pageID, "is_new": true}, nil
}

// placement puts a new top-level node to the right of its opener, or in a free column left of the graph.
func (a *App) placement(ctx context.Context, q pgx.Tx, wsID string, openerID *string) (float64, float64) {
	if openerID != nil {
		var x, y float64
		if q.QueryRow(ctx, `SELECT n.x + coalesce(p.x,0), n.y + coalesce(p.y,0) FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id WHERE n.id=$1`, *openerID).Scan(&x, &y) == nil {
			var n int
			_ = q.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND why_opened->>'opener_node_id'=$2 AND deleted_at IS NULL`, wsID, *openerID).Scan(&n)
			return x + 360, y + float64(n)*250
		}
	}
	var minX *float64
	var cnt int
	_ = q.QueryRow(ctx, `SELECT min(x), count(*) FROM nodes WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL`, wsID).Scan(&minX, &cnt)
	if minX == nil {
		return 0, 0
	}
	return *minX - 360, float64(cnt%6) * 250
}

func (a *App) captureSearch(c *gin.Context) error {
	var b struct {
		Query       string `json:"query"`
		Engine      string `json:"engine"`
		URL         string `json:"url"`
		WorkspaceID string `json:"workspace_id"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if _, err := a.requireWS(c, b.WorkspaceID, "editor"); err != nil {
		return err
	}
	b.Query = truncateRunes(strings.TrimSpace(b.Query), 300)
	if b.Query == "" {
		return httpx.Validation("Search query is empty")
	}
	u := currentUser(c)
	var existing string
	_ = a.db.QueryRow(c, `SELECT id FROM nodes WHERE workspace_id=$1 AND type='question' AND deleted_at IS NULL AND lower(title)=lower($2) LIMIT 1`,
		b.WorkspaceID, b.Query).Scan(&existing)
	if existing != "" {
		c.JSON(200, gin.H{"node_id": existing, "is_new": false})
		return nil
	}
	branch, err := a.writeBranch(c, b.WorkspaceID, u.ID)
	if session := a.activeSession(c, b.WorkspaceID, u.ID); session != nil {
		branch = session.BranchID
	}
	if err != nil {
		return err
	}
	var minX *float64
	var qn int
	_ = a.db.QueryRow(c, `SELECT min(x), (SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='question') FROM nodes
		WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL`, b.WorkspaceID).Scan(&minX, &qn)
	x := 0.0
	if minX != nil {
		x = *minX - 340
	}
	why, _ := json.Marshal(gin.H{"search_query": b.Query, "opener_url": b.URL, "transition": "typed", "opened_at": time.Now().UTC()})
	var id string
	if err := a.db.QueryRow(c, `INSERT INTO nodes (workspace_id,branch_id,type,title,body,x,y,why_opened,created_by,created_via)
		VALUES ($1,$2,'question',$3,$4,$5,$6,$7,$8,$9) RETURNING id`, b.WorkspaceID, branch, b.Query, b.Engine, x, float64(qn)*140,
		why, u.ID, createdVia(u, "")).Scan(&id); err != nil {
		return err
	}
	a.publishNode(c, "node.created", id, &u.ID)
	a.publish(b.WorkspaceID, "job.status", nil, gin.H{"kind": "metadata", "status": "done", "message": "Question node from search: “" + b.Query + "”", "node_id": id, "agent": 3})
	c.JSON(200, gin.H{"node_id": id, "is_new": true})
	return nil
}

func (a *App) captureVisits(c *gin.Context) error {
	var b struct {
		SessionID string `json:"session_id"`
		Visits    []struct {
			URL       string    `json:"url"`
			TabID     *int      `json:"tab_id"`
			StartedAt time.Time `json:"started_at"`
			EndedAt   time.Time `json:"ended_at"`
		} `json:"visits"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	s, err := a.requireSession(c, b.SessionID, "editor")
	if err != nil {
		return err
	}
	u := currentUser(c)
	if s.UserID != u.ID {
		return httpx.Forbidden("This session belongs to another user")
	}
	if len(b.Visits) > 500 {
		return httpx.Validation("Too many visits in one batch")
	}
	accepted := 0
	touched := map[string]time.Time{} // page → earliest new visit
	for _, v := range b.Visits {
		if !isHTTPURL(v.URL) || v.EndedAt.Sub(v.StartedAt) < 2*time.Second || v.EndedAt.Sub(v.StartedAt) > 12*time.Hour {
			continue // tab-switch noise or invalid
		}
		norm := normalizeURL(v.URL)
		var pageID *string
		_ = a.db.QueryRow(c, `SELECT id FROM pages WHERE workspace_id=$1 AND url_normalized=$2`, s.WorkspaceID, norm).Scan(&pageID)
		if _, err := a.db.Exec(c, `INSERT INTO visits (workspace_id,session_id,user_id,page_id,url,url_normalized,tab_id,started_at,ended_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id,url_normalized,started_at) DO UPDATE SET ended_at=greatest(visits.ended_at, EXCLUDED.ended_at)`,
			s.WorkspaceID, s.ID, u.ID, pageID, v.URL, norm, v.TabID, v.StartedAt, v.EndedAt); err != nil {
			return err
		}
		accepted++
		if pageID != nil {
			if t, ok := touched[*pageID]; !ok || v.StartedAt.Before(t) {
				touched[*pageID] = v.StartedAt
			}
		}
	}
	// Visits change time spent and the research journey (previous/next topic) of these nodes and their neighbours.
	a.publishJourney(c, s.WorkspaceID, u.ID, touched)
	if s2, err := a.loadSession(c, s.ID); err == nil {
		a.publish(s.WorkspaceID, "session.updated", nil, s2)
	}
	c.JSON(200, gin.H{"accepted": accepted})
	return nil
}

func (a *App) captureHighlight(c *gin.Context) error {
	var b struct {
		URL         string `json:"url"`
		Quote       string `json:"quote"`
		FragmentURL string `json:"fragment_url"`
		WorkspaceID string `json:"workspace_id"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if _, err := a.requireWS(c, b.WorkspaceID, "editor"); err != nil {
		return err
	}
	b.Quote = truncateRunes(strings.TrimSpace(b.Quote), 2000)
	if b.Quote == "" {
		return httpx.Validation("Select some text first")
	}
	var nodeID string
	err := a.db.QueryRow(c, `SELECT n.id FROM nodes n JOIN pages p ON p.id=n.page_id WHERE n.workspace_id=$1 AND p.url_normalized=$2 AND n.deleted_at IS NULL LIMIT 1`,
		b.WorkspaceID, normalizeURL(b.URL)).Scan(&nodeID)
	if err != nil {
		return httpx.NotFound("Page node for this URL")
	}
	var frag *string
	if isHTTPURL(b.FragmentURL) {
		frag = &b.FragmentURL
	}
	an, err := a.createAnnotation(c, b.WorkspaceID, nodeID, annotationInput{Kind: "highlight", Quote: &b.Quote, FragmentURL: frag})
	if err != nil {
		return err
	}
	c.JSON(201, an)
	return nil
}

/* ---------------------------------------------------------------- previews */

func (a *App) putPreview(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "pages", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		Image string `json:"image"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	mime, data, ok := strings.Cut(strings.TrimPrefix(b.Image, "data:"), ";base64,")
	if !ok || (mime != "image/jpeg" && mime != "image/png" && mime != "image/webp") {
		return httpx.Validation("image must be a base64 JPEG, PNG or WebP data URL")
	}
	img, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(img) > 400*1024 {
		return httpx.Validation("image is invalid or larger than 400 KB")
	}
	var at time.Time
	if err := a.db.QueryRow(c, `UPDATE pages SET preview=$2, preview_mime=$3, preview_captured_at=now() WHERE id=$1 RETURNING preview_captured_at`,
		id, img, mime).Scan(&at); err != nil {
		return err
	}
	a.publish(wsID, "preview.updated", nil, gin.H{"page_id": id, "captured_at": at})
	c.JSON(200, gin.H{"page_id": id, "image": b.Image, "captured_at": at})
	return nil
}

func (a *App) getPreview(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "pages", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	var img []byte
	var mime *string
	var at *time.Time
	if err := a.db.QueryRow(c, `SELECT preview, preview_mime, preview_captured_at FROM pages WHERE id=$1`, id).Scan(&img, &mime, &at); err != nil {
		return err
	}
	var image *string
	if img != nil && mime != nil {
		s := "data:" + *mime + ";base64," + base64.StdEncoding.EncodeToString(img)
		image = &s
	}
	c.Header("Cache-Control", "private, max-age=5")
	c.JSON(200, gin.H{"page_id": id, "image": image, "captured_at": at})
	return nil
}

/* ---------------------------------------------------------------- journey, stats, references */

type visitRow struct {
	ID        string
	PageID    *string
	NodeID    *string
	URL       string
	Title     string
	Domain    string
	TopicID   *string
	Topic     string
	Research  bool
	StartedAt time.Time
	EndedAt   time.Time
}

func (v visitRow) ms() int64 { return v.EndedAt.Sub(v.StartedAt).Milliseconds() }

func (a *App) visitRows(ctx context.Context, where string, args ...any) ([]visitRow, error) {
	rows, err := a.db.Query(ctx, `SELECT v.id, v.page_id, n.id, v.url, coalesce(p.title, v.url), coalesce(p.domain, ''),
		t.id, coalesce(t.title, 'Unsorted'), coalesce(p.is_research, true), v.started_at, v.ended_at
		FROM visits v LEFT JOIN pages p ON p.id=v.page_id
		LEFT JOIN LATERAL (SELECT id, parent_id FROM nodes WHERE page_id=v.page_id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) n ON true
		LEFT JOIN nodes t ON t.id=n.parent_id `+where+` ORDER BY v.started_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []visitRow
	for rows.Next() {
		var v visitRow
		if err := rows.Scan(&v.ID, &v.PageID, &v.NodeID, &v.URL, &v.Title, &v.Domain, &v.TopicID, &v.Topic, &v.Research, &v.StartedAt, &v.EndedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a *App) journey(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	where, args := "WHERE v.workspace_id=$1", []any{wsID}
	var sid any
	if s := c.Query("session"); s != "" {
		where += " AND v.session_id=$2"
		args = append(args, s)
		sid = s
	}
	vs, err := a.visitRows(c, where, args...)
	if err != nil {
		return err
	}
	items := make([]gin.H, 0, len(vs))
	for _, v := range vs {
		items = append(items, gin.H{"visit_id": v.ID, "node_id": v.NodeID, "page_id": v.PageID, "url": v.URL, "title": v.Title,
			"topic_id": v.TopicID, "topic_name": v.Topic, "started_at": v.StartedAt, "ended_at": v.EndedAt, "duration_ms": v.ms()})
	}
	c.JSON(200, gin.H{"session_id": sid, "items": items})
	return nil
}

type kv struct {
	key string
	ms  int64
	n   int
	set map[string]bool
}

func sortedKV(m map[string]*kv, by func(*kv) int64) []*kv {
	out := make([]*kv, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool { return by(out[i]) > by(out[j]) })
	return out
}

// computeStats uses only real visit data: how long the session ran, how long pages were open, and where the time went.
func (a *App) computeStats(ctx context.Context, s *Session) (gin.H, error) {
	vs, err := a.visitRows(ctx, "WHERE v.session_id=$1", s.ID)
	if err != nil {
		return nil, err
	}
	end := time.Now()
	if s.EndedAt != nil {
		end = *s.EndedAt
	}
	total := end.Sub(s.StartedAt).Milliseconds() - s.PausedMs
	if s.State == "paused" && s.PausedAt != nil {
		total -= time.Since(*s.PausedAt).Milliseconds()
	}
	if total < 0 {
		total = 0
	}
	var active int64
	pages := map[string]bool{}
	byPage, bySite := map[string]*kv{}, map[string]*kv{}
	pageMeta := map[string]gin.H{}
	for _, v := range vs {
		ms := v.ms()
		active += ms
		pk := v.URL
		if v.PageID != nil {
			pk = *v.PageID
		}
		pages[pk] = true
		p := byPage[pk]
		if p == nil {
			p = &kv{key: pk}
			byPage[pk] = p
			pageMeta[pk] = gin.H{"page_id": v.PageID, "title": v.Title}
		}
		p.ms += ms
		site := v.Domain
		if site == "" {
			site = domainOf(v.URL)
		}
		d := bySite[site]
		if d == nil {
			d = &kv{key: site}
			bySite[site] = d
		}
		d.ms += ms
	}
	timePerPage, timePerSite := []gin.H{}, []gin.H{}
	for i, p := range sortedKV(byPage, func(k *kv) int64 { return k.ms }) {
		if i == 12 {
			break
		}
		timePerPage = append(timePerPage, gin.H{"page_id": pageMeta[p.key]["page_id"], "title": pageMeta[p.key]["title"], "ms": p.ms})
	}
	for i, d := range sortedKV(bySite, func(k *kv) int64 { return k.ms }) {
		if i == 8 {
			break
		}
		timePerSite = append(timePerSite, gin.H{"site": d.key, "ms": d.ms})
	}
	var sources int
	_ = a.db.QueryRow(ctx, `SELECT count(*) FROM session_references WHERE session_id=$1`, s.ID).Scan(&sources)
	return gin.H{"session_id": s.ID, "total_duration_ms": total, "active_ms": active, "pages_visited": len(pages), "sources_count": sources,
		"time_per_page": timePerPage, "time_per_site": timePerSite}, nil
}

func (a *App) sessionStats(c *gin.Context) error {
	s, err := a.requireSession(c, c.Param("id"), "viewer")
	if err != nil {
		return err
	}
	st, err := a.computeStats(c, s)
	if err != nil {
		return err
	}
	c.JSON(200, st)
	return nil
}

type Reference struct {
	RefNumber       int        `json:"ref_number" db:"ref_number"`
	PageID          string     `json:"page_id" db:"page_id"`
	NodeID          *string    `json:"node_id" db:"node_id"`
	Title           string     `json:"title" db:"title"`
	URL             string     `json:"url" db:"url"`
	Domain          string     `json:"domain" db:"domain"`
	SiteName        *string    `json:"site_name" db:"site_name"`
	Author          *string    `json:"author" db:"author"`
	PublishedAt     *time.Time `json:"published_at" db:"published_at"`
	FirstAccessedAt time.Time  `json:"first_accessed_at" db:"first_accessed_at"`
	AddedBy         *string    `json:"added_by" db:"added_by"`
}

func (a *App) references(ctx context.Context, sessionID string) ([]Reference, error) {
	return collect[Reference](ctx, a.db, `SELECT r.ref_number, r.page_id,
		(SELECT id FROM nodes WHERE page_id=r.page_id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) AS node_id,
		p.title, p.url, p.domain, p.site_name, p.author, p.published_at, r.first_accessed_at, u.name AS added_by
		FROM session_references r JOIN pages p ON p.id=r.page_id LEFT JOIN users u ON u.id=r.added_by
		WHERE r.session_id=$1 ORDER BY r.ref_number`, sessionID)
}

func referencesMarkdown(refs []Reference) string {
	var b strings.Builder
	for i, r := range refs {
		if i > 0 {
			b.WriteString("\n\n")
		}
		site := r.Domain
		if r.SiteName != nil {
			site = *r.SiteName
		}
		fmt.Fprintf(&b, "[%d] %s — %s\n    %s\n    Accessed: %s", r.RefNumber, r.Title, site, r.URL, r.FirstAccessedAt.Format("2 Jan 2006, 3:04 PM"))
	}
	return b.String()
}

func referencesBibtex(refs []Reference) string {
	var b strings.Builder
	for i, r := range refs {
		if i > 0 {
			b.WriteString("\n\n")
		}
		site := r.Domain
		if r.SiteName != nil {
			site = *r.SiteName
		}
		key := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				return r
			}
			return -1
		}, strings.ToLower(site))
		year := r.FirstAccessedAt.Year()
		if r.PublishedAt != nil {
			year = r.PublishedAt.Year()
		}
		esc := strings.NewReplacer("{", "\\{", "}", "\\}").Replace
		fmt.Fprintf(&b, "@misc{%s%d,\n  title = {%s},\n", key, r.RefNumber, esc(r.Title))
		if r.Author != nil {
			fmt.Fprintf(&b, "  author = {%s},\n", esc(*r.Author))
		}
		fmt.Fprintf(&b, "  howpublished = {\\url{%s}},\n  year = {%d},\n  note = {Accessed: %s}\n}", r.URL, year, r.FirstAccessedAt.Format("2006-01-02"))
	}
	return b.String()
}

func (a *App) sessionReferences(c *gin.Context) error {
	s, err := a.requireSession(c, c.Param("id"), "viewer")
	if err != nil {
		return err
	}
	refs, err := a.references(c, s.ID)
	if err != nil {
		return err
	}
	format := c.DefaultQuery("format", "json")
	var text any
	switch format {
	case "md":
		text = referencesMarkdown(refs)
	case "bibtex":
		text = referencesBibtex(refs)
	case "json":
	default:
		return httpx.Validation("format must be json, md or bibtex")
	}
	c.JSON(200, gin.H{"session_id": s.ID, "format": format, "references": refs, "text": text})
	return nil
}

/* ---------------------------------------------------------------- reports */

type reportRow struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"workspace_id" db:"workspace_id"`
	SessionID   string          `json:"session_id" db:"session_id"`
	Status      string          `json:"status" db:"status"`
	Model       string          `json:"model" db:"model"`
	Content     json.RawMessage `json:"content" db:"content"`
	CreatedAt   time.Time       `json:"created_at" db:"created_at"`
}

func (a *App) getReport(c *gin.Context) error {
	s, err := a.requireSession(c, c.Param("id"), "viewer")
	if err != nil {
		return err
	}
	rs, err := collect[reportRow](c, a.db, `SELECT id,workspace_id,session_id,status,model,content,created_at FROM reports WHERE session_id=$1`, s.ID)
	if err != nil {
		return err
	}
	if len(rs) == 0 {
		return httpx.NotFound("Report")
	}
	if rs[0].Content == nil {
		rs[0].Content = json.RawMessage("null")
	}
	c.JSON(200, rs[0])
	return nil
}

func (a *App) generateReport(c *gin.Context) error {
	s, err := a.requireSession(c, c.Param("id"), "viewer")
	if err != nil {
		return err
	}
	rs, err := collect[reportRow](c, a.db, `INSERT INTO reports (workspace_id,session_id,status,model,content) VALUES ($1,$2,'generating',$3,NULL)
		ON CONFLICT (session_id) DO UPDATE SET status='generating', content=NULL, created_at=now()
		RETURNING id,workspace_id,session_id,status,model,content,created_at`, s.WorkspaceID, s.ID, a.agent.ReportModel(c))
	if err != nil {
		return err
	}
	u := currentUser(c)
	a.publish(s.WorkspaceID, "job.status", &u.ID, gin.H{"kind": "report", "status": "running", "message": "Writing session summary…"})
	go a.buildReport(context.WithoutCancel(c.Request.Context()), s)
	rs[0].Content = json.RawMessage("null")
	c.JSON(200, rs[0])
	return nil
}

var errNoAgent = errors.New("agent unavailable")

// humanSession excludes the sessions MCP assistants record on the AI Agent branch from "the user's tracking session":
// an assistant researching must not show as the user tracking, nor pull the extension's captures into its branch.
const humanSession = " AND NOT EXISTS (SELECT 1 FROM branches ab WHERE ab.id=s.branch_id AND ab.kind='agent')"
