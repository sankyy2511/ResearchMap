package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP server (spec §18): AI clients such as Gemini CLI use an MCP token. Everything they add goes into the workspace's
// "AI Agent" branch with created_via = 'mcp' and the client's name, so a human reviews it before copying to Main.
// Writes reuse the normal services (ingestPage → Agent 1 → Agent 2 → Agent 3) and broadcast WebSocket events.

type out struct {
	Result any `json:"result"`
}

func (a *App) mcpRole(ctx context.Context, wsID, userID string) (string, error) {
	var role string
	err := a.db.QueryRow(ctx, `SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.workspace_id=$1 AND m.user_id=$2 AND w.deleted_at IS NULL`, wsID, userID).Scan(&role)
	if err != nil {
		return "", errors.New("workspace not found or you are not a member")
	}
	return role, nil
}

func (a *App) mcpWrite(ctx context.Context, wsID, userID string) error {
	role, err := a.mcpRole(ctx, wsID, userID)
	if err != nil {
		return err
	}
	if roleRank[role] < roleRank["editor"] {
		return errors.New("viewers cannot add research")
	}
	return nil
}

// agentBranches caches workspace id → AI Agent branch id (created with the workspace and never changed), which saves a
// database round trip on every MCP write.
var agentBranches sync.Map

func (a *App) agentBranch(ctx context.Context, wsID string) string {
	if v, ok := agentBranches.Load(wsID); ok {
		return v.(string)
	}
	var id string
	_ = a.db.QueryRow(ctx, `SELECT id FROM branches WHERE workspace_id=$1 AND kind='agent'`, wsID).Scan(&id)
	if id != "" {
		agentBranches.Store(wsID, id)
	}
	return id
}

// mcpAgentSession finds or starts an active research session on the AI Agent branch.
func (a *App) mcpAgentSession(ctx context.Context, u *User, wsID, client string) (*Session, error) {
	branch := a.agentBranch(ctx, wsID)
	if branch == "" {
		return nil, errors.New("workspace has no AI Agent branch")
	}
	title := "AI assistant (" + client + ")"
	var sid string
	err := a.db.QueryRow(ctx, `SELECT id FROM sessions WHERE workspace_id=$1 AND user_id=$2 AND branch_id=$3 AND state='active' ORDER BY started_at DESC LIMIT 1`,
		wsID, u.ID, branch).Scan(&sid)
	if err != nil {
		err = a.db.QueryRow(ctx, `INSERT INTO sessions (workspace_id,user_id,branch_id,title,state) VALUES ($1,$2,$3,$4,'active') RETURNING id`,
			wsID, u.ID, branch, title).Scan(&sid)
		if err != nil {
			return nil, err
		}
	}
	return a.loadSession(ctx, sid)
}

func ok[T any](v T) (*mcp.CallToolResult, out, error) { return nil, out{v}, nil }

// clientName is the MCP client's self-reported name from the initialize handshake (e.g. "gemini-cli-mcp-client").
func clientName(req *mcp.CallToolRequest) string {
	if req != nil && req.Session != nil {
		if p := req.Session.InitializeParams(); p != nil && p.ClientInfo != nil {
			if n := strings.TrimSpace(p.ClientInfo.Name); n != "" {
				return truncateRunes(n, 60)
			}
		}
	}
	return "MCP"
}

// nodeInWorkspace loads a node and checks that the MCP user may read (or write) its workspace.
func (a *App) mcpNode(ctx context.Context, nodeID, userID string, write bool) (*Node, error) {
	n, err := a.loadNode(ctx, nodeID)
	if err != nil {
		return nil, fmt.Errorf("node %q not found", nodeID)
	}
	if write {
		err = a.mcpWrite(ctx, n.WorkspaceID, userID)
	} else {
		_, err = a.mcpRole(ctx, n.WorkspaceID, userID)
	}
	if err != nil {
		return nil, err
	}
	return n, nil
}

// absPos is a node's absolute canvas position (children of topics store positions relative to the topic).
func (a *App) absPos(ctx context.Context, nodeID string) (float64, float64, bool) {
	var x, y float64
	err := a.db.QueryRow(ctx, `SELECT n.x + coalesce(p.x,0), n.y + coalesce(p.y,0) FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id WHERE n.id=$1`, nodeID).Scan(&x, &y)
	return x, y, err == nil
}

