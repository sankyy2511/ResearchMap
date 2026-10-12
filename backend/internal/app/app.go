// Package app holds the HTTP handlers, permission checks, realtime hub and AI pipeline.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/config"
	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	cfg      config.Config
	db       *pgxpool.Pool
	hub      *Hub
	agent    *AgentClient
	pipeline *Pipeline
	limiter  *rateLimiter
	goalAI   *rateLimiter // AI goal checks per user: protects the AI quota from scripted floods
}

func New(cfg config.Config, pool *pgxpool.Pool) *App {
	a := &App{cfg: cfg, db: pool, hub: NewHub(), limiter: newRateLimiter(10, time.Minute), goalAI: newRateLimiter(60, time.Minute)}
	a.agent = &AgentClient{base: cfg.AgentURL, key: cfg.AgentKey, http: &http.Client{Timeout: 90 * time.Second}}
	a.pipeline = newPipeline(a)
	return a
}

// Start launches background workers (AI pipeline) until ctx ends.
func (a *App) Start(ctx context.Context) { a.pipeline.start(ctx) }

// cors lets the web app call this API from its own address (for example Firebase Hosting) with
// "Authorization: Bearer". Only the addresses in WEB_ORIGINS are allowed.
func (a *App) cors(c *gin.Context) {
	origin := c.GetHeader("Origin")
	allowed := false
	for _, o := range a.cfg.WebOrigins {
		if origin != "" && strings.EqualFold(strings.TrimRight(o, "/"), origin) {
			allowed = true
			break
		}
	}
	if allowed {
		h := c.Writer.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		h.Add("Vary", "Origin")
		if c.Request.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID")
			h.Set("Access-Control-Max-Age", "86400")
		}
		h.Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
	}
	if c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
		c.AbortWithStatus(http.StatusNoContent)
		return
	}
	c.Next()
}

