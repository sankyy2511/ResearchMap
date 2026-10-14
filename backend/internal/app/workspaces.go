package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"
)

type Workspace struct {
	ID            string          `json:"id"`
	OwnerID       string          `json:"owner_id"`
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Settings      json.RawMessage `json:"settings"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	NodeCount     int             `json:"node_count"`
	PageCount     int             `json:"page_count"`
	TopicCount    int             `json:"topic_count"`
	Members       []Member        `json:"members"`
	MyRole        string          `json:"my_role"`
	LastOpenedAt  *time.Time      `json:"last_opened_at"`
	ActiveSession *Session        `json:"active_session"`
	Activity      []int           `json:"activity"`
}

const defaultSettings = `{"blocklist":["mail.google.com","outlook.live.com","web.whatsapp.com","slack.com","discord.com","facebook.com","instagram.com","paypal.com"],"branches_enabled":true,"min_dwell_seconds":5}`

func (a *App) serializeWorkspace(ctx context.Context, wsID, userID string) (*Workspace, error) {
	w := &Workspace{Activity: make([]int, 7)}
	err := a.db.QueryRow(ctx, `SELECT w.id,w.owner_id,w.title,w.description,w.settings,w.created_at,w.updated_at,m.role,m.last_opened_at,
		(SELECT count(*) FROM nodes WHERE workspace_id=w.id AND deleted_at IS NULL AND type<>'topic'),
		(SELECT count(*) FROM nodes WHERE workspace_id=w.id AND deleted_at IS NULL AND type='page'),
		(SELECT count(*) FROM nodes WHERE workspace_id=w.id AND deleted_at IS NULL AND type='topic')
		FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2 WHERE w.id=$1`, wsID, userID).
		Scan(&w.ID, &w.OwnerID, &w.Title, &w.Description, &w.Settings, &w.CreatedAt, &w.UpdatedAt, &w.MyRole, &w.LastOpenedAt,
			&w.NodeCount, &w.PageCount, &w.TopicCount)
	if err != nil {
		return nil, err
	}
	if w.Members, err = collect[Member](ctx, a.db, `SELECT u.id AS user_id,u.name,u.email,u.avatar_color,m.role,m.joined_at
		FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at`, wsID); err != nil {
		return nil, err
	}
	ss, err := collect[Session](ctx, a.db, sessionSelect+"WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.state<>'stopped'"+humanSession, wsID, userID)
	if err != nil {
		return nil, err
	}
	if len(ss) > 0 {
		w.ActiveSession = &ss[0]
	}
	rows, err := a.db.Query(ctx, `SELECT (current_date - created_at::date) AS d, count(*) FROM nodes
		WHERE workspace_id=$1 AND type='page' AND deleted_at IS NULL AND created_at >= current_date - 6 GROUP BY d`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d, n int
		if err := rows.Scan(&d, &n); err == nil && d >= 0 && d < 7 {
			w.Activity[6-d] = n
		}
	}
	return w, rows.Err()
}

func (a *App) listWorkspaces(c *gin.Context) error {
	u := currentUser(c)
	rows, err := a.db.Query(c, `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1
		WHERE w.deleted_at IS NULL ORDER BY coalesce(m.last_opened_at, w.updated_at) DESC`, u.ID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	out := []*Workspace{}
	for _, id := range ids {
		w, err := a.serializeWorkspace(c, id, u.ID)
		if err != nil {
			return err
		}
		out = append(out, w)
	}
	c.JSON(200, out)
	return nil
}

// newWorkspace creates the workspace, owner membership and Main + personal + AI Agent branches in one transaction.
func (a *App) newWorkspace(ctx context.Context, u *User, title, desc string) (string, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO workspaces (owner_id,title,description,settings) VALUES ($1,$2,$3,$4) RETURNING id`,
		u.ID, title, desc, defaultSettings).Scan(&id); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role,last_opened_at) VALUES ($1,$2,'owner',now())`, id, u.ID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO branches (workspace_id,kind,owner_id,name,color) VALUES
		($1,'main',NULL,'Main','#1f1b2e'), ($1,'personal',$2,$3,$4), ($1,'agent',NULL,'AI Agent','#0f9d8a')`,
		id, u.ID, firstName(u.Name)+"'s branch", u.AvatarColor); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

func firstName(n string) string { return strings.Fields(n + " x")[0] }