// mcpCreateNode inserts a question/note/finding node in the AI Agent branch and broadcasts node.created.
func (a *App) mcpCreateNode(ctx context.Context, u *User, wsID, typ, title, body, client string, near []string) (string, error) {
	branch := a.agentBranch(ctx, wsID)
	if branch == "" {
		return "", errors.New("workspace has no AI Agent branch")
	}
	x, y := 0.0, 0.0
	placed := false
	if len(near) > 0 { // next to its first source, offset by how many AI nodes already sit there
		if sx, sy, ok := a.absPos(ctx, near[0]); ok {
			var n int
			_ = a.db.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND created_via='mcp' AND type=$2 AND deleted_at IS NULL`, wsID, typ).Scan(&n)
			x, y, placed = sx+380, sy+float64(n%4)*170, true
		}
	}
	if !placed {
		var minX *float64
		var n int
		_ = a.db.QueryRow(ctx, `SELECT min(x), (SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type=$2 AND deleted_at IS NULL)
			FROM nodes WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL`, wsID, typ).Scan(&minX, &n)
		if minX != nil {
			x = *minX - 360
		}
		y = float64(n%8) * 170
	}
	var id string
	err := a.db.QueryRow(ctx, `INSERT INTO nodes (workspace_id,branch_id,type,title,body,x,y,created_by,created_via,client_name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mcp',$9) RETURNING id`, wsID, branch, typ, title, body, x, y, u.ID, client).Scan(&id)
	if err != nil {
		slog.Warn("[MCP] create node failed", "type", typ, "err", err)
		return "", errors.New("could not save the node")
	}
	a.publishNode(ctx, "node.created", id, &u.ID)
	go func() { // bookkeeping off the response path (the database is remote)
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		a.logEvent(bg, wsID, &u.ID, typ+"_added", gin.H{"node_id": id, "title": title, "via": "mcp", "client": client})
		a.touch(bg, wsID)
	}()
	return id, nil
}

func (a *App) mcpServer(u *User) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "research-map", Version: "1.2.0"}, &mcp.ServerOptions{Instructions: mcpInstructions,
		// Ping idle sessions: Node-based clients (Gemini CLI) drop a stream with no data for 5 min and report "MCP ERROR".
		KeepAlive: 30 * time.Second, KeepAliveFailureThreshold: 3})

	// Each MCP session remembers its research workspace, so after start_research every tool works without workspace_id.
	// It also caches lookups that rarely change (access checks for 30 s, the agent session, question nodes, blocklist):
	// the database is remote, and an assistant adding sources while it researches should see each call return fast.
	var mu sync.Mutex
	current := ""
	checked := map[string]time.Time{} // wsID|w or wsID|r → access verified until
	agentSessions := map[string]*Session{}
	questions := map[string]string{} // wsID|lower(question) → node id
	blocklists := map[string][]string{}
	setCurrent := func(id string) { mu.Lock(); current = id; mu.Unlock() }
	agentSession := func(ctx context.Context, wsID, client string) *Session {
		mu.Lock()
		se := agentSessions[wsID]
		mu.Unlock()
		if se != nil {
			return se
		}
		se, err := a.mcpAgentSession(ctx, u, wsID, client)
		if err != nil {
			return nil
		}
		mu.Lock()
		agentSessions[wsID] = se
		mu.Unlock()
		return se
	}
	question := func(ctx context.Context, wsID, q, client string) (string, bool, error) {
		key := wsID + "|" + strings.ToLower(q)
		mu.Lock()
		id := questions[key]
		mu.Unlock()
		if id != "" {
			return id, false, nil
		}
		id, isNew, err := a.mcpQuestion(ctx, u, wsID, q, client)
		if err == nil {
			mu.Lock()
			questions[key] = id
			mu.Unlock()
		}
		return id, isNew, err
	}
	isBlocked := func(ctx context.Context, wsID, domain string) bool {
		mu.Lock()
		list, ok := blocklists[wsID]
		mu.Unlock()
		if !ok {
			list = a.blocklist(ctx, wsID)
			mu.Lock()
			blocklists[wsID] = list
			mu.Unlock()
		}
		return blockedIn(list, domain)
	}
	// ws resolves the workspace a tool acts on: the explicit id, else this session's workspace, else the workspace the
	// user opened most recently (what they are probably looking at), else (for writes) a fresh "AI research" workspace.
	ws := func(ctx context.Context, id string, write bool) (string, error) {
		mu.Lock()
		cur := current
		mu.Unlock()
		if id = strings.TrimSpace(id); id == "" {
			id = cur
		}
		key := id + "|r"
		if write {
			key = id + "|w"
		}
		mu.Lock()
		fresh := id != "" && time.Now().Before(checked[key])
		mu.Unlock()
		if fresh {
			setCurrent(id)
			return id, nil
		}
		if id == "" {
			_ = a.db.QueryRow(ctx, `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
				WHERE m.user_id=$1 AND w.deleted_at IS NULL AND ($2 OR m.role IN ('owner','editor'))
				ORDER BY coalesce(m.last_opened_at, w.updated_at) DESC LIMIT 1`, u.ID, !write).Scan(&id)
		}
		if id == "" {
			if !write {
				return "", errors.New("you have no workspaces yet; call start_research first")
			}
			nid, isNew, err := a.mcpStartWorkspace(ctx, u, "AI research", "MCP")
			if err != nil {
				return "", err
			}
			a.announceResearch(ctx, u, nid, isNew, "AI research", "MCP")
			id = nid
		}
		var err error
		if write {
			err = a.mcpWrite(ctx, id, u.ID)
		} else {
			_, err = a.mcpRole(ctx, id, u.ID)
		}
		if err != nil {
			return "", err
		}
		mu.Lock()
		current = id
		checked[key] = time.Now().Add(30 * time.Second)
		if write { // write access implies read access
			checked[id+"|r"] = checked[key]
		}
		mu.Unlock()
		return id, nil
	}
	type wsIn struct {
		WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the workspace from start_research"`
	}

	addTool(s, &mcp.Tool{Name: "start_research", Description: "CALL THIS FIRST whenever the user asks you to research, investigate, compare or " +
		"learn about any topic. Creates a new research workspace named after the topic (or reuses one with the same name), adds the topic " +
		"as a Question node and opens it live in the user's Research Map app. Returns workspace_id; every other tool then defaults to it. " +
		"After this: search the web with your own tool and call add_source for EVERY useful page as soon as you find it (do not wait until the end), " +
		"then add_finding for your conclusions."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			Topic          string `json:"topic" jsonschema:"the research topic or question, e.g. 'Best electric car models in 2026'"`
			WorkspaceTitle string `json:"workspace_title,omitempty" jsonschema:"optional short workspace name; defaults to the topic"`
			WorkspaceID    string `json:"workspace_id,omitempty" jsonschema:"optional: research inside this existing workspace instead of creating one"`
			SeedSources    *bool  `json:"seed_sources,omitempty" jsonschema:"optional, default true: the server also adds a few Wikipedia background sources"`
			Goal           string `json:"goal,omitempty" jsonschema:"optional: what the user wants to finish, in their words, e.g. 'Pick a CRM for a 20-person sales team'. Shown in the app and used in the session report"`
		}) (*mcp.CallToolResult, out, error) {
			topic := truncateRunes(strings.TrimSpace(in.Topic), 300)
			if topic == "" {
				return nil, out{}, errors.New("topic is empty")
			}
			client := clientName(req)
			wsID, isNew := strings.TrimSpace(in.WorkspaceID), false
			if wsID == "" {
				title := strings.TrimSpace(in.WorkspaceTitle)
				if title == "" {
					title = topic
				}
				var err error
				if wsID, isNew, err = a.mcpStartWorkspace(ctx, u, truncateRunes(title, 120), client); err != nil {
					return nil, out{}, err
				}
			}
			if _, err := ws(ctx, wsID, true); err != nil {
				return nil, out{}, err
			}
			// Open the workspace in the user's browser right away; the question node streams in over its socket.
			go a.announceResearch(context.Background(), u, wsID, isNew, topic, client)
			qid, _, err := question(ctx, wsID, topic, client)
			if err != nil {
				return nil, out{}, err
			}
			se := agentSession(ctx, wsID, client)
			if goal := strings.TrimSpace(in.Goal); goal != "" && se != nil {
				if err := a.setGoal(ctx, se, goal, &u.ID); err != nil {
					return nil, out{}, errors.New("could not save the goal")
				}
			}
			url := a.appURL() + "/w/" + wsID
			// Seed background sources from Wikipedia so the map fills even when the assistant's own web search is
			// rate-limited (common on free tiers). Only for a workspace without sources yet; runs after we answer.
			seeding := in.SeedSources == nil || *in.SeedSources
			if seeding {
				var pages int
				_ = a.db.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE workspace_id=$1 AND type='page' AND deleted_at IS NULL`, wsID).Scan(&pages)
				seeding = pages == 0
			}
			if seeding {
				go a.seedWikipedia(u, wsID, topic, se)
			}
			return ok(gin.H{"workspace_id": wsID, "workspace_url": url, "created": isNew, "question_node_id": qid, "background_sources": seeding,
				"next": "Search the web now. For each useful page call add_source (url, title, content = key text, question = the search query). " +
					"Then add_finding (statement, details, source_node_ids). If your web search fails or is rate-limited, do not retry it: " +
					"call add_source with the official website of each option you already know (for example a product's pricing or features page); " +
					"the server reads each page itself. The server also adds Wikipedia background sources in a few seconds (see get_graph_outline), " +
					"and you can cite their ids in add_finding. workspace_id is optional from here on. " +
					"Tell the user they can watch live at " + url})
		})

	addTool(s, &mcp.Tool{Name: "list_workspaces", Description: "List research workspaces you can access (id, title, your role). " +
		"Not required before writing: start_research creates/selects a workspace, and tools without workspace_id use the current one."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, out, error) {
			rows, err := a.db.Query(ctx, `SELECT w.id, w.title, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
				WHERE m.user_id=$1 AND w.deleted_at IS NULL ORDER BY w.updated_at DESC`, u.ID)
			if err != nil {
				return nil, out{}, errors.New("could not list workspaces")
			}
			defer rows.Close()
			list := []gin.H{}
			for rows.Next() {
				var id, t, r string
				if rows.Scan(&id, &t, &r) == nil {
					list = append(list, gin.H{"id": id, "title": t, "role": r, "can_write": roleRank[r] >= roleRank["editor"]})
				}
			}
			return ok(list)
		})

	addTool(s, &mcp.Tool{Name: "search_workspace", Description: "Hybrid search (full text + fuzzy + meaning) over pages, notes, highlights, questions, findings and topics."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in struct {
			WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the current research workspace"`
			Query       string `json:"query"`
		}) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, false)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			q := truncateRunes(strings.TrimSpace(in.Query), 300)
			if q == "" {
				return nil, out{}, errors.New("query is empty")
			}
			res := a.hybridSearch(ctx, in.WorkspaceID, q, searchFilters{})
			if len(res) > 20 {
				res = res[:20]
			}
			return ok(res)
		})

	addTool(s, &mcp.Tool{Name: "get_node", Description: "Get a node with its page summary, notes and explained connections."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in struct {
			NodeID string `json:"node_id"`
		}) (*mcp.CallToolResult, out, error) {
			n, err := a.mcpNode(ctx, in.NodeID, u.ID, false)
			if err != nil {
				return nil, out{}, err
			}
			res := gin.H{"node": n}
			if n.PageID != nil {
				if p, err := a.loadPage(ctx, *n.PageID); err == nil {
					res["page"] = p
				}
			}
			res["notes"], _ = collect[Annotation](ctx, a.db, annotationSelect+"WHERE a.node_id=$1", n.ID)
			res["connections"], _ = collect[Edge](ctx, a.db, edgeSelect+"WHERE (e.source_id=$1 OR e.target_id=$1) AND e.state<>'rejected'", n.ID)
			return ok(res)
		})

	addTool(s, &mcp.Tool{Name: "get_graph_outline", Description: "Compact outline: topic groups and the pages, questions and findings inside them, with node ids."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in wsIn) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, false)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			rows, err := a.db.Query(ctx, `SELECT coalesce(t.title,'Unsorted'), n.id, n.type, n.title, b.kind FROM nodes n LEFT JOIN nodes t ON t.id=n.parent_id
				JOIN branches b ON b.id=n.branch_id WHERE n.workspace_id=$1 AND n.deleted_at IS NULL AND n.type<>'topic' ORDER BY 1, n.created_at`, in.WorkspaceID)
			if err != nil {
				return nil, out{}, errors.New("could not read the graph")
			}
			defer rows.Close()
			var b strings.Builder
			last := ""
			for rows.Next() {
				var topic, id, typ, title, kind string
				if rows.Scan(&topic, &id, &typ, &title, &kind) == nil {
					if topic != last {
						fmt.Fprintf(&b, "\n# %s\n", topic)
						last = topic
					}
					mark := ""
					if kind == "agent" {
						mark = " (AI Agent branch)"
					}
					fmt.Fprintf(&b, "- [%s] %s  id=%s%s\n", typ, title, id, mark)
				}
			}
			if b.Len() == 0 {
				return ok("The workspace is empty.")
			}
			return ok(b.String())
		})

	addTool(s, &mcp.Tool{Name: "add_question", Description: "Record a sub-question or search query you are investigating (e.g. each web search you run). " +
		"It becomes a Question node; pass the same text as `question` to add_source so sources are linked to it."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the current research workspace"`
			Question    string `json:"question"`
		}) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, true)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			q := truncateRunes(strings.TrimSpace(in.Question), 300)
			if q == "" {
				return nil, out{}, errors.New("question is empty")
			}
			id, isNew, err := question(ctx, in.WorkspaceID, q, clientName(req))
			if err != nil {
				return nil, out{}, err
			}
			return ok(gin.H{"node_id": id, "is_new": isNew})
		})

	addTool(s, &mcp.Tool{Name: "add_source", Description: "Add a web page you found as a source. Call it right away for every useful page while you research, " +
		"so the user sees the map grow live. Pass the key page text in `content` when you have it (otherwise the server downloads the public page). " +
		"Runs the AI pipeline (summary, topics, claims, connections, topic group, conflict check) and lands in the AI Agent branch. Returns node_id for add_finding."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the current research workspace"`
			URL         string `json:"url"`
			Title       string `json:"title,omitempty"`
			Content     string `json:"content,omitempty" jsonschema:"page text; if empty the server fetches the public page"`
			Note        string `json:"note,omitempty" jsonschema:"why this source matters"`
			Question    string `json:"question,omitempty" jsonschema:"the research question / search query that led to this source"`
		}) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, true)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			if !isHTTPURL(in.URL) || len(in.URL) > 2048 {
				return nil, out{}, errors.New("url must be an http(s) URL")
			}
			if isBlocked(ctx, in.WorkspaceID, domainOf(in.URL)) {
				return nil, out{}, errors.New(domainOf(in.URL) + " is on this workspace's blocklist")
			}
			client := clientName(req)
			b := capturePageReq{URL: in.URL, Title: in.Title, ContentText: in.Content, Transition: "manual", WorkspaceID: in.WorkspaceID, ClientName: client}
			if q := truncateRunes(strings.TrimSpace(in.Question), 300); q != "" {
				if _, _, err := question(ctx, in.WorkspaceID, q, client); err != nil {
					return nil, out{}, err
				}
				b.SearchQuery = &q // ingestPage links the page to the Question node; Agent 2 can add "answers"
			}
			res, err := a.ingestPage(ctx, u, b, agentSession(ctx, in.WorkspaceID, client), "mcp")
			if err != nil {
				slog.Warn("[MCP] add_source failed", "err", err)
				return nil, out{}, errors.New("could not add the source")
			}
			nodeID := res["node_id"].(string)
			if res["is_new"] == true {
				go a.logEvent(context.Background(), in.WorkspaceID, &u.ID, "source_added", gin.H{"node_id": nodeID, "url": in.URL, "via": "mcp", "client": client})
			}
			if in.Note != "" {
				if _, err := a.mcpAnnotate(ctx, u, in.WorkspaceID, nodeID, in.Note); err != nil {
					return nil, out{}, err
				}
			}
			res["status"] = "analyzing"
			res["message"] = "Saved. AI analysis is running; call get_node in ~20 s for the summary and connections."
			return ok(res)
		})

	addTool(s, &mcp.Tool{Name: "add_note", Description: "Add a note to a node (node_id), or a free-standing Note node in the workspace (workspace_id)."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			NodeID      string `json:"node_id,omitempty"`
			WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the current research workspace"`
			Text        string `json:"text"`
		}) (*mcp.CallToolResult, out, error) {
			text := truncateRunes(strings.TrimSpace(in.Text), 5000)
			if text == "" {
				return nil, out{}, errors.New("text is empty")
			}
			if in.NodeID != "" {
				n, err := a.mcpNode(ctx, in.NodeID, u.ID, true)
				if err != nil {
					return nil, out{}, err
				}
				id, err := a.mcpAnnotate(ctx, u, n.WorkspaceID, n.ID, text)
				if err != nil {
					return nil, out{}, err
				}
				return ok(gin.H{"annotation_id": id})
			}
			wsID, err := ws(ctx, in.WorkspaceID, true)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			title := truncateRunes(strings.SplitN(text, "\n", 2)[0], 120)
			id, err := a.mcpCreateNode(ctx, u, in.WorkspaceID, "note", title, text, clientName(req), nil)
			if err != nil {
				return nil, out{}, err
			}
			return ok(gin.H{"node_id": id})
		})

	addTool(s, &mcp.Tool{Name: "add_finding", Description: "Add a Finding (a conclusion of your research) supported by source node ids from add_source. " +
		"Each source gets a 'supports' edge to the finding. Put the explanation / evidence in `details`."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			WorkspaceID   string   `json:"workspace_id,omitempty" jsonschema:"optional; defaults to the current research workspace"`
			Statement     string   `json:"statement" jsonschema:"the conclusion in one sentence"`
			Details       string   `json:"details,omitempty" jsonschema:"explanation and evidence for the conclusion (a few sentences)"`
			SourceNodeIDs []string `json:"source_node_ids,omitempty" jsonschema:"node_id values returned by add_source"`
		}) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, true)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			st := truncateRunes(strings.TrimSpace(in.Statement), 500)
			if st == "" {
				return nil, out{}, errors.New("statement is empty")
			}
			if len(in.SourceNodeIDs) > 20 {
				in.SourceNodeIDs = in.SourceNodeIDs[:20]
			}
			// Never trust ids from the client: keep only live nodes of this workspace. A page_id is mapped to its node
			// (assistants often pass that one); unknown ids are reported instead of failing the whole finding.
			type src struct{ id, title string }
			var sources []src
			ignored := []string{}
			if len(in.SourceNodeIDs) > 0 {
				rows, err := a.db.Query(ctx, `SELECT DISTINCT ON (n.id) n.id::text, n.title, coalesce(n.page_id::text,'') FROM nodes n
					WHERE n.workspace_id=$2 AND n.deleted_at IS NULL AND (n.id::text = ANY($1) OR n.page_id::text = ANY($1))`, in.SourceNodeIDs, in.WorkspaceID)
				if err != nil {
					return nil, out{}, errors.New("could not read the source nodes")
				}
				matched := map[string]bool{}
				for rows.Next() {
					var id, title, pageID string
					if rows.Scan(&id, &title, &pageID) == nil {
						sources = append(sources, src{id, title})
						matched[id], matched[pageID] = true, true
					}
				}
				rows.Close()
				for _, sid := range in.SourceNodeIDs {
					if !matched[sid] {
						ignored = append(ignored, sid)
					}
				}
			}
			client := clientName(req)
			var body strings.Builder
			if d := strings.TrimSpace(in.Details); d != "" {
				body.WriteString(truncateRunes(d, 4000) + "\n\n")
			}
			if len(sources) > 0 {
				body.WriteString("Supported by:\n")
				for _, sr := range sources {
					body.WriteString("- " + sr.title + "\n")
				}
			}
			body.WriteString("\nConclusion drawn by the AI assistant (" + client + "). Review it before copying it to Main.")
			ids := make([]string, len(sources))
			for i, sr := range sources {
				ids[i] = sr.id
			}
			id, err := a.mcpCreateNode(ctx, u, in.WorkspaceID, "finding", st, strings.TrimSpace(body.String()), client, ids)
			if err != nil {
				return nil, out{}, err
			}
			edges := []string{}
			for _, sid := range ids {
				if eid, err := a.mcpLink(ctx, u, in.WorkspaceID, sid, id, "supports", "Source cited by the AI assistant for this finding.", client); err == nil {
					edges = append(edges, eid)
				}
			}
			res := gin.H{"node_id": id, "edge_ids": edges}
			if len(ignored) > 0 {
				res["ignored_source_ids"] = ignored
				res["hint"] = "Those ids are not nodes of this workspace; use the node_id values returned by add_source."
			}
			return ok(res)
		})

	addTool(s, &mcp.Tool{Name: "link_nodes", Description: "Suggest an explained connection between two nodes. The user accepts, changes or rejects it. Relations: " +
		"answers, subtopic_of, explains, supports, contradicts, example_of, prerequisite_of, alternative_to, same_topic, source_of."},
		func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			SourceID string `json:"source_id"`
			TargetID string `json:"target_id"`
			Relation string `json:"relation"`
			Reason   string `json:"reason"`
		}) (*mcp.CallToolResult, out, error) {
			if !relations[in.Relation] || in.Relation == "opened_from" || in.Relation == "links_to" || in.Relation == "duplicate_of" {
				return nil, out{}, fmt.Errorf("relation %q is not allowed", in.Relation)
			}
			if strings.TrimSpace(in.Reason) == "" {
				return nil, out{}, errors.New("reason is required (explain why they are connected)")
			}
			n, err := a.mcpNode(ctx, in.SourceID, u.ID, true)
			if err != nil {
				return nil, out{}, err
			}
			id, err := a.mcpLink(ctx, u, n.WorkspaceID, in.SourceID, in.TargetID, in.Relation, in.Reason, clientName(req))
			if err != nil {
				return nil, out{}, err
			}
			return ok(gin.H{"created": true, "edge_id": id})
		})

	addTool(s, &mcp.Tool{Name: "list_conflicts", Description: "Potential conflicts between sources (the app never decides who is right)."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in wsIn) (*mcp.CallToolResult, out, error) {
			wsID, err := ws(ctx, in.WorkspaceID, false)
			if err != nil {
				return nil, out{}, err
			}
			in.WorkspaceID = wsID
			cs, err := a.conflictsWhere(ctx, "WHERE workspace_id=$1", in.WorkspaceID)
			if err != nil {
				return nil, out{}, errors.New("could not list conflicts")
			}
			return ok(cs)
		})

	type refIn struct {
		SessionID   string `json:"session_id,omitempty" jsonschema:"a research session id"`
		WorkspaceID string `json:"workspace_id,omitempty" jsonschema:"or a workspace id: every source in the workspace"`
	}
	sessionOf := func(ctx context.Context, id string) (*Session, error) {
		s, err := a.loadSession(ctx, id)
		if err != nil {
			return nil, errors.New("session not found")
		}
		if _, err := a.mcpRole(ctx, s.WorkspaceID, u.ID); err != nil {
			return nil, err
		}
		return s, nil
	}
	addTool(s, &mcp.Tool{Name: "get_references", Description: "Numbered reference list (Markdown + data) for a session (session_id) or a whole workspace (workspace_id)."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in refIn) (*mcp.CallToolResult, out, error) {
			var refs []Reference
			var err error
			switch {
			case in.SessionID != "":
				se, e := sessionOf(ctx, in.SessionID)
				if e != nil {
					return nil, out{}, e
				}
				refs, err = a.references(ctx, se.ID)
			case in.WorkspaceID != "":
				if _, e := a.mcpRole(ctx, in.WorkspaceID, u.ID); e != nil {
					return nil, out{}, e
				}
				refs, err = a.workspaceReferences(ctx, in.WorkspaceID)
			default:
				wsID, e := ws(ctx, "", false)
				if e != nil {
					return nil, out{}, e
				}
				refs, err = a.workspaceReferences(ctx, wsID)
			}
			if err != nil {
				return nil, out{}, errors.New("could not load references")
			}
			return ok(gin.H{"references": refs, "markdown": referencesMarkdown(refs)})
		})
	addTool(s, &mcp.Tool{Name: "get_session_report", Description: "Session statistics and the AI summary (if generated). Without session_id, uses the workspace's latest session."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in refIn) (*mcp.CallToolResult, out, error) {
			id := in.SessionID
			if id == "" {
				wsID, err := ws(ctx, in.WorkspaceID, false)
				if err != nil {
					return nil, out{}, err
				}
				_ = a.db.QueryRow(ctx, `SELECT id FROM sessions WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 1`, wsID).Scan(&id)
				if id == "" {
					return nil, out{}, errors.New("this workspace has no tracking sessions yet")
				}
			}
			se, err := sessionOf(ctx, id)
			if err != nil {
				return nil, out{}, err
			}
			stats, err := a.computeStats(ctx, se)
			if err != nil {
				return nil, out{}, errors.New("could not compute statistics")
			}
			var content json.RawMessage
			_ = a.db.QueryRow(ctx, `SELECT content FROM reports WHERE session_id=$1 AND status='ready'`, se.ID).Scan(&content)
			return ok(gin.H{"session_id": se.ID, "stats": stats, "report": content})
		})
	return s
}