func (a *App) Routes(e *gin.Engine) {
	e.Use(a.cors) // on the engine, so preflight requests to any path are answered too
	r := e.Group("/api/v1")
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	r.GET("/readyz", a.readyz)

	r.GET("/auth/options", func(c *gin.Context) {
		c.JSON(200, gin.H{"google": a.cfg.GoogleClientID != "", "email_codes": a.cfg.EmailVerification})
	})
	r.POST("/auth/register", httpx.H(a.register))
	r.POST("/auth/verify", httpx.H(a.verifyEmail))
	r.POST("/auth/resend", httpx.H(a.resendCode))
	r.POST("/auth/forgot", httpx.H(a.forgotPassword))
	r.POST("/auth/reset", httpx.H(a.resetPassword))
	r.POST("/auth/login", httpx.H(a.login))
	r.POST("/auth/logout", httpx.H(a.logout))
	r.GET("/auth/google", a.googleStart)
	r.GET("/auth/google/callback", a.googleCallback)

	p := r.Group("", a.authMiddleware)
	p.GET("/me", httpx.H(a.me))
	p.GET("/tokens", httpx.H(a.listTokens))
	p.POST("/tokens", httpx.H(a.createToken))
	p.DELETE("/tokens/:id", httpx.H(a.revokeToken))

	p.GET("/workspaces", httpx.H(a.listWorkspaces))
	p.POST("/workspaces", httpx.H(a.createWorkspace))
	p.POST("/workspaces/import", httpx.H(a.importWorkspace))
	p.GET("/workspaces/:id", httpx.H(a.getWorkspace))
	p.PATCH("/workspaces/:id", httpx.H(a.updateWorkspace))
	p.DELETE("/workspaces/:id", httpx.H(a.deleteWorkspace))
	p.GET("/workspaces/:id/graph", httpx.H(a.getGraph))
	p.PUT("/workspaces/:id/view-state", httpx.H(a.saveViewState))
	p.POST("/workspaces/:id/reorganize", httpx.H(a.reorganize))
	p.POST("/workspaces/:id/reorganize/undo", httpx.H(a.undoReorganize))
	p.GET("/workspaces/:id/members", httpx.H(a.listMembers))
	p.PATCH("/workspaces/:id/members/:userId", httpx.H(a.updateMember))
	p.DELETE("/workspaces/:id/members/:userId", httpx.H(a.removeMember))
	p.GET("/workspaces/:id/share-links", httpx.H(a.listShareLinks))
	p.POST("/workspaces/:id/share-links", httpx.H(a.createShareLink))
	p.DELETE("/workspaces/:id/share-links/:linkId", httpx.H(a.disableShareLink))
	p.POST("/join/:token", httpx.H(a.join))
	p.GET("/workspaces/:id/branches", httpx.H(a.listBranches))
	p.POST("/workspaces/:id/branches", httpx.H(a.createBranch))
	p.GET("/workspaces/:id/branches/compare", httpx.H(a.compareBranches))
	p.POST("/branches/:id/merge", httpx.H(a.mergeBranch))

	p.POST("/workspaces/:id/sessions/start", httpx.H(a.startSession))
	p.GET("/workspaces/:id/sessions", httpx.H(a.listSessions))
	p.POST("/sessions/:id/stop", httpx.H(a.stopSession))
	p.POST("/sessions/:id/pause", httpx.H(a.pauseSession))
	p.POST("/sessions/:id/resume", httpx.H(a.resumeSession))
	p.GET("/sessions/:id/stats", httpx.H(a.sessionStats))
	p.GET("/sessions/:id/references", httpx.H(a.sessionReferences))
	p.POST("/sessions/:id/report", httpx.H(a.generateReport))
	p.GET("/sessions/:id/report", httpx.H(a.getReport))
	p.GET("/workspaces/:id/journey", httpx.H(a.journey))
	p.PUT("/sessions/:id/goal", httpx.H(a.updateGoal))
	p.GET("/sessions/:id/goal-checks", httpx.H(a.listGoalChecks))
	p.POST("/goal/check", httpx.H(a.checkGoal))
	p.POST("/goal/mark", httpx.H(a.markGoal))

	p.POST("/capture/page", httpx.H(a.capturePage))
	p.POST("/capture/search", httpx.H(a.captureSearch))
	p.POST("/capture/visits", httpx.H(a.captureVisits))
	p.POST("/capture/highlight", httpx.H(a.captureHighlight))
	p.PUT("/pages/:id/preview", httpx.H(a.putPreview))
	p.GET("/pages/:id/preview", httpx.H(a.getPreview))
	p.GET("/extension/state", httpx.H(a.extensionState))

	p.POST("/nodes", httpx.H(a.createNode))
	p.POST("/nodes/positions", httpx.H(a.savePositions))
	p.PATCH("/nodes/:id", httpx.H(a.updateNode))
	p.DELETE("/nodes/:id", httpx.H(a.deleteNode))
	p.POST("/nodes/:id/restore", httpx.H(a.restoreNode))
	p.POST("/nodes/:id/merge", httpx.H(a.mergeNode))
	p.PUT("/nodes/:id/tags", httpx.H(a.setNodeTags))
	p.POST("/nodes/:id/annotations", httpx.H(a.createAnnotationH))
	p.PATCH("/annotations/:id", httpx.H(a.updateAnnotation))
	p.DELETE("/annotations/:id", httpx.H(a.deleteAnnotation))
	p.POST("/edges", httpx.H(a.createEdge))
	p.PATCH("/edges/:id", httpx.H(a.updateEdge))
	p.DELETE("/edges/:id", httpx.H(a.deleteEdge))

	p.GET("/workspaces/:id/tags", httpx.H(a.listTags))
	p.POST("/workspaces/:id/tags", httpx.H(a.createTag))
	p.GET("/workspaces/:id/categories", httpx.H(a.listCategories))
	p.POST("/workspaces/:id/categories", httpx.H(a.createCategory))
	p.PATCH("/categories/:id", httpx.H(a.updateCategory))

	p.GET("/workspaces/:id/radar", httpx.H(a.getRadar))
	p.POST("/workspaces/:id/radar/:topicId/suggestions", httpx.H(a.radarSuggestions))
	p.PATCH("/workspaces/:id/radar/items/:itemId", httpx.H(a.updateRadarItem))
	p.GET("/workspaces/:id/conflicts", httpx.H(a.listConflicts))
	p.PATCH("/conflicts/:id", httpx.H(a.updateConflict))
	p.POST("/conflicts/:id/methodology", httpx.H(a.methodology))
	p.GET("/workspaces/:id/search", httpx.H(a.search))
	p.GET("/workspaces/:id/export", httpx.H(a.export))

	r.GET("/ws", a.serveWS)
	r.Any("/mcp", a.mcpHandler())
}