func (a *App) createWorkspace(c *gin.Context) error {
	var b struct{ Title, Description string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Title = strings.TrimSpace(b.Title); b.Title == "" || len(b.Title) > 120 {
		return httpx.Validation("Give your workspace a name")
	}
	u := currentUser(c)
	id, err := a.newWorkspace(c, u, b.Title, strings.TrimSpace(b.Description))
	if err != nil {
		return err
	}
	w, err := a.serializeWorkspace(c, id, u.ID)
	if err != nil {
		return err
	}
	c.JSON(201, w)
	return nil
}

func (a *App) getWorkspace(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	w, err := a.serializeWorkspace(c, c.Param("id"), currentUser(c).ID)
	if err != nil {
		return err
	}
	c.JSON(200, w)
	return nil
}

func (a *App) updateWorkspace(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "editor"); err != nil {
		return err
	}
	var b struct {
		Title       *string        `json:"title"`
		Description *string        `json:"description"`
		Settings    map[string]any `json:"settings"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Title != nil && strings.TrimSpace(*b.Title) == "" {
		return httpx.Validation("Name cannot be empty")
	}
	var settings []byte
	if b.Settings != nil {
		allowed := map[string]bool{"blocklist": true, "branches_enabled": true, "min_dwell_seconds": true}
		for k := range b.Settings {
			if !allowed[k] {
				delete(b.Settings, k)
			}
		}
		settings, _ = json.Marshal(b.Settings)
	}
	if b.Title != nil {
		t := strings.TrimSpace(*b.Title)
		b.Title = &t
	}
	if _, err := a.db.Exec(c, `UPDATE workspaces SET title=coalesce($2,title), description=coalesce($3,description),
		settings = CASE WHEN $4::jsonb IS NULL THEN settings ELSE settings || $4::jsonb END, updated_at=now() WHERE id=$1`,
		id, b.Title, b.Description, settings); err != nil {
		return err
	}
	w, err := a.serializeWorkspace(c, id, currentUser(c).ID)
	if err != nil {
		return err
	}
	c.JSON(200, w)
	return nil
}

func (a *App) deleteWorkspace(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "owner"); err != nil {
		return err
	}
	// A workspace that someone is tracking into cannot be deleted: the session must be stopped first.
	var tracking bool
	if err := a.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM sessions WHERE workspace_id=$1 AND state<>'stopped')`, c.Param("id")).Scan(&tracking); err != nil {
		return err
	}
	if tracking {
		return httpx.NewError(409, httpx.CodeConflict, "Tracking is still on in this workspace. Stop tracking first, then delete it.")
	}
	if _, err := a.db.Exec(c, `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, c.Param("id")); err != nil {
		return err
	}
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- graph + view state */

// visibleBranches lists every branch of the workspace: all members see the same canvas, including what an AI assistant added.
func (a *App) visibleBranches(ctx context.Context, wsID string) ([]string, error) {
	rows, err := a.db.Query(ctx, `SELECT id FROM branches WHERE workspace_id=$1`, wsID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (a *App) getGraph(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "viewer"); err != nil {
		return err
	}
	u := currentUser(c)
	go func() { // the response does not wait for this
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = a.db.Exec(ctx, `UPDATE workspace_members SET last_opened_at=now() WHERE workspace_id=$1 AND user_id=$2`, id, u.ID)
	}()

	// Independent queries run in parallel; edges, pages and notes need the node ids first.
	var (
		ws       *Workspace
		branches []Branch
		nodes    []Node
		edges    []Edge
		pages    []Page
		tags     []Tag
		cats     []Category
		anns     []Annotation
		view     json.RawMessage
	)
	g, ctx := errgroup.WithContext(c)
	g.Go(func() (err error) { ws, err = a.serializeWorkspace(ctx, id, u.ID); return })
	g.Go(func() (err error) {
		branches, err = collect[Branch](ctx, a.db, `SELECT id,workspace_id,kind,owner_id,name,color,created_at FROM branches WHERE workspace_id=$1 ORDER BY created_at`, id)
		return
	})
	g.Go(func() (err error) {
		tags, err = collect[Tag](ctx, a.db, `SELECT id,workspace_id,name,color FROM tags WHERE workspace_id=$1 ORDER BY name`, id)
		return
	})
	g.Go(func() (err error) {
		cats, err = collect[Category](ctx, a.db, `SELECT id,workspace_id,kind,name,color FROM categories WHERE workspace_id=$1`, id)
		return
	})
	g.Go(func() error {
		_ = a.db.QueryRow(ctx, `SELECT state FROM view_states WHERE workspace_id=$1 AND user_id=$2`, id, u.ID).Scan(&view)
		return nil
	})
	g.Go(func() error {
		branchIDs, err := a.visibleBranches(ctx, id)
		if err != nil {
			return err
		}
				if nodes, err = queryNodes(ctx, a.db, `WHERE n.workspace_id=$1 AND n.deleted_at IS NULL AND (n.branch_id = ANY($2) OR n.type='topic') ORDER BY n.created_at`, id, branchIDs); err != nil {
			return err
		}
		nodeIDs := make([]string, len(nodes))
		pageIDs := []string{}
		for i, n := range nodes {
			nodeIDs[i] = n.ID
			if n.PageID != nil {
				pageIDs = append(pageIDs, *n.PageID)
			}
		}
		inner, ictx := errgroup.WithContext(ctx)
		inner.Go(func() error { return a.fillActivity(ictx, id, nodes) })
		inner.Go(func() (err error) {
			edges, err = collect[Edge](ictx, a.db, edgeSelect+`WHERE e.workspace_id=$1 AND e.source_id = ANY($2) AND e.target_id = ANY($2)`, id, nodeIDs)
			return
		})
		inner.Go(func() (err error) { pages, err = a.loadPages(ictx, "WHERE p.id = ANY($1)", pageIDs); return })
		inner.Go(func() (err error) {
			anns, err = collect[Annotation](ictx, a.db, annotationSelect+`WHERE a.workspace_id=$1 AND a.node_id = ANY($2) ORDER BY a.created_at`, id, nodeIDs)
			return
		})
		return inner.Wait()
	})
	if err := g.Wait(); err != nil {
		return err
	}
	if pages == nil {
		pages = []Page{}
	}
	if view == nil {
		view = json.RawMessage("null")
	}
	c.JSON(200, gin.H{"workspace": ws, "branches": branches, "nodes": nodes, "edges": edges, "pages": pages,
		"tags": tags, "categories": cats, "annotations": anns, "view_state": view})
	return nil
}

func (a *App) saveViewState(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "viewer"); err != nil {
		return err
	}
	var state map[string]any
	if err := bind(c, &state); err != nil {
		return err
	}
	b, _ := json.Marshal(state)
	if _, err := a.db.Exec(c, `INSERT INTO view_states (workspace_id,user_id,state) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id,user_id) DO UPDATE SET state=$3, updated_at=now()`, id, currentUser(c).ID, b); err != nil {
		return err
	}
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- members + share links */

func (a *App) listMembers(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	ms, err := collect[Member](c, a.db, `SELECT u.id AS user_id,u.name,u.email,u.avatar_color,m.role,m.joined_at
		FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at`, c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, ms)
	return nil
}

func (a *App) updateMember(c *gin.Context) error {
	id, uid := c.Param("id"), c.Param("userId")
	if _, err := a.requireWS(c, id, "owner"); err != nil {
		return err
	}
	var b struct{ Role string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Role != "editor" && b.Role != "viewer" {
		return httpx.Validation("Role must be editor or viewer")
	}
	tag, err := a.db.Exec(c, `UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'`, id, uid, b.Role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.Forbidden("This member cannot be changed")
	}
	ms, err := collect[Member](c, a.db, `SELECT u.id AS user_id,u.name,u.email,u.avatar_color,m.role,m.joined_at
		FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2`, id, uid)
	if err != nil || len(ms) == 0 {
		return httpx.NotFound("Member")
	}
	c.JSON(200, ms[0])
	return nil
}