// mcpQuestion finds or creates the Question node for a research question (same dedupe rule as /capture/search).
func (a *App) mcpQuestion(ctx context.Context, u *User, wsID, q, client string) (string, bool, error) {
	var id string
	_ = a.db.QueryRow(ctx, `SELECT id FROM nodes WHERE workspace_id=$1 AND type='question' AND deleted_at IS NULL AND lower(title)=lower($2) LIMIT 1`, wsID, q).Scan(&id)
	if id != "" {
		return id, false, nil
	}
	body := "Research question from the AI assistant (" + client + "). The sources it finds are linked here with \"answers\" connections, and its conclusions appear as Finding nodes."
	id, err := a.mcpCreateNode(ctx, u, wsID, "question", q, body, client, nil)
	return id, err == nil, err
}

// workspaceReferences numbers every page of a workspace in the order it was first added.
func (a *App) workspaceReferences(ctx context.Context, wsID string) ([]Reference, error) {
	return collect[Reference](ctx, a.db, `SELECT (row_number() OVER (ORDER BY p.created_at))::int AS ref_number, p.id AS page_id,
		(SELECT id FROM nodes WHERE page_id=p.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) AS node_id,
		p.title, p.url, p.domain, p.site_name, p.author, p.published_at, p.created_at AS first_accessed_at,
		(SELECT CASE WHEN n.created_via='mcp' THEN 'AI assistant ('||coalesce(n.client_name,'MCP')||')' ELSE u.name END
		   FROM nodes n LEFT JOIN users u ON u.id=n.created_by WHERE n.page_id=p.id ORDER BY n.created_at LIMIT 1) AS added_by
		FROM pages p WHERE p.workspace_id=$1 AND EXISTS (SELECT 1 FROM nodes n WHERE n.page_id=p.id AND n.deleted_at IS NULL)
		ORDER BY p.created_at`, wsID)
}