func (a *App) readyz(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	var exts []string
	err := a.db.QueryRow(ctx, `SELECT coalesce(array_agg(extname::text ORDER BY extname), '{}') FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto')`).Scan(&exts)
	agentOK := a.agent.Health(ctx) == nil
	if err != nil || len(exts) < 3 {
		c.JSON(503, gin.H{"ok": false, "db": "unavailable", "extensions": exts, "agent": agentOK})
		return
	}
	c.JSON(200, gin.H{"ok": true, "db": "ok", "extensions": exts, "agent": agentOK})
}

/* ---------------------------------------------------------------- permissions */

var roleRank = map[string]int{"viewer": 1, "editor": 2, "owner": 3}

// requireWS checks membership and minimum role. Every workspace-scoped handler goes through it.
func (a *App) requireWS(c *gin.Context, wsID, minRole string) (string, error) {
	u := currentUser(c)
	var role string
	err := a.db.QueryRow(c, `SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.workspace_id=$1 AND m.user_id=$2 AND w.deleted_at IS NULL`, wsID, u.ID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		_ = a.db.QueryRow(c, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND deleted_at IS NULL)`, wsID).Scan(&exists)
		if !exists {
			return "", httpx.NotFound("Workspace")
		}
		return "", httpx.Forbidden("You are not a member of this workspace")
	}
	if err != nil {
		return "", err
	}
	if roleRank[role] < roleRank[minRole] {
		if minRole == "owner" {
			return "", httpx.Forbidden("Only the owner can do this")
		}
		return "", httpx.Forbidden("Viewers cannot make changes")
	}
	return role, nil
}

// wsOf resolves the workspace of a row in table (nodes, edges, annotations, sessions, pages, categories, conflicts, branches).
func (a *App) wsOf(ctx context.Context, table, id string) (string, error) {
	var ws string
	q := "SELECT workspace_id FROM " + table + " WHERE id=$1"
	if table == "nodes" {
		q += " AND deleted_at IS NULL"
	}
	err := a.db.QueryRow(ctx, q, id).Scan(&ws)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", httpx.NotFound(strings.TrimSuffix(strings.Title(table), "s")) //nolint:staticcheck
	}
	return ws, err
}

// writeBranch is the branch a user writes into. Everyone writes into Main, so all members see the same canvas.
func (a *App) writeBranch(ctx context.Context, wsID, _ string) (string, error) {
	return a.mainBranch(ctx, wsID)
}

func (a *App) mainBranch(ctx context.Context, wsID string) (string, error) {
	var id string
	err := a.db.QueryRow(ctx, `SELECT id FROM branches WHERE workspace_id=$1 AND kind='main'`, wsID).Scan(&id)
	return id, err
}

/* ---------------------------------------------------------------- events + realtime */

func (a *App) publish(wsID, typ string, by *string, data any) {
	a.hub.Broadcast(wsID, Message{Type: typ, WorkspaceID: wsID, By: by, Data: data})
}

func (a *App) logEvent(ctx context.Context, wsID string, userID *string, kind string, payload any) {
	b, _ := json.Marshal(payload)
	if _, err := a.db.Exec(ctx, `INSERT INTO events (workspace_id,user_id,kind,payload) VALUES ($1,$2,$3,$4)`, wsID, userID, kind, b); err != nil {
		slog.Warn("event log failed", "err", err)
	}
}

func (a *App) touch(ctx context.Context, wsID string) {
	_, _ = a.db.Exec(ctx, `UPDATE workspaces SET updated_at=now() WHERE id=$1`, wsID)
}

func bind(c *gin.Context, v any) error {
	if err := c.ShouldBindJSON(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return err
		}
		return httpx.BadRequest("Invalid request body")
	}
	return nil
}

func sp(s string) *string { return &s }