func (a *App) removeMember(c *gin.Context) error {
	id, uid := c.Param("id"), c.Param("userId")
	if _, err := a.requireWS(c, id, "owner"); err != nil {
		return err
	}
	tag, err := a.db.Exec(c, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'`, id, uid)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.Forbidden("The owner cannot be removed")
	}
	a.hub.Kick(id, uid)
	c.Status(204)
	return nil
}

func (a *App) shareKey() cipher.AEAD {
	k := sha256.Sum256([]byte("share-links:" + a.cfg.JWTSecret))
	blk, _ := aes.NewCipher(k[:])
	g, _ := cipher.NewGCM(blk)
	return g
}

func (a *App) encryptToken(t string) string {
	g := a.shareKey()
	nonce := make([]byte, g.NonceSize())
	_, _ = rand.Read(nonce)
	return base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(t), nil))
}

func (a *App) decryptToken(s string) string {
	g := a.shareKey()
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) < g.NonceSize() {
		return ""
	}
	out, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	if err != nil {
		return ""
	}
	return string(out)
}

func (a *App) origin(c *gin.Context) string {
	if o := c.GetHeader("Origin"); o != "" {
		for _, allowed := range a.cfg.WebOrigins {
			if o == allowed {
				return o
			}
		}
	}
	return a.cfg.WebOrigins[0]
}

