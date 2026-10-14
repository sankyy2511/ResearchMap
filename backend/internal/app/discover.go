package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
)

func httpx400(msg string) error { return httpx.Validation(msg) }
func aiUnavailable() error {
	return httpx.AIUnavailable("The AI service is busy right now. Your data is safe; please try again shortly.")
}

/* ---------------------------------------------------------------- Research Radar (spec §F17, mock compute.ts#computeRadar) */

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	m := len(s) / 2
	if len(s)%2 == 1 {
		return s[m]
	}
	return (s[m-1] + s[m]) / 2
}

func (a *App) computeRadar(ctx context.Context, wsID string) (gin.H, error) {
	type topic struct {
		id, title       string
		s               int
		minutes         float64
		notes           int
		children        []string
		suggestions     []string
		status          string
		cov             float64
		flagged         bool
	}
	rows, err := a.db.Query(ctx, `SELECT t.id, t.title,
		(SELECT count(*) FROM nodes c WHERE c.parent_id=t.id AND c.type='page' AND c.deleted_at IS NULL AND c.status<>'inbox'),
		coalesce((SELECT sum(extract(epoch FROM v.ended_at-v.started_at))/60 FROM visits v JOIN nodes c ON c.page_id=v.page_id
		   WHERE c.parent_id=t.id AND c.deleted_at IS NULL),0)::float8,
		(SELECT count(*) FROM annotations an JOIN nodes c ON c.id=an.node_id WHERE c.parent_id=t.id AND an.kind<>'comment' AND c.deleted_at IS NULL)
		 + (SELECT count(*) FROM nodes c WHERE c.parent_id=t.id AND c.type IN ('note','finding') AND c.deleted_at IS NULL),
		coalesce(ARRAY(SELECT id FROM nodes c WHERE c.parent_id=t.id AND c.deleted_at IS NULL), '{}')
		FROM nodes t WHERE t.workspace_id=$1 AND t.type='topic' AND t.deleted_at IS NULL`, wsID)
	if err != nil {
		return nil, err
	}
	var ts []*topic
	for rows.Next() {
		t := &topic{}
		if err := rows.Scan(&t.id, &t.title, &t.s, &t.minutes, &t.notes, &t.children); err != nil {
			rows.Close()
			return nil, err
		}
		ts = append(ts, t)
	}
	rows.Close()
	var pageCount int
	_ = a.db.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='page' AND status<>'inbox' AND deleted_at IS NULL`, wsID).Scan(&pageCount)
	states := map[string]struct {
		status string
		sugg   []string
	}{}
	srows, _ := a.db.Query(ctx, `SELECT item_key, status, coalesce(suggestions,'null') FROM radar_item_states WHERE workspace_id=$1`, wsID)
	if srows != nil {
		for srows.Next() {
			var k, st string
			var sg []byte
			if srows.Scan(&k, &st, &sg) == nil {
				var arr []string
				_ = json.Unmarshal(sg, &arr)
				states[k] = struct {
					status string
					sugg   []string
				}{st, arr}
			}
		}
		srows.Close()
	}
	stateOf := func(k string) (string, any) {
		s, ok := states[k]
		if !ok {
			return "open", nil
		}
		if s.status == "" {
			s.status = "open"
		}
		if s.sugg == nil {
			return s.status, nil
		}
		return s.status, s.sugg
	}
	var ss, mm, nn []float64
	var sum float64
	for _, t := range ts {
		ss = append(ss, float64(t.s))
		mm = append(mm, t.minutes)
		nn = append(nn, float64(t.notes))
		sum += float64(t.s)
	}
	ms, mt, mn := median(ss), median(mm), median(nn)
	eligible := len(ts) >= 3 && pageCount >= 8
	avg := 0.0
	if len(ts) > 0 {
		avg = sum / float64(len(ts))
	}
	coverage := []gin.H{}
	items := []gin.H{}
	for _, t := range ts {
		c := 0.0
		if ms > 0 {
			c += 0.6 * math.Min(float64(t.s)/ms, 2)
		}
		if mt > 0 {
			c += 0.3 * math.Min(t.minutes/mt, 2)
		}
		if mn > 0 {
			c += 0.1 * math.Min(float64(t.notes)/mn, 2)
		}
		t.cov = math.Round(c*100) / 100
		t.flagged = eligible && c < 0.4
		coverage = append(coverage, gin.H{"topic_id": t.id, "topic_name": t.title, "sources": t.s, "minutes": math.Round(t.minutes),
			"notes": t.notes, "coverage": t.cov, "flagged": t.flagged})
		if t.flagged {
			key := "low:" + t.id
			st, sg := stateOf(key)
			items = append(items, gin.H{"id": key, "kind": "low_coverage", "topic_id": t.id, "node_id": t.id, "title": t.title,
				"message": fmt.Sprintf("This area appears under-covered in your workspace. Current sources: %d (other topics have %d on average).", t.s, int(math.Round(avg))),
				"source_count": t.s, "avg_sources": math.Round(avg*10) / 10, "coverage": t.cov, "related_node_ids": nonNil(t.children),
				"suggested_searches": sg, "status": st})
		}
	}
	sort.Slice(coverage, func(i, j int) bool { return coverage[i]["coverage"].(float64) < coverage[j]["coverage"].(float64) })
	// Unanswered questions.
	qrows, _ := a.db.Query(ctx, `SELECT q.id, q.title, q.parent_id FROM nodes q WHERE q.workspace_id=$1 AND q.type='question' AND q.deleted_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id=q.id AND e.relation='answers' AND e.state<>'rejected')`, wsID)
	if qrows != nil {
		for qrows.Next() {
			var id, title string
			var parent *string
			if qrows.Scan(&id, &title, &parent) == nil {
				key := "q:" + id
				st, sg := stateOf(key)
				items = append(items, gin.H{"id": key, "kind": "unanswered_question", "topic_id": parent, "node_id": id, "title": title,
					"message": "This question has no page that answers it yet in your workspace.", "source_count": 0, "avg_sources": math.Round(avg*10) / 10,
					"coverage": nil, "related_node_ids": []string{id}, "suggested_searches": sg, "status": st})
			}
		}
		qrows.Close()
	}
	// Mentioned but not explored: a concept in the topics of 3+ pages with no group or page of its own.
	crows, _ := a.db.Query(ctx, `SELECT lower(t.x), min(t.x), array_agg(DISTINCT n.id) FROM nodes n JOIN pages p ON p.id=n.page_id,
		LATERAL jsonb_array_elements_text(p.topics) AS t(x)
		WHERE n.workspace_id=$1 AND n.deleted_at IS NULL AND n.type='page' AND n.status<>'inbox' GROUP BY lower(t.x) HAVING count(DISTINCT n.id) >= 3`, wsID)
	if crows != nil {
		explored := map[string]bool{}
		erows, _ := a.db.Query(ctx, `SELECT lower(title) FROM nodes WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL
			UNION SELECT lower(coalesce(p.main_concept,'')) FROM pages p WHERE p.workspace_id=$1`, wsID)
		if erows != nil {
			for erows.Next() {
				var e string
				if erows.Scan(&e) == nil && e != "" {
					explored[e] = true
				}
			}
			erows.Close()
		}
		for crows.Next() {
			var k, display string
			var ids []string
			if crows.Scan(&k, &display, &ids) != nil {
				continue
			}
			isExplored := false
			for e := range explored {
				if strings.Contains(e, k) || strings.Contains(k, e) {
					isExplored = true
					break
				}
			}
			if isExplored {
				continue
			}
			key := "concept:" + k
			st, sg := stateOf(key)
			items = append(items, gin.H{"id": key, "kind": "unexplored_concept", "topic_id": nil, "node_id": nil, "title": display,
				"message": fmt.Sprintf("Mentioned by %d pages but has no page or group of its own yet.", len(ids)), "source_count": 0,
				"avg_sources": math.Round(avg*10) / 10, "coverage": nil, "related_node_ids": ids, "suggested_searches": sg, "status": st})
		}
		crows.Close()
	}
	var msg any
	if !eligible {
		msg = "Radar starts after 3 topics and 8 pages, so small workspaces are not flagged wrongly."
	}
	return gin.H{"eligible": eligible, "eligibility_message": msg, "items": items, "topics": coverage, "computed_at": time.Now().UTC()}, nil
}

func (a *App) getRadar(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	r, err := a.computeRadar(c, c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, r)
	return nil
}

// radarSuggestions asks the AI for 3 searches. topicId may be a topic node id, question node id or a radar item id.
func (a *App) radarSuggestions(c *gin.Context) error {
	wsID, key := c.Param("id"), c.Param("topicId")
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	r, err := a.computeRadar(c, wsID)
	if err != nil {
		return err
	}
	title, itemKey := "", key
	for _, it := range r["items"].([]gin.H) {
		if it["id"] == key || it["topic_id"] == key || it["node_id"] == key {
			title, itemKey = it["title"].(string), it["id"].(string)
			break
		}
	}
	if title == "" {
		_ = a.db.QueryRow(c, `SELECT title FROM nodes WHERE id=$1 AND workspace_id=$2`, key, wsID).Scan(&title)
	}
	if title == "" {
		return httpx.NotFound("Topic")
	}
	var neighbours []string
	for _, t := range r["topics"].([]gin.H) {
		neighbours = append(neighbours, t["topic_name"].(string))
	}
	var out struct {
		Searches []string `json:"suggested_searches"`
	}
	if err := a.agent.post(c, "/v1/radar/suggest", gin.H{"topic": title, "neighbour_topics": neighbours}, &out); err != nil || len(out.Searches) == 0 {
		return aiUnavailable()
	}
	if _, err := a.db.Exec(c, `INSERT INTO radar_item_states (workspace_id,item_key,suggestions) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id,item_key) DO UPDATE SET suggestions=$3`, wsID, itemKey, mustJSON(out.Searches)); err != nil {
		return err
	}
	if r2, err := a.computeRadar(c, wsID); err == nil {
		a.publish(wsID, "radar.updated", nil, r2)
	}
	c.JSON(200, gin.H{"topic_id": key, "suggested_searches": out.Searches})
	return nil
}

func (a *App) updateRadarItem(c *gin.Context) error {
	wsID, key := c.Param("id"), c.Param("itemId")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct{ Status string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Status != "open" && b.Status != "reviewed" && b.Status != "ignored" {
		return httpx.Validation("Invalid status")
	}
	if _, err := a.db.Exec(c, `INSERT INTO radar_item_states (workspace_id,item_key,status) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id,item_key) DO UPDATE SET status=$3`, wsID, key, b.Status); err != nil {
		return err
	}
	r, err := a.computeRadar(c, wsID)
	if err != nil {
		return err
	}
	a.publish(wsID, "radar.updated", nil, r)
	for _, it := range r["items"].([]gin.H) {
		if it["id"] == key {
			c.JSON(200, it)
			return nil
		}
	}
	return httpx.NotFound("Radar item")
}

/* ---------------------------------------------------------------- reorganize */

func (a *App) reorganize(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	u := currentUser(c)
	// Snapshot for one-step undo.
	var snap []byte
	if err := a.db.QueryRow(c, `SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'parent_id',parent_id,'x',x,'y',y,'width',width,'height',height,'deleted',deleted_at IS NOT NULL)),'[]')
		FROM nodes WHERE workspace_id=$1`, wsID).Scan(&snap); err != nil {
		return err
	}
	tokRaw := make([]byte, 16)
	_, _ = rand.Read(tokRaw)
	token := hex.EncodeToString(tokRaw)
	if _, err := a.db.Exec(c, `INSERT INTO reorganize_undo (workspace_id,token,snapshot) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id) DO UPDATE SET token=$2, snapshot=$3, created_at=now()`, wsID, token, snap); err != nil {
		return err
	}
	a.publish(wsID, "job.status", &u.ID, gin.H{"kind": "cluster", "status": "running", "message": "Re-organizing topics…"})
	// Group unlocked, ungrouped pages by their main AI topic (topics from Agent 1). Locked placements are never moved.
	rows, err := a.db.Query(c, `SELECT n.id, p.topics->>0 FROM nodes n JOIN pages p ON p.id=n.page_id WHERE n.workspace_id=$1 AND n.type='page'
		AND n.deleted_at IS NULL AND n.status<>'inbox' AND n.parent_id IS NULL AND NOT n.group_locked AND jsonb_array_length(p.topics) > 0`, wsID)
	if err != nil {
		return err
	}
	type mv struct{ id, topic string }
	var mvs []mv
	for rows.Next() {
		var m mv
		if rows.Scan(&m.id, &m.topic) == nil {
			mvs = append(mvs, m)
		}
	}
	rows.Close()
	var before int
	_ = a.db.QueryRow(c, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL`, wsID).Scan(&before)
	for _, m := range mvs {
		a.pipeline.placeInTopic(c, wsID, m.id, m.topic)
	}
	var after int
	_ = a.db.QueryRow(c, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL`, wsID).Scan(&after)
	a.publishReorganized(c, wsID, &u.ID)
	a.publish(wsID, "job.status", &u.ID, gin.H{"kind": "cluster", "status": "done", "message": fmt.Sprintf("Re-organized · %d moved, %d new topics", len(mvs), after-before)})
	a.logEvent(c, wsID, &u.ID, "reorganized", gin.H{"moved": len(mvs)})
	c.JSON(200, gin.H{"topics_created": after - before, "nodes_moved": len(mvs), "undo_token": token})
	return nil
}

func (a *App) publishReorganized(c *gin.Context, wsID string, by *string) {
	topics, _ := queryNodes(c, a.db, "WHERE n.workspace_id=$1 AND n.type='topic' AND n.deleted_at IS NULL", wsID)
	_ = a.fillActivity(c, wsID, topics)
	changes := []gin.H{}
	rows, _ := a.db.Query(c, `SELECT id, parent_id, x, y FROM nodes WHERE workspace_id=$1 AND type<>'topic' AND deleted_at IS NULL`, wsID)
	if rows != nil {
		for rows.Next() {
			var id string
			var parent *string
			var x, y float64
			if rows.Scan(&id, &parent, &x, &y) == nil {
				changes = append(changes, gin.H{"id": id, "parent_id": parent, "x": x, "y": y})
			}
		}
		rows.Close()
	}
	if topics == nil {
		topics = []Node{}
	}
	a.publish(wsID, "graph.reorganized", by, gin.H{"topics": topics, "parent_changes": changes})
}

func (a *App) undoReorganize(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		UndoToken string `json:"undo_token"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	var snap []byte
	if err := a.db.QueryRow(c, `DELETE FROM reorganize_undo WHERE workspace_id=$1 AND token=$2 RETURNING snapshot`, wsID, b.UndoToken).Scan(&snap); err != nil {
		return httpx.NewError(409, httpx.CodeConflict, "Nothing to undo")
	}
	if _, err := a.db.Exec(c, `
		WITH s AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(id text, parent_id text, x float8, y float8, width float8, height float8, deleted bool))
		UPDATE nodes n SET parent_id=s.parent_id, x=s.x, y=s.y, width=s.width, height=s.height, version=n.version+1 FROM s WHERE n.id=s.id AND n.workspace_id=$1`, wsID, snap); err != nil {
		return err
	}
	// Topics created by the reorganize (not in the snapshot) are removed.
	_, _ = a.db.Exec(c, `UPDATE nodes SET deleted_at=now() WHERE workspace_id=$1 AND type='topic' AND deleted_at IS NULL
		AND NOT (id IN (SELECT x->>'id' FROM jsonb_array_elements($2::jsonb) x))`, wsID, snap)
	a.publishReorganized(c, wsID, &currentUser(c).ID)
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- search (FTS + trigram + vector, fused with RRF) */

func (a *App) search(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	start := time.Now()
	q := strings.TrimSpace(c.Query("q"))
	var f searchFilters
	if raw := c.Query("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &f); err != nil {
			return httpx.BadRequest("filters must be JSON")
		}
	}
	if q == "" {
		c.JSON(200, gin.H{"query": q, "results": []gin.H{}, "took_ms": 0})
		return nil
	}
	out := a.hybridSearch(c, wsID, q, f)
	c.JSON(200, gin.H{"query": q, "results": out, "took_ms": time.Since(start).Milliseconds()})
	return nil
}