func (a *App) mcpAnnotate(ctx context.Context, u *User, wsID, nodeID, text string) (string, error) {
	var id string
	if err := a.db.QueryRow(ctx, `INSERT INTO annotations (workspace_id,node_id,kind,body,author_id) VALUES ($1,$2,'note',$3,$4) RETURNING id`,
		wsID, nodeID, truncateRunes(text, 5000), u.ID).Scan(&id); err != nil {
		slog.Warn("[MCP] note failed", "err", err)
		return "", errors.New("could not save the note")
	}
	if an, err := a.loadAnnotation(ctx, id); err == nil {
		a.publish(wsID, "annotation.created", &u.ID, an)
	}
	a.logEvent(ctx, wsID, &u.ID, "note_added", gin.H{"node_id": nodeID, "via": "mcp"})
	return id, nil
}

// mcpLink stores an AI-assistant edge (origin mcp, state suggested) in the AI Agent branch. Both ends must be live nodes
// of the workspace, and a pair the user rejected is never suggested again (same rule as Agent 2).
func (a *App) mcpLink(ctx context.Context, u *User, wsID, src, dst, rel, reason, client string) (string, error) {
	if src == dst {
		return "", errors.New("cannot link a node to itself")
	}
	var both, rejected bool
	_ = a.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM nodes WHERE id IN ($2,$3) AND workspace_id=$1 AND deleted_at IS NULL)=2,
		EXISTS(SELECT 1 FROM edges WHERE state='rejected' AND ((source_id=$2 AND target_id=$3) OR (source_id=$3 AND target_id=$2)))`,
		wsID, src, dst).Scan(&both, &rejected)
	if !both {
		return "", errors.New("both nodes must exist in the same workspace")
	}
	if rejected {
		return "", errors.New("the user rejected a connection between these nodes; it will not be suggested again")
	}
	var id string
	err := a.db.QueryRow(ctx, `INSERT INTO edges (workspace_id,branch_id,source_id,target_id,relation,reason,evidence,confidence,origin,state,created_by,client_name)
		VALUES ($1,$2,$3,$4,$5,$6,'[]',0.7,'mcp','suggested',$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
		wsID, a.agentBranch(ctx, wsID), src, dst, rel, truncateRunes(strings.TrimSpace(reason), 400), u.ID, client).Scan(&id)
	if err != nil {
		return "", errors.New("this connection already exists")
	}
	if e, err := a.loadEdge(ctx, id); err == nil {
		a.publish(wsID, "edge.created", &u.ID, e)
	}
	go a.logEvent(context.Background(), wsID, &u.ID, "edge_suggested", gin.H{"edge_id": id, "relation": rel, "via": "mcp", "client": client})
	return id, nil
}