type shareLink struct {
	ID          string     `json:"id" db:"id"`
	WorkspaceID string     `json:"workspace_id" db:"workspace_id"`
	Role        string     `json:"role" db:"role"`
	URL         string     `json:"url" db:"-"`
	TokenEnc    string     `json:"-" db:"token_enc"`
	ExpiresAt   *time.Time `json:"expires_at" db:"expires_at"`
	DisabledAt  *time.Time `json:"disabled_at" db:"disabled_at"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

func (a *App) listShareLinks(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "owner"); err != nil {
		return err
	}
	links, err := collect[shareLink](c, a.db, `SELECT id,workspace_id,role,token_enc,expires_at,disabled_at,created_at FROM share_links
		WHERE workspace_id=$1 AND disabled_at IS NULL ORDER BY created_at DESC`, c.Param("id"))
	if err != nil {
		return err
	}
	for i := range links {
		links[i].URL = a.origin(c) + "/join/" + a.decryptToken(links[i].TokenEnc)
	}
	c.JSON(200, links)
	return nil
}

func (a *App) createShareLink(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "owner"); err != nil {
		return err
	}
	var b struct {
		Role          string `json:"role"`
		ExpiresInDays *int   `json:"expires_in_days"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Role != "editor" && b.Role != "viewer" {
		return httpx.Validation("Role must be editor or viewer")
	}
	var exp *time.Time
	if b.ExpiresInDays != nil && *b.ExpiresInDays > 0 {
		t := time.Now().Add(time.Duration(*b.ExpiresInDays) * 24 * time.Hour)
		exp = &t
	}
	raw := make([]byte, 20)
	_, _ = rand.Read(raw)
	tok := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(tok))
	l, err := collect[shareLink](c, a.db, `INSERT INTO share_links (workspace_id,token_hash,token_enc,role,created_by,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,workspace_id,role,token_enc,expires_at,disabled_at,created_at`,
		id, hex.EncodeToString(sum[:]), a.encryptToken(tok), b.Role, currentUser(c).ID, exp)
	if err != nil {
		return err
	}
	l[0].URL = a.origin(c) + "/join/" + tok
	c.JSON(201, l[0])
	return nil
}

func (a *App) disableShareLink(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "owner"); err != nil {
		return err
	}
	wsID, linkID := c.Param("id"), c.Param("linkId")
	tx, err := a.db.Begin(c)
	if err != nil {
		return err
	}
	defer tx.Rollback(c)
	if _, err := tx.Exec(c, `UPDATE share_links SET disabled_at=now() WHERE id=$1 AND workspace_id=$2`, linkID, wsID); err != nil {
		return err
	}
	// Revoke only the access this link granted; other links and directly added members are untouched.
	rows, err := tx.Query(c, `DELETE FROM workspace_members WHERE workspace_id=$1 AND share_link_id=$2 AND role<>'owner' RETURNING user_id`, wsID, linkID)
	if err != nil {
		return err
	}
	var revoked []string
	for rows.Next() {
		var uid string
		if rows.Scan(&uid) == nil {
			revoked = append(revoked, uid)
		}
	}
	rows.Close()
	if err := tx.Commit(c); err != nil {
		return err
	}
	a.hub.Kick(wsID, revoked...)
	c.Status(204)
	return nil
}

func (a *App) join(c *gin.Context) error {
	u := currentUser(c)
	sum := sha256.Sum256([]byte(c.Param("token")))
	var linkID, wsID, role string
	var exp, disabled *time.Time
	err := a.db.QueryRow(c, `SELECT id,workspace_id,role,expires_at,disabled_at FROM share_links WHERE token_hash=$1`, hex.EncodeToString(sum[:])).
		Scan(&linkID, &wsID, &role, &exp, &disabled)
	if errors.Is(err, pgx.ErrNoRows) || disabled != nil {
		return httpx.NotFound("Invite link")
	}
	if err != nil {
		return err
	}
	if exp != nil && exp.Before(time.Now()) {
		return httpx.Forbidden("This invite link has expired")
	}
	var existing string
	_ = a.db.QueryRow(c, `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, wsID, u.ID).Scan(&existing)
	if existing == "" {
		if _, err := a.db.Exec(c, `INSERT INTO workspace_members (workspace_id,user_id,role,share_link_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, wsID, u.ID, role, linkID); err != nil {
			return err
		}
		a.logEvent(c, wsID, &u.ID, "member_joined", gin.H{"role": role})
		existing = role
	} else if roleRank[role] > roleRank[existing] {
		// A viewer opening a valid editor link becomes an editor (never a downgrade, never touches the owner).
		// The membership now belongs to the editor link, so disabling the old viewer link does not remove it.
		if _, err := a.db.Exec(c, `UPDATE workspace_members SET role=$3, share_link_id=$4 WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'`,
			wsID, u.ID, role, linkID); err != nil {
			return err
		}
		a.logEvent(c, wsID, &u.ID, "member_role_changed", gin.H{"role": role})
		existing = role
	}
	c.JSON(200, gin.H{"workspace_id": wsID, "role": existing})
	return nil
}