type searchFilters struct {
	Kinds     []string `json:"kinds"`
	TagIDs    []string `json:"tag_ids"`
	Domains   []string `json:"domains"`
	PageTypes []string `json:"page_types"`
}

// hybridSearch ranks full-text, fuzzy, notes, tags and pgvector matches with reciprocal rank fusion.
// Shared by the REST search endpoint and the MCP search_workspace tool so both rank the same way.
func (a *App) hybridSearch(ctx context.Context, wsID, q string, f searchFilters) []gin.H {
	want := func(k string) bool {
		if len(f.Kinds) == 0 {
			return true
		}
		for _, x := range f.Kinds {
			if x == k {
				return true
			}
		}
		return false
	}
	scores := map[string]float64{}
	results := map[string]gin.H{}
	addRanked := func(list []gin.H) {
		for i, r := range list {
			id := r["id"].(string)
			scores[id] += 1.0 / float64(60+i+1)
			if _, ok := results[id]; !ok {
				results[id] = r
			}
		}
	}
	nodeFilter := `n.workspace_id=$1 AND n.deleted_at IS NULL
		AND (cardinality($3::text[])=0 OR n.tag_ids && $3::text[])
		AND (cardinality($4::text[])=0 OR p.domain = ANY($4::text[]))
		AND (cardinality($5::text[])=0 OR p.page_type = ANY($5::text[]))`
	like := "%" + strings.ReplaceAll(strings.ReplaceAll(q, "%", ""), "_", "") + "%"
	scan := func(sql string, args ...any) []gin.H {
		rows, err := a.db.Query(ctx, sql, args...)
		if err != nil {
			return nil
		}
		defer rows.Close()
		var out []gin.H
		for rows.Next() {
			var id, kind, title, snippet string
			var nodeID, url *string
			var tags []string
			if rows.Scan(&id, &kind, &nodeID, &title, &snippet, &url, &tags) == nil && want(kind) {
				out = append(out, gin.H{"id": id, "kind": kind, "node_id": nodeID, "title": title, "snippet": snippet, "url": url, "tag_ids": nonNil(tags)})
			}
		}
		return out
	}
	base := []any{wsID, q, nonNil(f.TagIDs), nonNil(f.Domains), nonNil(f.PageTypes)}
	// 1. Full-text search on pages.
	addRanked(scan(`SELECT 'page:'||n.id, 'page', n.id, n.title,
		ts_headline('english', coalesce(p.summary,'')||' '||left(p.content_text,3000), websearch_to_tsquery('english',$2), 'MaxWords=28,MinWords=10,StartSel=,StopSel='),
		p.url, n.tag_ids FROM nodes n JOIN pages p ON p.id=n.page_id WHERE `+nodeFilter+` AND p.search_tsv @@ websearch_to_tsquery('english',$2)
		ORDER BY ts_rank(p.search_tsv, websearch_to_tsquery('english',$2)) DESC LIMIT 20`, base...))
	// 2. Fuzzy + substring match on titles, notes, questions, findings, topics.
	addRanked(scan(`SELECT n.type||':'||n.id, CASE WHEN n.type='page' THEN 'page' ELSE n.type END, n.id, n.title,
		CASE WHEN n.type='topic' THEN 'Topic group' WHEN n.type='question' THEN 'Question' ELSE left(coalesce(nullif(n.body,''), p.summary, ''),160) END,
		p.url, n.tag_ids FROM nodes n LEFT JOIN pages p ON p.id=n.page_id WHERE `+nodeFilter+`
		AND (n.title ILIKE $6 OR n.body ILIKE $6 OR similarity(n.title,$2) > 0.25) ORDER BY similarity(n.title,$2) DESC LIMIT 20`, append(base, like)...))
	// 3. Notes, comments and highlights.
	addRanked(scan(`SELECT CASE WHEN an.kind='highlight' THEN 'hl:' ELSE 'ann:' END||an.id, CASE WHEN an.kind='highlight' THEN 'highlight' ELSE 'note' END, n.id,
		CASE WHEN an.kind='highlight' THEN n.title WHEN an.kind='comment' THEN 'Comment on '||n.title ELSE 'Note on '||n.title END,
		CASE WHEN an.kind='highlight' THEN '“'||an.quote||'”' ELSE left(an.body,160) END,
		an.fragment_url, '{}'::text[] FROM annotations an JOIN nodes n ON n.id=an.node_id LEFT JOIN pages p ON p.id=n.page_id
		WHERE `+nodeFilter+` AND (an.body ILIKE $6 OR an.quote ILIKE $6) LIMIT 20`, append(base, like)...))
	// 4. Tags.
	addRanked(scan(`SELECT 'tag:'||t.id||':'||n.id, 'tag', n.id, n.title, 'Tagged “'||t.name||'”', NULL, ARRAY[t.id]
		FROM tags t JOIN nodes n ON t.id = ANY(n.tag_ids) AND n.deleted_at IS NULL LEFT JOIN pages p ON p.id=n.page_id
		WHERE t.workspace_id=$1 AND (t.name ILIKE $6 OR similarity(t.name,$2) > 0.3) AND `+nodeFilter+` LIMIT 20`, append(base, like)...))
	// 5. Meaning search (pgvector), if the AI service can embed the query.
	var emb struct {
		Vectors [][]float32 `json:"vectors"`
	}
	if a.agent.post(ctx, "/v1/embed", gin.H{"texts": []string{q}}, &emb) == nil && len(emb.Vectors) == 1 {
		addRanked(scan(`SELECT 'page:'||n.id, 'page', n.id, n.title, left(coalesce(p.summary,''),160), p.url, n.tag_ids
			FROM nodes n JOIN pages p ON p.id=n.page_id WHERE `+nodeFilter+` AND p.embedding IS NOT NULL AND 1-(p.embedding <=> $6::vector) > 0.45
			ORDER BY p.embedding <=> $6::vector LIMIT 15`, append(base, *vec(emb.Vectors[0]))...))
	}
	out := make([]gin.H, 0, len(results))
	for id, r := range results {
		r["score"] = math.Round(scores[id]*10000) / 10000
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["score"].(float64) > out[j]["score"].(float64) })
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