// mcpHandler authenticates the MCP token on every request, rate-limits per user, binds each MCP session to the
// user who opened it, and serves Streamable HTTP.
func (a *App) mcpHandler() gin.HandlerFunc {
	h := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		u, _ := r.Context().Value(mcpUserKey{}).(*User)
		return a.mcpServer(u)
	}, &mcp.StreamableHTTPOptions{SessionTimeout: 2 * time.Hour,
		// The host's proxy reaches us on a loopback address, and the SDK would then reject the public Host header.
		// Every request is checked against an MCP token above, so the localhost-only guard is not needed.
		DisableLocalhostProtection: true})
	limiter := newRateLimiter(240, time.Minute)
	var owners sync.Map // Mcp-Session-Id → user id
	return func(c *gin.Context) {
		var u *User
		authz := c.GetHeader("Authorization")
		if v, ok := mcpAuthCache.Load(authz); ok && time.Now().Before(v.(mcpAuthHit).exp) {
			u = v.(mcpAuthHit).u
		} else {
			var err error
			u, err = a.userFromRequest(c)
			if err != nil || u.TokenKind != "mcp" {
				mcpAuthCache.Delete(authz)
				c.AbortWithStatusJSON(401, gin.H{"error": gin.H{"code": "unauthorized", "message": "Use a valid MCP token (Settings → Connect an AI assistant)"}})
				return
			}
			mcpAuthCache.Store(authz, mcpAuthHit{u, time.Now().Add(20 * time.Second)})
		}
		if !limiter.allow("mcp:" + u.ID) {
			c.Header("Retry-After", "30")
			c.AbortWithStatusJSON(429, gin.H{"error": gin.H{"code": "rate_limited", "message": "Too many MCP requests; slow down"}})
			return
		}
		sid := c.GetHeader("Mcp-Session-Id")
		if sid != "" {
			if owner, ok := owners.Load(sid); ok && owner != u.ID {
				c.AbortWithStatusJSON(403, gin.H{"error": gin.H{"code": "forbidden", "message": "This MCP session belongs to another user"}})
				return
			}
		}
		h.ServeHTTP(c.Writer, c.Request.WithContext(context.WithValue(c.Request.Context(), mcpUserKey{}, u)))
		if sid == "" {
			if newSID := c.Writer.Header().Get("Mcp-Session-Id"); newSID != "" {
				owners.Store(newSID, u.ID)
			}
		} else if c.Request.Method == http.MethodDelete {
			owners.Delete(sid)
		}
	}
}