/* ---------------------------------------------------------------- branches */

func (a *App) listBranches(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	bs, err := collect[Branch](c, a.db, `SELECT id,workspace_id,kind,owner_id,name,color,created_at FROM branches WHERE workspace_id=$1 ORDER BY created_at`, c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, bs)
	return nil
}

func (a *App) createBranch(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "editor"); err != nil {
		return err
	}
	var b struct{ Name string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" {
		return httpx.Validation("Branch name is required")
	}
	u := currentUser(c)
	bs, err := collect[Branch](c, a.db, `INSERT INTO branches (workspace_id,kind,owner_id,name,color) VALUES ($1,'personal',$2,$3,$4)
		RETURNING id,workspace_id,kind,owner_id,name,color,created_at`, id, u.ID, b.Name, u.AvatarColor)
	if err != nil {
		return err
	}
	c.JSON(201, bs[0])
	return nil
}

type compareItem struct {
	NodeID  string  `json:"node_id" db:"node_id"`
	Type    string  `json:"type" db:"type"`
	Title   string  `json:"title" db:"title"`
	URL     *string `json:"url" db:"url"`
	AddedBy string  `json:"added_by" db:"added_by"`
	norm    string
}

func (a *App) compareBranches(c *gin.Context) error {
	id := c.Param("id")
	if _, err := a.requireWS(c, id, "viewer"); err != nil {
		return err
	}
	load := func(bid string) (*Branch, []compareItem, error) {
		bs, err := collect[Branch](c, a.db, `SELECT id,workspace_id,kind,owner_id,name,color,created_at FROM branches WHERE id=$1 AND workspace_id=$2`, bid, id)
		if err != nil || len(bs) == 0 {
			return nil, nil, httpx.NotFound("Branch")
		}
		rows, err := a.db.Query(c, `SELECT n.id,n.type,n.title,p.url,coalesce(p.url_normalized,''),
			CASE WHEN n.created_via='mcp' THEN 'AI assistant ('||coalesce(n.client_name,'MCP')||')' ELSE coalesce(u.name,'Unknown') END
			FROM nodes n LEFT JOIN pages p ON p.id=n.page_id LEFT JOIN users u ON u.id=n.created_by
			WHERE n.branch_id=$1 AND n.deleted_at IS NULL AND n.type<>'topic'`, bid)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		var items []compareItem
		for rows.Next() {
			var it compareItem
			if err := rows.Scan(&it.NodeID, &it.Type, &it.Title, &it.URL, &it.norm, &it.AddedBy); err != nil {
				return nil, nil, err
			}
			items = append(items, it)
		}
		return &bs[0], items, rows.Err()
	}
	ba, A, err := load(c.Query("a"))
	if err != nil {
		return err
	}
	bb, B, err := load(c.Query("b"))
	if err != nil {
		return err
	}
	urls := func(xs []compareItem) map[string]bool {
		m := map[string]bool{}
		for _, x := range xs {
			if x.norm != "" {
				m[x.norm] = true
			}
		}
		return m
	}
	ua, ub := urls(A), urls(B)
	res := gin.H{"a": ba, "b": bb, "in_both": []compareItem{}, "only_a": []compareItem{}, "only_b": []compareItem{},
		"findings_a": []compareItem{}, "findings_b": []compareItem{}}
	ids := []string{}
	add := func(k string, it compareItem) { res[k] = append(res[k].([]compareItem), it) }
	for _, x := range A {
		ids = append(ids, x.NodeID)
		switch {
		case x.Type == "page" && ub[x.norm]:
			add("in_both", x)
		case x.Type == "page":
			add("only_a", x)
		case x.Type == "finding" || x.Type == "note":
			add("findings_a", x)
		}
	}
	for _, x := range B {
		ids = append(ids, x.NodeID)
		if x.Type == "page" && !ua[x.norm] {
			add("only_b", x)
		} else if x.Type == "finding" || x.Type == "note" {
			add("findings_b", x)
		}
	}
	confs, err := a.conflictsWhere(c, `WHERE workspace_id=$1 AND (node_a_id = ANY($2) OR node_b_id = ANY($2))`, id, ids)
	if err != nil {
		return err
	}
	res["conflicts"] = confs
	c.JSON(200, res)
	return nil
}

