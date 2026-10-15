package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

/* ---------------------------------------------------------------- session goal
 * The user writes a goal when tracking starts ("Prepare for tomorrow's DevOps exam"). The AI splits it into
 * key topics, and the extension asks POST /goal/check for every page the user opens. A page that does not
 * match the goal gets a warning in the browser; pages that match mark key topics as covered (goal progress).
 */

type GoalCheck struct {
	URL       string    `json:"url" db:"url"`
	Domain    string    `json:"domain" db:"domain"`
	Title     string    `json:"title" db:"title"`
	OnGoal    bool      `json:"on_goal" db:"on_goal"`
	Score     int16     `json:"score" db:"score"`
	Reason    string    `json:"reason" db:"reason"`
	Covers    []int     `json:"covers" db:"covers"`
	Source    string    `json:"source" db:"source"`
	CheckedAt time.Time `json:"checked_at" db:"checked_at"`
}

const goalCheckSelect = `SELECT url,domain,title,on_goal,score,reason,covers,source,checked_at FROM goal_checks `

const maxGoalRunes = 500

// goalText is the goal as the user wrote it, plus what the AI understood it to mean.
func goalText(s *Session) string {
	if s.GoalMeaning == "" || strings.EqualFold(s.GoalMeaning, s.Goal) {
		return s.Goal
	}
	return s.Goal + " (meaning: " + s.GoalMeaning + ")"
}

// setGoal replaces the session goal. Old checks were judged against the old goal, so they are removed;
// the key topics are rebuilt in the background so starting a session never waits for the AI.
func (a *App) setGoal(ctx context.Context, s *Session, goal string, by *string) error {
	goal = truncateRunes(strings.TrimSpace(goal), maxGoalRunes)
	// Same goal: nothing to do, unless the AI has not understood it yet (then saving it again re-reads it).
	if goal == s.Goal && (goal == "" || s.GoalMeaning != "") {
		return nil
	}
	if _, err := a.db.Exec(ctx, `UPDATE sessions SET goal=$2, goal_topics='[]', goal_meaning='', goal_unclear=false,
		title=CASE WHEN $2<>'' THEN left($2, 80) ELSE 'Research on ' || to_char(started_at, 'FMDD Mon') END WHERE id=$1`, s.ID, goal); err != nil {
		return err
	}
	_, _ = a.db.Exec(ctx, `DELETE FROM goal_checks WHERE session_id=$1`, s.ID)
	a.logEvent(ctx, s.WorkspaceID, by, "goal_set", gin.H{"session_id": s.ID, "goal": goal})
	if goal != "" {
		go a.planGoal(s.ID, s.WorkspaceID, goal)
	}
	return nil
}

func (a *App) planGoal(sessionID, wsID, goal string) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var workspace string
	_ = a.db.QueryRow(ctx, `SELECT title FROM workspaces WHERE id=$1`, wsID).Scan(&workspace)
	var out struct {
		Meaning string   `json:"meaning"`
		Unclear bool     `json:"unclear"`
		Topics  []string `json:"topics"`
	}
	// The workspace name helps the AI read short goals: "cn" in a "devops" workspace means computer networks.
	if err := a.agent.post(ctx, "/v1/goal/plan", gin.H{"goal": goal, "workspace": workspace}, &out); err != nil {
		slog.Warn("[AI] goal plan failed", "session_id", sessionID, "err", err)
		return
	}
	topics := make([]GoalTopic, 0, len(out.Topics))
	for _, t := range out.Topics {
		if t = strings.TrimSpace(t); t != "" {
			topics = append(topics, GoalTopic{Name: truncateRunes(t, 60)})
		}
	}
	b, _ := json.Marshal(topics)
	// Only if the goal was not changed again while the AI was working.
	meaning := truncateRunes(strings.TrimSpace(out.Meaning), 300)
	tag, err := a.db.Exec(ctx, `UPDATE sessions SET goal_topics=$3, goal_meaning=$4, goal_unclear=$5 WHERE id=$1 AND goal=$2`,
		sessionID, goal, b, meaning, out.Unclear)
	if err != nil || tag.RowsAffected() == 0 {
		return
	}
	slog.Info("[AI] goal plan ready", "session_id", sessionID, "topics", len(topics), "unclear", out.Unclear)
	if s, err := a.loadSession(ctx, sessionID); err == nil {
		a.publish(wsID, "session.updated", nil, s)
	}
}