type mcpUserKey struct{}

// mcpAuthCache keeps valid MCP tokens for 20 s so a busy assistant does not pay a remote-database round trip per
// request. revokeToken clears it, so a revoked token stops working immediately.
var mcpAuthCache sync.Map // Authorization header → mcpAuthHit

type mcpAuthHit struct {
	u   *User
	exp time.Time
}

const mcpInstructions = "Research Map turns research into a live visual canvas in the user's browser. Whenever the user asks you to research " +
	"anything, use these tools while you work (not only at the end): 1) start_research(topic, goal) FIRST: it creates the workspace, saves the " +
	"user's goal if they gave one, and opens it live for the user; 2) search the web with your own search tool; 3) add_source for EVERY useful " +
	"page right after you read it (url, title, content = the relevant text, question = the query that found it); 4) add_finding for each " +
	"conclusion, citing the source node ids; 5) optionally link_nodes to explain relationships. If your web search fails or is rate-limited, " +
	"do not keep retrying it: add the official websites of options you already know with add_source; the server reads each page itself. " +
	"workspace_id is optional after start_research. Everything appears on the user's canvas right away. This server does not search the web itself."

// appURL is the web app origin used in links handed back to AI assistants.
func (a *App) appURL() string {
	return strings.TrimRight(a.cfg.WebOrigins[0], "/") // WEB_ORIGINS always has at least one entry (see config)
}

