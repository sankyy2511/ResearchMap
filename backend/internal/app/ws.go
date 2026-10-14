package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

// Message is the envelope the frontend expects: {type, workspace_id, by, data}.
type Message struct {
	Type        string  `json:"type"`
	WorkspaceID string  `json:"workspace_id"`
	By          *string `json:"by"`
	Data        any     `json:"data"`
}

type client struct {
	user     *User
	wsID     string
	send     chan []byte
	selected *string
	lastMove time.Time
	cancel   context.CancelFunc
}

// Hub keeps one in-memory room per workspace (single Go instance, as the spec allows).
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*client]bool
}

func NewHub() *Hub { return &Hub{rooms: map[string]map[*client]bool{}} }

func (h *Hub) Broadcast(wsID string, m Message) {
	b, err := json.Marshal(m)
	if err != nil {
		slog.Error("ws marshal", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	if m.Type == "node.created" || m.Type == "edge.created" || m.Type == "page.analyzed" {
		slog.Info("[WS] graph update emitted", "type", m.Type, "workspace_id", wsID, "clients", len(h.rooms[wsID]))
	}
	for c := range h.rooms[wsID] {
		select {
		case c.send <- b:
		default: // slow client; it will resync on reconnect
		}
	}
}

func (h *Hub) broadcastExcept(wsID string, skip *client, m Message) {
	b, _ := json.Marshal(m)
	h.mu.RLock()
	defer h.mu.RUnlock()
	if m.Type == "node.created" || m.Type == "edge.created" || m.Type == "page.analyzed" {
		slog.Info("[WS] graph update emitted", "type", m.Type, "workspace_id", wsID, "clients", len(h.rooms[wsID]))
	}
	for c := range h.rooms[wsID] {
		if c != skip {
			select {
			case c.send <- b:
			default:
			}
		}
	}
}

// userRoom is the per-user room a socket joins when it connects without a workspace_id (dashboard, settings).
func userRoom(userID string) string { return "user:" + userID }

// BroadcastUser sends a message to every live socket of a user: their dashboard socket and any open workspace.
func (h *Hub) BroadcastUser(userID string, m Message) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, clients := range h.rooms {
		for c := range clients {
			if c.user.ID == userID {
				select {
				case c.send <- b:
				default:
				}
			}
		}
	}
}

// Kick closes the live connections of users who lost access to a workspace (revoked link, removed member).
func (h *Hub) Kick(wsID string, userIDs ...string) {
	if len(userIDs) == 0 {
		return
	}
	drop := map[string]bool{}
	for _, id := range userIDs {
		drop[id] = true
	}
	h.mu.RLock()
	for c := range h.rooms[wsID] {
		if drop[c.user.ID] && c.cancel != nil {
			c.cancel()
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) join(c *client) {
	h.mu.Lock()
	if h.rooms[c.wsID] == nil {
		h.rooms[c.wsID] = map[*client]bool{}
	}
	h.rooms[c.wsID][c] = true
	h.mu.Unlock()
	if c.wsID != userRoom(c.user.ID) {
		h.presence(c.wsID)
	}
}

func (h *Hub) leave(c *client) {
	h.mu.Lock()
	delete(h.rooms[c.wsID], c)
	if len(h.rooms[c.wsID]) == 0 {
		delete(h.rooms, c.wsID)
	}
	h.mu.Unlock()
	if c.wsID != userRoom(c.user.ID) {
		h.presence(c.wsID)
	}
}

func (h *Hub) presence(wsID string) {
	h.mu.RLock()
	seen := map[string]bool{}
	users := []gin.H{}
	for c := range h.rooms[wsID] {
		if seen[c.user.ID] {
			continue
		}
		seen[c.user.ID] = true
		users = append(users, gin.H{"id": c.user.ID, "name": c.user.Name, "color": c.user.AvatarColor, "selected_node_id": c.selected})
	}
	h.mu.RUnlock()
	h.Broadcast(wsID, Message{Type: "presence", WorkspaceID: wsID, Data: gin.H{"users": users}})
}

func (a *App) serveWS(c *gin.Context) {
	u, err := a.userFromRequest(c)
	if err != nil {
		httpx.WriteError(c, err)
		return
	}
	c.Set("user", u)
	wsID := c.Query("workspace_id")
	if wsID == "" { // user-level socket: only receives events addressed to this user (e.g. an AI assistant started research)
		wsID = userRoom(u.ID)
	} else if _, err := a.requireWS(c, wsID, "viewer"); err != nil {
		httpx.WriteError(c, err)
		return
	}
	patterns := make([]string, 0, len(a.cfg.WebOrigins))
	for _, o := range a.cfg.WebOrigins {
		if pu, err := url.Parse(o); err == nil {
			patterns = append(patterns, pu.Host)
		}
	}
	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{OriginPatterns: patterns})
	if err != nil {
		return
	}
	conn.SetReadLimit(64 * 1024)
	ctx, cancel := context.WithCancel(context.WithoutCancel(c.Request.Context()))
	cl := &client{user: u, wsID: wsID, send: make(chan []byte, 256), cancel: cancel}
	defer cancel()
	a.hub.join(cl)
	defer a.hub.leave(cl)

	go func() { // writer + keepalive
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-cl.send:
				wctx, wc := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(wctx, websocket.MessageText, b)
				wc()
				if err != nil {
					cancel()
					return
				}
			case <-ping.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pctx)
				pc()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			conn.CloseNow()
			return
		}
		var m struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "presence.update":
			var d struct {
				SelectedNodeID *string `json:"selected_node_id"`
			}
			if json.Unmarshal(m.Data, &d) == nil {
				a.hub.mu.Lock()
				cl.selected = d.SelectedNodeID
				a.hub.mu.Unlock()
				a.hub.presence(wsID)
			}
		case "node.moving": // ephemeral; the final position is saved over REST on drag end
			if time.Since(cl.lastMove) < 50*time.Millisecond {
				continue
			}
			cl.lastMove = time.Now()
			var d struct {
				ID string  `json:"id"`
				X  float64 `json:"x"`
				Y  float64 `json:"y"`
			}
			if json.Unmarshal(m.Data, &d) == nil && d.ID != "" {
				a.hub.broadcastExcept(wsID, cl, Message{Type: "node.moving", WorkspaceID: wsID, By: &u.ID, Data: d})
			}
		}
	}
}