// PUT /sessions/:id/goal {goal} — set, change or clear ("") the goal of the user's own session.
func (a *App) updateGoal(c *gin.Context) error {
	var b struct {
		Goal string `json:"goal"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	s, err := a.requireSession(c, c.Param("id"), "editor")
	if err != nil {
		return err
	}
	u := currentUser(c)
	if s.UserID != u.ID {
		return httpx.Forbidden("This session belongs to another user")
	}
	if s.State == "stopped" {
		return httpx.Validation("This session has ended. Start a new session to set a goal.")
	}
	if err := a.setGoal(c, s, b.Goal, &u.ID); err != nil {
		return err
	}
	s, err = a.loadSession(c, s.ID)
	if err != nil {
		return err
	}
	a.publish(s.WorkspaceID, "session.updated", &u.ID, s)
	c.JSON(200, s)
	return nil
}

// GET /sessions/:id/goal-checks — pages checked against the goal, newest first.
func (a *App) listGoalChecks(c *gin.Context) error {
	s, err := a.requireSession(c, c.Param("id"), "viewer")
	if err != nil {
		return err
	}
	if s.UserID != currentUser(c).ID {
		return httpx.Forbidden("Only you can see the pages checked in your session")
	}
	checks, err := collect[GoalCheck](c, a.db, goalCheckSelect+"WHERE session_id=$1 ORDER BY checked_at DESC LIMIT 200", s.ID)
	if err != nil {
		return err
	}
	c.JSON(200, checks)
	return nil
}

type goalCheckReq struct {
	WorkspaceID string `json:"workspace_id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Text        string `json:"text"`
	SearchQuery string `json:"search_query"`
}

// goalSession returns the caller's tracking session in the workspace when it has a goal and the URL can be judged,
// plus the earlier check of this page in the session, if any. It is one database round trip (membership, session,
// blocklist and cache together) because the extension waits for this answer before it can warn the user.
func (a *App) goalSession(c *gin.Context, wsID, rawURL string) (*Session, *GoalCheck, error) {
	if wsID == "" {
		return nil, nil, httpx.BadRequest("workspace_id is required")
	}
	if !isHTTPURL(rawURL) {
		return nil, nil, httpx.Validation("Only http(s) pages can be checked")
	}
	var role string
	var sessionID, goal *string
	var topics []GoalTopic
	var blocklist []string
	var prev GoalCheck
	var prevURL *string
	var meaning *string
	err := a.db.QueryRow(c, `SELECT m.role, s.id, s.goal, s.goal_meaning, coalesce(s.goal_topics,'[]'::jsonb),
			coalesce(ARRAY(SELECT jsonb_array_elements_text(w.settings->'blocklist')), '{}'),
			g.url, coalesce(g.domain,''), coalesce(g.title,''), coalesce(g.on_goal,false), coalesce(g.score,0), coalesce(g.reason,''),
			coalesce(g.covers,'[]'::jsonb), coalesce(g.source,''), coalesce(g.checked_at, now())
		FROM workspaces w
		JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2
		LEFT JOIN sessions s ON s.workspace_id=w.id AND s.user_id=$2 AND s.state<>'stopped'
			AND NOT EXISTS (SELECT 1 FROM branches ab WHERE ab.id=s.branch_id AND ab.kind='agent')
		LEFT JOIN goal_checks g ON g.session_id=s.id AND g.url_normalized=$3
		WHERE w.id=$1 AND w.deleted_at IS NULL`, wsID, currentUser(c).ID, normalizeURL(rawURL)).
		Scan(&role, &sessionID, &goal, &meaning, &topics, &blocklist, &prevURL, &prev.Domain, &prev.Title, &prev.OnGoal, &prev.Score,
			&prev.Reason, &prev.Covers, &prev.Source, &prev.CheckedAt)
	if errors.Is(err, pgx.ErrNoRows) { // not a member (or no such workspace): let requireWS give the right error
		_, err = a.requireWS(c, wsID, "editor")
		if err == nil {
			err = httpx.Forbidden("You are not a member of this workspace")
		}
		return nil, nil, err
	}
	if err != nil {
		return nil, nil, err
	}
	if roleRank[role] < roleRank["editor"] {
		return nil, nil, httpx.Forbidden("Viewers cannot make changes")
	}
	if sessionID == nil || goal == nil || *goal == "" || blockedIn(blocklist, domainOf(rawURL)) {
		return nil, nil, nil
	}
	s := &Session{ID: *sessionID, WorkspaceID: wsID, Goal: *goal, GoalMeaning: *meaning, GoalTopics: topics}
	if prevURL == nil {
		return s, nil, nil
	}
	prev.URL = *prevURL
	return s, &prev, nil
}

// POST /goal/check — called by the extension for each page the user opens. Answers from the cache when the
// page was already checked in this session, otherwise asks the AI (fast model; local similarity as fallback).
func (a *App) checkGoal(c *gin.Context) error {
	var b goalCheckReq
	if err := bind(c, &b); err != nil {
		return err
	}
	s, prev, err := a.goalSession(c, b.WorkspaceID, b.URL)
	if err != nil {
		return err
	}
	if s == nil {
		c.JSON(200, gin.H{"checked": false})
		return nil
	}
	if prev != nil {
		c.JSON(200, gin.H{"checked": true, "cached": true, "goal": s.Goal, "check": prev})
		return nil
	}
	if !a.goalAI.allow("goal:" + currentUser(c).ID) {
		return httpx.RateLimited("Too many pages checked in one minute. Please wait a moment.")
	}
	names := make([]string, len(s.GoalTopics))
	for i, t := range s.GoalTopics {
		names[i] = t.Name
	}
	title := truncateRunes(strings.TrimSpace(b.Title), 500)
	ctx, cancel := context.WithTimeout(c, 25*time.Second)
	defer cancel()
	t0 := time.Now()
	var out struct {
		OnGoal bool   `json:"on_goal"`
		Score  int    `json:"score"`
		Reason string `json:"reason"`
		Covers []int  `json:"covers"`
		Source string `json:"source"`
	}
	if err := a.agent.post(ctx, "/v1/goal/check", gin.H{"goal": goalText(s), "topics": names, "url": b.URL, "title": title,
		"description": truncateRunes(b.Description, 500), "text": truncateRunes(b.Text, 2000), "search_query": truncateRunes(b.SearchQuery, 300)}, &out); err != nil {
		slog.Warn("[AI] goal check failed", "session_id", s.ID, "domain", domainOf(b.URL), "err", err)
		c.JSON(200, gin.H{"checked": false})
		return nil
	}
	slog.Info("[AI] goal check", "session_id", s.ID, "domain", domainOf(b.URL), "on_goal", out.OnGoal, "score", out.Score, "source", out.Source, "ms", time.Since(t0).Milliseconds())
	if out.Source != "ai" && out.Source != "similarity" {
		out.Source = "ai"
	}
	check, err := a.saveGoalCheck(c, s, b.URL, title, out.OnGoal, out.Score, out.Reason, out.Covers, out.Source)
	if err != nil {
		return err
	}
	c.JSON(200, gin.H{"checked": true, "cached": false, "goal": s.Goal, "check": check})
	return nil
}

// POST /goal/mark {workspace_id,url,title} — the user says "this page is related to my goal" (from the warning).
func (a *App) markGoal(c *gin.Context) error {
	var b goalCheckReq
	if err := bind(c, &b); err != nil {
		return err
	}
	s, _, err := a.goalSession(c, b.WorkspaceID, b.URL)
	if err != nil {
		return err
	}
	if s == nil {
		return httpx.Validation("There is no goal for this session")
	}
	_, _ = a.db.Exec(c, `DELETE FROM goal_checks WHERE session_id=$1 AND url_normalized=$2`, s.ID, normalizeURL(b.URL))
	check, err := a.saveGoalCheck(c, s, b.URL, truncateRunes(strings.TrimSpace(b.Title), 500), true, 100, "You marked this page as related to your goal.", nil, "user")
	if err != nil {
		return err
	}
	c.JSON(200, gin.H{"checked": true, "goal": s.Goal, "check": check})
	return nil
}

func (a *App) loadGoalCheck(ctx context.Context, sessionID, norm string) (*GoalCheck, error) {
	rows, err := a.db.Query(ctx, goalCheckSelect+"WHERE session_id=$1 AND url_normalized=$2", sessionID, norm)
	if err != nil {
		return nil, err
	}
	gc, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[GoalCheck])
	return &gc, err
}