/* ---------------------------------------------------------------- export + import */

var relationLabels = map[string]string{"answers": "answers", "subtopic_of": "subtopic of", "explains": "explains", "supports": "supports",
	"contradicts": "contradicts", "example_of": "example of", "prerequisite_of": "prerequisite of", "alternative_to": "alternative to",
	"same_topic": "same topic", "source_of": "source of", "opened_from": "opened from", "links_to": "links to", "duplicate_of": "duplicate of"}

func slugify(s string) string {
	s = strings.ToLower(regexp.MustCompile(`[^a-zA-Z0-9]+`).ReplaceAllString(s, "-"))
	s = strings.Trim(s, "-")
	if s == "" {
		return "workspace"
	}
	return s
}

func (a *App) export(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		return err
	}
	format := c.DefaultQuery("format", "json")
	var title, desc string
	if err := a.db.QueryRow(c, `SELECT title, description FROM workspaces WHERE id=$1`, wsID).Scan(&title, &desc); err != nil {
		return err
	}
	nodes, err := queryNodes(c, a.db, "WHERE n.workspace_id=$1 AND n.deleted_at IS NULL ORDER BY n.created_at", wsID)
	if err != nil {
		return err
	}
	_ = a.fillActivity(c, wsID, nodes)
	edges, _ := collect[Edge](c, a.db, edgeSelect+"WHERE e.workspace_id=$1 AND e.state<>'rejected'", wsID)
	pages, _ := a.loadPages(c, "WHERE p.workspace_id=$1 ORDER BY p.created_at", wsID)
	tags, _ := collect[Tag](c, a.db, `SELECT id,workspace_id,name,color FROM tags WHERE workspace_id=$1`, wsID)
	cats, _ := collect[Category](c, a.db, `SELECT id,workspace_id,kind,name,color FROM categories WHERE workspace_id=$1`, wsID)
	anns, _ := collect[Annotation](c, a.db, annotationSelect+"WHERE a.workspace_id=$1", wsID)
	byID := map[string]*Node{}
	pageByID := map[string]*Page{}
	for i := range nodes {
		byID[nodes[i].ID] = &nodes[i]
	}
	for i := range pages {
		pageByID[pages[i].ID] = &pages[i]
	}
	live := map[string]bool{}
	for _, n := range nodes {
		live[n.ID] = true
	}
	var es []Edge
	for _, e := range edges {
		if live[e.SourceID] && live[e.TargetID] {
			es = append(es, e)
		}
	}
	var topics []Node
	children := map[string][]Node{}
	for _, n := range nodes {
		if n.Type == "topic" {
			topics = append(topics, n)
		} else {
			k := ""
			if n.ParentID != nil {
				k = *n.ParentID
			}
			children[k] = append(children[k], n)
		}
	}
	pageOf := func(n Node) *Page {
		if n.PageID == nil {
			return nil
		}
		return pageByID[*n.PageID]
	}
	base := slugify(title)
	var content, filename, mime string
	switch format {
	case "json":
		b, _ := json.MarshalIndent(gin.H{"format": "research-map/v1", "exported_at": time.Now().UTC(), "workspace": gin.H{"title": title, "description": desc},
			"nodes": nodes, "edges": es, "pages": pages, "tags": tags, "categories": cats, "annotations": anns}, "", "  ")
		content, filename, mime = string(b), base+".json", "application/json"
	case "md":
		var sb strings.Builder
		fmt.Fprintf(&sb, "# %s\n\n%s\n\n", title, desc)
		section := func(h string, ns []Node) {
			if len(ns) == 0 {
				return
			}
			fmt.Fprintf(&sb, "## %s\n\n", h)
			for _, n := range ns {
				if p := pageOf(n); p != nil {
					fmt.Fprintf(&sb, "- [%s](%s)", n.Title, p.URL)
					if p.Summary != nil {
						fmt.Fprintf(&sb, " — %s", *p.Summary)
					}
					sb.WriteString("\n")
				} else {
					label := map[string]string{"question": "Question", "finding": "Finding"}[n.Type]
					if label == "" {
						label = "Note"
					}
					fmt.Fprintf(&sb, "- **%s:** %s", label, n.Title)
					if n.Body != "" && n.Type != "question" {
						fmt.Fprintf(&sb, " — %s", strings.ReplaceAll(n.Body, "\n", " "))
					}
					sb.WriteString("\n")
				}
				for _, an := range anns {
					if an.NodeID != n.ID {
						continue
					}
					if an.Kind == "highlight" && an.Quote != nil {
						fmt.Fprintf(&sb, "  > “%s”\n", *an.Quote)
					} else {
						fmt.Fprintf(&sb, "  - %s\n", strings.ReplaceAll(an.Body, "\n", " "))
					}
				}
			}
			sb.WriteString("\n")
		}
		for _, t := range topics {
			section(t.Title, children[t.ID])
		}
		section("Unsorted", children[""])
		sb.WriteString("## Connections\n\n")
		for _, e := range es {
			fmt.Fprintf(&sb, "- %s → (%s) → %s", byID[e.SourceID].Title, e.Relation, byID[e.TargetID].Title)
			if e.Reason != nil {
				fmt.Fprintf(&sb, " — %s", *e.Reason)
			}
			sb.WriteString("\n")
		}
		sb.WriteString("\n## References\n\n")
		for i, p := range pages {
			site := p.Domain
			if p.SiteName != nil {
				site = *p.SiteName
			}
			fmt.Fprintf(&sb, "[%d] %s — %s  \n    %s\n", i+1, p.Title, site, p.URL)
		}
		content, filename, mime = sb.String(), base+".md", "text/markdown"
	case "csv":
		cell := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
		lines := []string{`"title","url","topic","tags","time_spent_min","notes"`}
		tagName := map[string]string{}
		for _, t := range tags {
			tagName[t.ID] = t.Name
		}
		for _, n := range nodes {
			if n.Type != "page" {
				continue
			}
			url := ""
			if p := pageOf(n); p != nil {
				url = p.URL
			}
			topic := "Unsorted"
			if n.ParentID != nil && byID[*n.ParentID] != nil {
				topic = byID[*n.ParentID].Title
			}
			var tg, notes []string
			for _, t := range n.TagIDs {
				tg = append(tg, tagName[t])
			}
			for _, an := range anns {
				if an.NodeID == n.ID && an.Kind == "note" {
					notes = append(notes, strings.ReplaceAll(an.Body, "\n", " "))
				}
			}
			lines = append(lines, strings.Join([]string{cell(n.Title), cell(url), cell(topic), cell(strings.Join(tg, "; ")),
				cell(fmt.Sprint(n.Activity.TotalMs / 60000)), cell(strings.Join(notes, " | "))}, ","))
		}
		content, filename, mime = strings.Join(lines, "\n"), base+".csv", "text/csv"
	case "bookmarks":
		esc := html.EscapeString
		var sb strings.Builder
		fmt.Fprintf(&sb, "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>%s</TITLE>\n<H1>%s</H1>\n<DL><p>\n", esc(title), esc(title))
		folder := func(name string, ns []Node) {
			fmt.Fprintf(&sb, "    <DT><H3>%s</H3>\n    <DL><p>\n", esc(name))
			for _, n := range ns {
				if p := pageOf(n); p != nil {
					fmt.Fprintf(&sb, "        <DT><A HREF=\"%s\">%s</A>\n", esc(p.URL), esc(p.Title))
				}
			}
			sb.WriteString("    </DL><p>\n")
		}
		for _, t := range topics {
			folder(t.Title, children[t.ID])
		}
		folder("Unsorted", children[""])
		sb.WriteString("</DL><p>")
		content, filename, mime = sb.String(), base+"-bookmarks.html", "text/html"
	case "mermaid":
		idOf := map[string]string{}
		for i, n := range nodes {
			idOf[n.ID] = fmt.Sprintf("n%d", i)
		}
		label := func(s string) string {
			return truncateRunes(strings.NewReplacer(`"`, "", "[", "", "]", "", "(", "", ")", "").Replace(s), 48)
		}
		lines := []string{"graph LR"}
		for _, t := range topics {
			lines = append(lines, fmt.Sprintf(`  subgraph %s["%s"]`, idOf[t.ID], label(t.Title)))
			for _, n := range children[t.ID] {
				lines = append(lines, fmt.Sprintf(`    %s["%s"]`, idOf[n.ID], label(n.Title)))
			}
			lines = append(lines, "  end")
		}
		for _, n := range children[""] {
			lines = append(lines, fmt.Sprintf(`  %s["%s"]`, idOf[n.ID], label(n.Title)))
		}
		for _, e := range es {
			lines = append(lines, fmt.Sprintf("  %s -->|%s| %s", idOf[e.SourceID], relationLabels[e.Relation], idOf[e.TargetID]))
		}
		content, filename, mime = strings.Join(lines, "\n"), base+".mmd", "text/plain"
	case "bibtex":
		refs := make([]Reference, 0, len(pages))
		for i, p := range pages {
			refs = append(refs, Reference{RefNumber: i + 1, PageID: p.ID, Title: p.Title, URL: p.URL, Domain: p.Domain, SiteName: p.SiteName,
				Author: p.Author, PublishedAt: p.PublishedAt, FirstAccessedAt: p.CreatedAt})
		}
		content, filename, mime = referencesBibtex(refs), base+".bib", "application/x-bibtex"
	default:
		return httpx.Validation("Unknown export format")
	}
	c.JSON(200, gin.H{"format": format, "filename": filename, "mime": mime, "content": content})
	return nil
}