// mcpStartWorkspace reuses the user's workspace with this exact title (so a retrying assistant does not create duplicates)
// or creates a new one with Main, personal and AI Agent branches.
func (a *App) mcpStartWorkspace(ctx context.Context, u *User, title, client string) (string, bool, error) {
	var id string
	_ = a.db.QueryRow(ctx, `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1
		WHERE w.deleted_at IS NULL AND m.role IN ('owner','editor') AND lower(w.title)=lower($2) ORDER BY w.updated_at DESC LIMIT 1`, u.ID, title).Scan(&id)
	if id != "" {
		return id, false, nil
	}
	id, err := a.newWorkspace(ctx, u, title, "Research started by an AI assistant ("+client+") over MCP.")
	if err != nil {
		slog.Warn("[MCP] create workspace failed", "err", err)
		return "", false, errors.New("could not create the workspace")
	}
	a.logEvent(ctx, id, &u.ID, "workspace_created", gin.H{"via": "mcp", "client": client})
	return id, true, nil
}

// announceResearch tells every open tab of the user that an AI assistant started researching in a workspace, so the
// web app opens it and the nodes appear live as the assistant adds them.
func (a *App) announceResearch(ctx context.Context, u *User, wsID string, isNew bool, topic, client string) {
	w, err := a.serializeWorkspace(ctx, wsID, u.ID)
	if err != nil {
		return
	}
	a.hub.BroadcastUser(u.ID, Message{Type: "mcp.research_started", WorkspaceID: wsID, By: &u.ID,
		Data: gin.H{"workspace": w, "created": isNew, "topic": topic, "client": client}})
}