// saveGoalCheck stores one result (first one wins), marks the key topics the page covers, and tells the web app.
func (a *App) saveGoalCheck(ctx context.Context, s *Session, rawURL, title string, onGoal bool, score int, reason string, covers []int, source string) (*GoalCheck, error) {
	norm := normalizeURL(rawURL)
	if title == "" {
		title = domainOf(rawURL)
	}
	valid := []int{}
	for _, i := range covers {
		if onGoal && i >= 0 && i < len(s.GoalTopics) {
			valid = append(valid, i)
		}
	}
	cv, _ := json.Marshal(valid)
	score = max(0, min(100, score))
	reason = truncateRunes(strings.TrimSpace(reason), 300)
	// The goal may have changed while the AI was working: then this answer is for the old goal and is dropped.
	check := &GoalCheck{URL: rawURL, Domain: domainOf(rawURL), Title: title, OnGoal: onGoal, Score: int16(score), Reason: reason, Covers: valid, Source: source}
	err := a.db.QueryRow(ctx, `INSERT INTO goal_checks (session_id,url_normalized,url,domain,title,on_goal,score,reason,covers,source)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=$1 AND goal=$11)
		ON CONFLICT (session_id,url_normalized) DO NOTHING RETURNING checked_at`,
		s.ID, norm, rawURL, check.Domain, title, onGoal, score, reason, cv, source, s.Goal).Scan(&check.CheckedAt)
	if errors.Is(err, pgx.ErrNoRows) { // not inserted: checked in parallel (keep the first answer) or the goal changed
		if prev, err := a.loadGoalCheck(ctx, s.ID, norm); err == nil {
			return prev, nil
		}
		return nil, httpx.NewError(409, httpx.CodeConflict, "The goal changed while this page was being checked")
	}
	if err != nil {
		return nil, err
	}
	// Progress and the web app update after the reply: the extension shows its warning without waiting for them.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if len(valid) > 0 {
			_, _ = a.db.Exec(ctx, `UPDATE sessions SET goal_topics = (
				SELECT jsonb_agg(CASE WHEN (x.ord - 1) = ANY($2::int[]) THEN x.t || '{"covered":true}'::jsonb ELSE x.t END ORDER BY x.ord)
				FROM jsonb_array_elements(goal_topics) WITH ORDINALITY AS x(t, ord))
				WHERE id=$1 AND jsonb_array_length(goal_topics) > 0`, s.ID, valid)
		}
		a.publish(s.WorkspaceID, "goal.checked", nil, gin.H{"session_id": s.ID}) // no page details: every member receives this
		if s2, err := a.loadSession(ctx, s.ID); err == nil {
			a.publish(s.WorkspaceID, "session.updated", nil, s2)
		}
	}()
	return check, nil
}