var bookmarkRe = regexp.MustCompile(`(?is)<A[^>]*HREF="([^"]+)"[^>]*>([^<]*)</A>`)

func (a *App) importWorkspace(c *gin.Context) error {
	var b struct {
		Format      string  `json:"format"`
		Content     string  `json:"content"`
		WorkspaceID *string `json:"workspace_id"`
		Title       string  `json:"title"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	type entry struct{ url, title string }
	var entries []entry
	title := strings.TrimSpace(b.Title)
	switch b.Format {
	case "json":
		var parsed struct {
			Workspace struct {
				Title string `json:"title"`
			} `json:"workspace"`
			Pages []struct {
				URL   string `json:"url"`
				Title string `json:"title"`
			} `json:"pages"`
		}
		if err := json.Unmarshal([]byte(b.Content), &parsed); err != nil {
			return httpx.Validation("This file is not valid JSON")
		}
		for _, p := range parsed.Pages {
			entries = append(entries, entry{p.URL, p.Title})
		}
		if title == "" {
			title = parsed.Workspace.Title + " (import)"
		}
	case "bookmarks":
		for _, m := range bookmarkRe.FindAllStringSubmatch(b.Content, -1) {
			entries = append(entries, entry{html.UnescapeString(m[1]), html.UnescapeString(m[2])})
		}
	case "onetab":
		for _, line := range strings.Split(b.Content, "\n") {
			u, t, _ := strings.Cut(strings.TrimSpace(line), " | ")
			if t == "" {
				t = u
			}
			entries = append(entries, entry{strings.TrimSpace(u), strings.TrimSpace(t)})
		}
	default:
		return httpx.Validation("Unknown import format")
	}
	var valid []entry
	for _, e := range entries {
		if isHTTPURL(e.url) {
			valid = append(valid, e)
		}
	}
	if len(valid) == 0 {
		return httpx.Validation("No links found in this file")
	}
	if len(valid) > 200 {
		valid = valid[:200]
	}
	u := currentUser(c)
	wsID := ""
	if b.WorkspaceID != nil && *b.WorkspaceID != "" {
		if _, err := a.requireWS(c, *b.WorkspaceID, "editor"); err != nil {
			return err
		}
		wsID = *b.WorkspaceID
	} else {
		if title == "" || title == " (import)" {
			title = "Imported research"
		}
		var err error
		if wsID, err = a.newWorkspace(c, u, truncateRunes(title, 120), "Imported from "+b.Format); err != nil {
			return err
		}
	}
	n := 0
	for _, e := range valid {
		res, err := a.ingestPage(c, u, capturePageReq{URL: e.url, Title: e.title, Transition: "manual", WorkspaceID: wsID}, nil, "import")
		if err == nil && res["is_new"] == true {
			n++
		}
	}
	c.JSON(200, gin.H{"workspace_id": wsID, "nodes_imported": n})
	return nil
}
