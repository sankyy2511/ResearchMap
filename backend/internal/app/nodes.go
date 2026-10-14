package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var nodeTypes = map[string]bool{"page": true, "question": true, "note": true, "finding": true, "topic": true}

var relations = map[string]bool{"answers": true, "subtopic_of": true, "explains": true, "supports": true, "contradicts": true,
	"example_of": true, "prerequisite_of": true, "alternative_to": true, "same_topic": true, "source_of": true,
	"opened_from": true, "links_to": true, "duplicate_of": true}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

/* ---------------------------------------------------------------- nodes */

func (a *App) createNode(c *gin.Context) error {
	var b struct {
		WorkspaceID   string   `json:"workspace_id"`
		Type          string   `json:"type"`
		Title         string   `json:"title"`
		Body          string   `json:"body"`
		X             float64  `json:"x"`
		Y             float64  `json:"y"`
		ParentID      *string  `json:"parent_id"`
		SourceNodeIDs []string `json:"source_node_ids"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if _, err := a.requireWS(c, b.WorkspaceID, "editor"); err != nil {
		return err
	}
	if !nodeTypes[b.Type] {
		return httpx.Validation("Unknown node type")
	}
	b.Title = strings.TrimSpace(b.Title)
	if b.Title == "" {
		if b.Type != "note" {
			return httpx.Validation("Title is required")
		}
		b.Title = "Untitled note"
	}
	if b.ParentID != nil {
		if err := a.checkParent(c, b.WorkspaceID, *b.ParentID, ""); err != nil {
			return err
		}
	}
	u := currentUser(c)
	branch, err := a.writeBranch(c, b.WorkspaceID, u.ID)
	if err != nil {
		return err
	}
	var w, h *float64
	nameLocked := false
	if b.Type == "topic" {
		ww, hh := 560.0, 320.0
		w, h, nameLocked = &ww, &hh, true
		if b.Body == "" {
			b.Body = "#7b5cf0"
		}
	}
	var id string
	if err := a.db.QueryRow(c, `INSERT INTO nodes (workspace_id,branch_id,type,title,body,x,y,width,height,parent_id,created_by,created_via,
		position_locked,group_locked,name_locked) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',true,$12,$13) RETURNING id`,
		b.WorkspaceID, branch, b.Type, b.Title, b.Body, b.X, b.Y, w, h, b.ParentID, u.ID, b.ParentID != nil, nameLocked).Scan(&id); err != nil {
		return err
	}
	for _, sid := range b.SourceNodeIDs {
		var eid string
		err := a.db.QueryRow(c, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,reason,confidence,origin,state,locked,created_by,decided_by)
			SELECT $1,$2,n.id,$3,'supports','Linked by you as supporting evidence.',1,'user','accepted',true,$4,$4 FROM nodes n
			WHERE n.id=$5 AND n.workspace_id=$1 AND n.deleted_at IS NULL ON CONFLICT DO NOTHING RETURNING id`,
			b.WorkspaceID, branch, id, u.ID, sid).Scan(&eid)
		if err == nil {
			if e, err := a.loadEdge(c, eid); err == nil {
				a.publish(b.WorkspaceID, "edge.created", &u.ID, e)
			}
		}
	}
	a.logEvent(c, b.WorkspaceID, &u.ID, "node_added", gin.H{"node_id": id, "type": b.Type})
	a.touch(c, b.WorkspaceID)
	n := a.publishNode(c, "node.created", id, &u.ID)
	c.JSON(201, n)
	return nil
}

func (a *App) checkParent(c *gin.Context, wsID, parentID, self string) error {
	var ok bool
	_ = a.db.QueryRow(c, `SELECT EXISTS(SELECT 1 FROM nodes WHERE id=$1 AND workspace_id=$2 AND type='topic' AND deleted_at IS NULL)`, parentID, wsID).Scan(&ok)
	if !ok || parentID == self {
		return httpx.Validation("Parent must be a topic group in this workspace")
	}
	return nil
}

// updateNode applies a partial update with strict optimistic concurrency (409 + latest node on a stale version).
func (a *App) updateNode(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "nodes", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := bind(c, &raw); err != nil {
		return err
	}
	var version int32
	if err := json.Unmarshal(raw["version"], &version); err != nil {
		return httpx.Validation("version is required")
	}
	cur, err := a.loadNode(c, id)
	if err != nil {
		return httpx.NotFound("Node")
	}
	cols := map[string]string{"title": "title", "body": "body", "x": "x", "y": "y", "width": "width", "height": "height",
		"collapsed": "collapsed", "parent_id": "parent_id", "category_id": "category_id", "importance": "importance", "status": "status",
		"position_locked": "position_locked", "group_locked": "group_locked", "name_locked": "name_locked", "why_opened": "why_opened"}
	sets := []string{}
	args := []any{id, version}
	for k, col := range cols {
		v, ok := raw[k]
		if !ok {
			continue
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			return httpx.Validation("Invalid value for " + k)
		}
		switch k {
		case "title":
			s, _ := val.(string)
			if strings.TrimSpace(s) == "" {
				return httpx.Validation("Title cannot be empty")
			}
		case "status":
			if s, _ := val.(string); s != "active" && s != "inbox" {
				return httpx.Validation("Invalid status")
			}
		case "parent_id":
			if s, ok := val.(string); ok {
				if err := a.checkParent(c, wsID, s, id); err != nil {
					return err
				}
			}
		case "category_id":
			if s, ok := val.(string); ok {
				var exists bool
				_ = a.db.QueryRow(c, `SELECT EXISTS(SELECT 1 FROM categories WHERE id=$1 AND workspace_id=$2)`, s, wsID).Scan(&exists)
				if !exists {
					return httpx.Validation("Unknown category")
				}
			}
		case "why_opened":
			val = []byte(v)
		}
		args = append(args, val)
		sets = append(sets, fmt.Sprintf("%s=$%d", col, len(args)))
	}
	if _, ok := raw["x"]; ok {
		sets = append(sets, "position_locked=true")
	} else if _, ok := raw["y"]; ok {
		sets = append(sets, "position_locked=true")
	}
	if v, ok := raw["parent_id"]; ok && string(v) != jsonStr(cur.ParentID) {
		sets = append(sets, "group_locked=true")
	}
	if _, ok := raw["title"]; ok && cur.Type == "topic" {
		sets = append(sets, "name_locked=true")
	}
	if len(sets) == 0 {
		c.JSON(200, cur)
		return nil
	}
	tag, err := a.db.Exec(c, "UPDATE nodes SET "+strings.Join(sets, ",")+", version=version+1, updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL", args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.Conflict("This node was updated by someone else. Showing the latest version.", cur)
	}
	a.touch(c, wsID)
	n := a.publishNode(c, "node.updated", id, &currentUser(c).ID)
	c.JSON(200, n)
	return nil
}

func jsonStr(s *string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func (a *App) deleteNode(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "nodes", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	u := currentUser(c)
	rows, err := a.db.Query(c, `UPDATE nodes ch SET x=ch.x+t.x, y=ch.y+t.y, parent_id=NULL, version=ch.version+1, updated_at=now()
		FROM nodes t WHERE t.id=$1 AND t.type='topic' AND ch.parent_id=t.id AND ch.deleted_at IS NULL RETURNING ch.id`, id)
	if err != nil {
		return err
	}
	children, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `UPDATE nodes SET deleted_at=now(), version=version+1 WHERE id=$1`, id); err != nil {
		return err
	}
	for _, ch := range children {
		a.publishNode(c, "node.updated", ch, &u.ID)
	}
	a.publish(wsID, "node.deleted", &u.ID, gin.H{"id": id})
	a.logEvent(c, wsID, &u.ID, "node_deleted", gin.H{"node_id": id})
	c.Status(204)
	return nil
}

func (a *App) restoreNode(c *gin.Context) error {
	id := c.Param("id")
	var wsID string
	if err := a.db.QueryRow(c, `SELECT workspace_id FROM nodes WHERE id=$1`, id).Scan(&wsID); err != nil {
		return httpx.NotFound("Node")
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `UPDATE nodes SET deleted_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	n := a.publishNode(c, "node.created", id, &currentUser(c).ID)
	c.JSON(200, n)
	return nil
}

func (a *App) savePositions(c *gin.Context) error {
	var b struct {
		Positions []struct {
			ID       string          `json:"id"`
			X        float64         `json:"x"`
			Y        float64         `json:"y"`
			ParentID json.RawMessage `json:"parent_id"`
		} `json:"positions"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if len(b.Positions) > 1000 {
		return httpx.Validation("Too many positions")
	}
	u := currentUser(c)
	checked := map[string]bool{}
	for _, p := range b.Positions {
		wsID, err := a.wsOf(c, "nodes", p.ID)
		if err != nil {
			continue
		}
		if !checked[wsID] {
			if _, err := a.requireWS(c, wsID, "editor"); err != nil {
				return err
			}
			checked[wsID] = true
		}
		if len(p.ParentID) > 0 {
			var parent *string
			_ = json.Unmarshal(p.ParentID, &parent)
			if parent != nil {
				if err := a.checkParent(c, wsID, *parent, p.ID); err != nil {
					return err
				}
			}
			_, err = a.db.Exec(c, `UPDATE nodes SET x=$2,y=$3, group_locked = group_locked OR parent_id IS DISTINCT FROM $4, parent_id=$4,
				position_locked=true, version=version+1, updated_at=now() WHERE id=$1`, p.ID, p.X, p.Y, parent)
		} else {
			_, err = a.db.Exec(c, `UPDATE nodes SET x=$2,y=$3, position_locked=true, version=version+1, updated_at=now() WHERE id=$1`, p.ID, p.X, p.Y)
		}
		if err != nil {
			return err
		}
		a.publishNode(c, "node.updated", p.ID, &u.ID)
	}
	c.Status(204)
	return nil
}

func (a *App) mergeNode(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "nodes", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		IntoNodeID string `json:"into_node_id"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	into, err := a.wsOf(c, "nodes", b.IntoNodeID)
	if err != nil || into != wsID || b.IntoNodeID == id {
		return httpx.NotFound("Target node")
	}
	tx, err := a.db.Begin(c)
	if err != nil {
		return err
	}
	defer tx.Rollback(c)
	stmts := []string{
		`UPDATE annotations SET node_id=$2 WHERE node_id=$1`,
		`UPDATE nodes SET tag_ids = ARRAY(SELECT DISTINCT unnest(tag_ids || (SELECT tag_ids FROM nodes WHERE id=$1))), duplicate_of=NULL, version=version+1 WHERE id=$2`,
		`UPDATE edges SET source_id=$2 WHERE source_id=$1 AND target_id<>$2 AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.source_id=$2 AND x.target_id=edges.target_id AND x.relation=edges.relation)`,
		`UPDATE edges SET target_id=$2 WHERE target_id=$1 AND source_id<>$2 AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.target_id=$2 AND x.source_id=edges.source_id AND x.relation=edges.relation)`,
		`DELETE FROM edges WHERE source_id=$1 OR target_id=$1`,
		`UPDATE nodes SET deleted_at=now() WHERE id=$1`,
	}
	for _, s := range stmts {
		if _, err := tx.Exec(c, s, id, b.IntoNodeID); err != nil {
			return err
		}
	}
	if err := tx.Commit(c); err != nil {
		return err
	}
	u := currentUser(c)
	a.publish(wsID, "node.deleted", &u.ID, gin.H{"id": id})
	n := a.publishNode(c, "node.updated", b.IntoNodeID, &u.ID)
	c.JSON(200, n)
	return nil
}

func (a *App) setNodeTags(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "nodes", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		TagIDs []string `json:"tag_ids"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `UPDATE nodes SET tag_ids = ARRAY(SELECT DISTINCT t.id FROM tags t WHERE t.workspace_id=$2 AND t.id = ANY($3)),
		version=version+1, updated_at=now() WHERE id=$1`, id, wsID, b.TagIDs); err != nil {
		return err
	}
	n := a.publishNode(c, "node.updated", id, &currentUser(c).ID)
	c.JSON(200, n)
	return nil
}

/* ---------------------------------------------------------------- edges */

func (a *App) createEdge(c *gin.Context) error {
	var b struct {
		WorkspaceID string `json:"workspace_id"`
		SourceID    string `json:"source_id"`
		TargetID    string `json:"target_id"`
		Relation    string `json:"relation"`
		Reason      string `json:"reason"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if _, err := a.requireWS(c, b.WorkspaceID, "editor"); err != nil {
		return err
	}
	if !relations[b.Relation] {
		return httpx.Validation("Unknown relation")
	}
	if b.SourceID == b.TargetID {
		return httpx.BadRequest("A node cannot connect to itself")
	}
	for _, nid := range []string{b.SourceID, b.TargetID} {
		if ws, err := a.wsOf(c, "nodes", nid); err != nil || ws != b.WorkspaceID {
			return httpx.NotFound("Node")
		}
	}
	u := currentUser(c)
	branch, err := a.writeBranch(c, b.WorkspaceID, u.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(b.Reason) == "" {
		b.Reason = "Connected by you."
	}
	var id string
	err = a.db.QueryRow(c, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,reason,confidence,origin,state,locked,created_by,decided_by)
		VALUES ($1,$2,$3,$4,$5,$6,1,'user','accepted',true,$7,$7)
		ON CONFLICT (source_id,target_id,relation) DO UPDATE SET state='accepted', origin='user', locked=true, reason=EXCLUDED.reason,
		  decided_by=EXCLUDED.decided_by, version=edges.version+1, updated_at=now() WHERE edges.state='rejected'
		RETURNING id`, b.WorkspaceID, branch, b.SourceID, b.TargetID, b.Relation, b.Reason, u.ID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NewError(409, httpx.CodeConflict, "These nodes already have this connection")
	}
	if err != nil {
		return err
	}
	e, err := a.loadEdge(c, id)
	if err != nil {
		return err
	}
	a.logEvent(c, b.WorkspaceID, &u.ID, "edge_created", gin.H{"edge_id": id})
	a.publish(b.WorkspaceID, "edge.created", &u.ID, e)
	c.JSON(201, e)
	return nil
}

func (a *App) updateEdge(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "edges", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		State    *string         `json:"state"`
		Relation *string         `json:"relation"`
		Reason   *string         `json:"reason"`
		Label    json.RawMessage `json:"label"`
		Version  int32           `json:"version"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.State != nil && *b.State != "suggested" && *b.State != "accepted" && *b.State != "rejected" {
		return httpx.Validation("Invalid state")
	}
	if b.Relation != nil && !relations[*b.Relation] {
		return httpx.Validation("Unknown relation")
	}
	var label *string
	setLabel := len(b.Label) > 0
	if setLabel {
		_ = json.Unmarshal(b.Label, &label)
	}
	u := currentUser(c)
	tag, err := a.db.Exec(c, `UPDATE edges SET
		state = CASE WHEN $3::text IS NOT NULL THEN $3 WHEN $4::text IS NOT NULL AND state='suggested' THEN 'accepted' ELSE state END,
		relation = coalesce($4, relation), reason = coalesce($5, reason),
		label = CASE WHEN $6 THEN $7 ELSE label END,
		locked=true, decided_by=$8, version=version+1, updated_at=now()
		WHERE id=$1 AND version=$2`, id, b.Version, b.State, b.Relation, b.Reason, setLabel, label, u.ID)
	if isUnique(err) {
		return httpx.NewError(409, httpx.CodeConflict, "These nodes already have this connection")
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		latest, _ := a.loadEdge(c, id)
		return httpx.Conflict("This connection was updated by someone else. Showing the latest version.", latest)
	}
	e, err := a.loadEdge(c, id)
	if err != nil {
		return err
	}
	a.logEvent(c, wsID, &u.ID, "edge_"+e.State, gin.H{"edge_id": id})
	a.publish(wsID, "edge.updated", &u.ID, e)
	c.JSON(200, e)
	return nil
}

func (a *App) deleteEdge(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "edges", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `DELETE FROM edges WHERE id=$1`, id); err != nil {
		return err
	}
	a.publish(wsID, "edge.deleted", &currentUser(c).ID, gin.H{"id": id})
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- annotations */

func textFragmentURL(pageURL, quote string) string {
	words := strings.Fields(quote)
	text := url.PathEscape(strings.Join(words, " "))
	if len(words) > 8 {
		text = url.PathEscape(strings.Join(words[:4], " ")) + "," + url.PathEscape(strings.Join(words[len(words)-4:], " "))
	}
	return strings.SplitN(pageURL, "#", 2)[0] + "#:~:text=" + text
}

type annotationInput struct {
	Kind        string  `json:"kind"`
	Body        string  `json:"body"`
	Quote       *string `json:"quote"`
	FragmentURL *string `json:"fragment_url"`
	ParentID    *string `json:"parent_id"`
}

func (a *App) createAnnotation(c *gin.Context, wsID, nodeID string, in annotationInput) (*Annotation, error) {
	if in.Kind != "note" && in.Kind != "highlight" && in.Kind != "comment" {
		return nil, httpx.Validation("Unknown annotation kind")
	}
	if in.Kind != "highlight" && strings.TrimSpace(in.Body) == "" {
		return nil, httpx.Validation("Write something first")
	}
	if len(in.Body) > 20000 {
		return nil, httpx.Validation("Text is too long")
	}
	if in.FragmentURL == nil && in.Quote != nil {
		var pageURL string
		if a.db.QueryRow(c, `SELECT p.url FROM nodes n JOIN pages p ON p.id=n.page_id WHERE n.id=$1`, nodeID).Scan(&pageURL) == nil {
			in.FragmentURL = sp(textFragmentURL(pageURL, *in.Quote))
		}
	}
	u := currentUser(c)
	var id string
	if err := a.db.QueryRow(c, `INSERT INTO annotations (workspace_id,node_id,kind,body,quote,fragment_url,parent_id,author_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, wsID, nodeID, in.Kind, in.Body, in.Quote, in.FragmentURL, in.ParentID, u.ID).Scan(&id); err != nil {
		return nil, err
	}
	an, err := a.loadAnnotation(c, id)
	if err != nil {
		return nil, err
	}
	a.logEvent(c, wsID, &u.ID, in.Kind+"_added", gin.H{"node_id": nodeID})
	a.publish(wsID, "annotation.created", &u.ID, an)
	return an, nil
}

func (a *App) createAnnotationH(c *gin.Context) error {
	nodeID := c.Param("id")
	wsID, err := a.wsOf(c, "nodes", nodeID)
	if err != nil {
		return err
	}
	role, err := a.requireWS(c, wsID, "viewer")
	if err != nil {
		return err
	}
	var in annotationInput
	if err := bind(c, &in); err != nil {
		return err
	}
	if role == "viewer" && in.Kind != "comment" {
		return httpx.Forbidden("Viewers can only comment")
	}
	an, err := a.createAnnotation(c, wsID, nodeID, in)
	if err != nil {
		return err
	}
	c.JSON(201, an)
	return nil
}

func (a *App) updateAnnotation(c *gin.Context) error {
	id := c.Param("id")
	an, err := a.loadAnnotation(c, id)
	if err != nil {
		return httpx.NotFound("Annotation")
	}
	if _, err := a.requireWS(c, an.WorkspaceID, "viewer"); err != nil {
		return err
	}
	var b struct {
		Body     *string `json:"body"`
		Resolved *bool   `json:"resolved"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	u := currentUser(c)
	if b.Body != nil && an.AuthorID != u.ID {
		return httpx.Forbidden("You can only edit your own notes")
	}
	if _, err := a.db.Exec(c, `UPDATE annotations SET body=coalesce($2,body), resolved=coalesce($3,resolved), updated_at=now() WHERE id=$1`, id, b.Body, b.Resolved); err != nil {
		return err
	}
	an, _ = a.loadAnnotation(c, id)
	a.publish(an.WorkspaceID, "annotation.updated", &u.ID, an)
	c.JSON(200, an)
	return nil
}

func (a *App) deleteAnnotation(c *gin.Context) error {
	id := c.Param("id")
	an, err := a.loadAnnotation(c, id)
	if err != nil {
		return httpx.NotFound("Annotation")
	}
	u := currentUser(c)
	min := "viewer"
	if an.AuthorID != u.ID {
		min = "editor"
	}
	if _, err := a.requireWS(c, an.WorkspaceID, min); err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `DELETE FROM annotations WHERE id=$1`, id); err != nil {
		return err
	}
	a.publish(an.WorkspaceID, "annotation.deleted", &u.ID, gin.H{"id": id, "node_id": an.NodeID})
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- tags + categories */

var tagColors = []string{"#7b5cf0", "#f08a6c", "#a86f00", "#3f8a2e", "#2f6fbf", "#c9544f"}

func (a *App) listTags(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	ts, err := collect[Tag](c, a.db, `SELECT id,workspace_id,name,color FROM tags WHERE workspace_id=$1 ORDER BY name`, c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, ts)
	return nil
}

func (a *App) createTag(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		Name  string  `json:"name"`
		Color *string `json:"color"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" || len(b.Name) > 40 {
		return httpx.Validation("Tag name is required")
	}
	var n int
	_ = a.db.QueryRow(c, `SELECT count(*) FROM tags WHERE workspace_id=$1`, wsID).Scan(&n)
	color := tagColors[n%len(tagColors)]
	if b.Color != nil && *b.Color != "" {
		color = *b.Color
	}
	_, err := a.db.Exec(c, `INSERT INTO tags (workspace_id,name,color) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, lower(name)) DO NOTHING`, wsID, b.Name, color)
	if err != nil {
		return err
	}
	ts, err := collect[Tag](c, a.db, `SELECT id,workspace_id,name,color FROM tags WHERE workspace_id=$1 AND lower(name)=lower($2)`, wsID, b.Name)
	if err != nil || len(ts) == 0 {
		return err
	}
	all, _ := collect[Tag](c, a.db, `SELECT id,workspace_id,name,color FROM tags WHERE workspace_id=$1 ORDER BY name`, wsID)
	a.publish(wsID, "tags.updated", &currentUser(c).ID, all)
	c.JSON(200, ts[0])
	return nil
}

func (a *App) listCategories(c *gin.Context) error {
	if _, err := a.requireWS(c, c.Param("id"), "viewer"); err != nil {
		return err
	}
	cs, err := collect[Category](c, a.db, `SELECT id,workspace_id,kind,name,color FROM categories WHERE workspace_id=$1`, c.Param("id"))
	if err != nil {
		return err
	}
	c.JSON(200, cs)
	return nil
}

func (a *App) createCategory(c *gin.Context) error {
	wsID := c.Param("id")
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct{ Kind, Name, Color string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" {
		return httpx.Validation("Category name is required")
	}
	switch b.Kind {
	case "topic", "source", "importance", "custom":
	default:
		return httpx.Validation("Unknown category kind")
	}
	if b.Color == "" {
		b.Color = "#7b5cf0"
	}
	cs, err := collect[Category](c, a.db, `INSERT INTO categories (workspace_id,kind,name,color) VALUES ($1,$2,$3,$4) RETURNING id,workspace_id,kind,name,color`, wsID, b.Kind, b.Name, b.Color)
	if err != nil {
		return err
	}
	a.publishCategories(c, wsID)
	c.JSON(201, cs[0])
	return nil
}

func (a *App) updateCategory(c *gin.Context) error {
	id := c.Param("id")
	wsID, err := a.wsOf(c, "categories", id)
	if err != nil {
		return err
	}
	if _, err := a.requireWS(c, wsID, "editor"); err != nil {
		return err
	}
	var b struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	cs, err := collect[Category](c, a.db, `UPDATE categories SET name=coalesce(nullif(trim($2),''),name), color=coalesce($3,color) WHERE id=$1
		RETURNING id,workspace_id,kind,name,color`, id, b.Name, b.Color)
	if err != nil {
		return err
	}
	a.publishCategories(c, wsID)
	c.JSON(200, cs[0])
	return nil
}

func (a *App) publishCategories(c *gin.Context, wsID string) {
	all, _ := collect[Category](c, a.db, `SELECT id,workspace_id,kind,name,color FROM categories WHERE workspace_id=$1`, wsID)
	a.publish(wsID, "categories.updated", &currentUser(c).ID, all)
}