// toolOutputSchema describes every tool's {"result": ...} output. The schema the SDK infers for `any` is the boolean
// `true`, which is valid JSON Schema but rejected by Gemini CLI's tool validation (it requires an object), and that
// one rejection hides every tool from Gemini.
var toolOutputSchema = map[string]any{
	"type":       "object",
	"properties": map[string]any{"result": map[string]any{"description": "The tool's result (JSON value)."}},
	"required":   []string{"result"},
}

// addTool registers a tool with a lenient input schema and logs tool errors. LLM clients routinely send null for
// optional fields or extra fields the schema does not list; with the SDK's strict inferred schema each of those is a
// hard "MCP ERROR" in Gemini CLI, so nulls and unknown fields are accepted (the handlers validate what matters).
func addTool[In any](s *mcp.Server, t *mcp.Tool, h mcp.ToolHandlerFor[In, out]) {
	in, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Errorf("tool %s: %w", t.Name, err))
	}
	in.AdditionalProperties = nil
	for _, p := range in.Properties {
		switch {
		case p.Type != "":
			p.Types, p.Type = []string{p.Type, "null"}, ""
		case len(p.Types) > 0 && !slices.Contains(p.Types, "null"):
			p.Types = append(p.Types, "null")
		}
	}
	t.InputSchema = in
	t.OutputSchema = toolOutputSchema
	name := t.Name
	mcp.AddTool(s, t, func(ctx context.Context, req *mcp.CallToolRequest, args In) (*mcp.CallToolResult, out, error) {
		res, o, err := h(ctx, req, args)
		if err != nil {
			slog.Warn("[MCP] tool error", "tool", name, "client", clientName(req), "err", err)
		}
		return res, o, err
	})
}