func (a *App) mergeBranch(c *gin.Context) error {
	wsID, err := a.wsOf(c, "branches", c.Param("id"))
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		NodeIDs []string `json:"node_ids"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	u := currentUser(c)
	main, err := a.mainBranch(c, wsID)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(c)
	if err != nil {
		return err
	}
	defer tx.Rollback(c)
	mapping := map[string]string{}
	skipped := 0
	copied := []string{}
	for _, nid := range b.NodeIDs {
		var existing string
		_ = tx.QueryRow(c, `SELECT id FROM nodes WHERE origin_node_id=$1 AND branch_id=$2 AND deleted_at IS NULL`, nid, main).Scan(&existing)
		if existing != "" {
			mapping[nid] = existing
			skipped++
			continue
		}
		var newID string
		err := tx.QueryRow(c, `INSERT INTO nodes (workspace_id,branch_id,type,page_id,origin_node_id,title,body,x,y,width,height,category_id,
			importance,status,why_opened,created_by,created_via,ai_stage,tag_ids,client_name)
			SELECT n.workspace_id,$2,n.type,n.page_id,n.id,n.title,n.body,
			  n.x + coalesce(p.x,0), n.y + coalesce(p.y,0) + 20, n.width,n.height,n.category_id,n.importance,n.status,n.why_opened,n.created_by,
			  n.created_via,n.ai_stage,n.tag_ids,n.client_name
			FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id WHERE n.id=$1 AND n.workspace_id=$3 AND n.deleted_at IS NULL AND n.type<>'topic'
			RETURNING id`, nid, main, wsID).Scan(&newID)
		if err != nil {
			skipped++
			continue
		}
		mapping[nid] = newID
		copied = append(copied, newID)
	}
	edgeIDs := []string{}
	srcIDs := make([]string, 0, len(mapping))
	for k := range mapping {
		srcIDs = append(srcIDs, k)
	}
	rows, err := tx.Query(c, `SELECT id,source_id,target_id FROM edges WHERE workspace_id=$1 AND state<>'rejected' AND (source_id = ANY($2) OR target_id = ANY($2))`, wsID, srcIDs)
	if err != nil {
		return err
	}
	type e3 struct{ id, s, t string }
	var es []e3
	for rows.Next() {
		var e e3
		_ = rows.Scan(&e.id, &e.s, &e.t)
		es = append(es, e)
	}
	rows.Close()
	inMain := func(id string) string {
		if m, ok := mapping[id]; ok {
			return m
		}
		var br string
		_ = tx.QueryRow(c, `SELECT branch_id FROM nodes WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&br)
		if br == main {
			return id
		}
		return ""
	}
	for _, e := range es {
		s, t := inMain(e.s), inMain(e.t)
		if s == "" || t == "" {
			continue
		}
		var nid string
		if err := tx.QueryRow(c, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,label,reason,evidence,confidence,origin,state,locked,created_by,decided_by,client_name)
			SELECT workspace_id,$2,$3,$4,relation,label,reason,evidence,confidence,origin,state,locked,created_by,decided_by,client_name FROM edges WHERE id=$1
			ON CONFLICT (source_id,target_id,relation) DO NOTHING RETURNING id`, e.id, main, s, t).Scan(&nid); err == nil {
			edgeIDs = append(edgeIDs, nid)
		}
	}
	if err := tx.Commit(c); err != nil {
		return err
	}
	for _, id := range copied {
		a.publishNode(c, "node.created", id, &u.ID)
	}
	for _, id := range edgeIDs {
		if e, err := a.loadEdge(c, id); err == nil {
			a.publish(wsID, "edge.created", &u.ID, e)
		}
	}
	a.logEvent(c, wsID, &u.ID, "merged_to_main", gin.H{"branch_id": c.Param("id"), "node_ids": copied})
	c.JSON(200, gin.H{"copied_node_ids": copied, "copied_edge_ids": edgeIDs, "skipped": skipped})
	return nil
}
