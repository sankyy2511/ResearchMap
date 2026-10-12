package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const cookieName = "rm_session"
const sessionTTL = 7 * 24 * time.Hour

type User struct {
	ID          string    `json:"id" db:"id"`
	Email       string    `json:"email" db:"email"`
	Name        string    `json:"name" db:"name"`
	AvatarColor string    `json:"avatar_color" db:"avatar_color"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	// set when the request used an API token (extension / MCP)
	TokenKind string `json:"-" db:"-"`
}

func currentUser(c *gin.Context) *User {
	u, _ := c.Get("user")
	return u.(*User)
}

var avatarColors = []string{"#7b5cf0", "#f08a6c", "#3f8a2e", "#2f6fbf", "#c9544f", "#a86f00"}

// newSession signs the user in. The same session token is set as a cookie (web app on the same address as the API)
// and returned for the response body (web app on another address, which sends it as "Authorization: Bearer").
func (a *App) newSession(c *gin.Context, userID string) (string, error) {
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject: userID, IssuedAt: jwt.NewNumericDate(time.Now()), ExpiresAt: jwt.NewNumericDate(time.Now().Add(sessionTTL)),
	}).SignedString([]byte(a.cfg.JWTSecret))
	if err != nil {
		return "", err
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: cookieName, Value: tok, Path: "/", HttpOnly: true,
		Secure: a.cfg.IsProduction(), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
	return tok, nil
}

// signedIn answers a successful sign-in with the user and the session token.
func (a *App) signedIn(c *gin.Context, status int, u User) error {
	tok, err := a.newSession(c, u.ID)
	if err != nil {
		return err
	}
	c.JSON(status, gin.H{"user": u, "token": tok})
	return nil
}

// sessionUser reads the user from a session token (JWT).
func (a *App) sessionUser(c *gin.Context, tok string) (*User, error) {
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(tok, claims, func(t *jwt.Token) (any, error) { return []byte(a.cfg.JWTSecret), nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
	if err != nil {
		return nil, httpx.Unauthorized("Session expired. Please sign in again.")
	}
	var u User
	err = a.db.QueryRow(c, `SELECT id,email,name,avatar_color,created_at FROM users WHERE id=$1`, claims.Subject).
		Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt)
	if err != nil {
		return nil, httpx.Unauthorized("Please sign in")
	}
	return &u, nil
}

// isSessionToken tells a session JWT ("eyJ…" with three parts) from an API token ("rm_…").
func isSessionToken(t string) bool { return strings.HasPrefix(t, "eyJ") && strings.Count(t, ".") == 2 }

func (a *App) login(c *gin.Context) error {
	var b struct{ Email, Password string }
	if err := bind(c, &b); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !a.limiter.allow("login:"+c.ClientIP()) || !a.limiter.allow("login:"+email) {
		return httpx.RateLimited("Too many login attempts. Try again in a minute.")
	}
	var u User
	var hash string
	err := a.db.QueryRow(c, `SELECT id,email,name,avatar_color,created_at,coalesce(password_hash,'') FROM users WHERE email=$1`, email).
		Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$12$C6UzMDM.H6dfI/f/IKcEeO5wHn1nZ9O1mGhTPe6u6vW3c3rB6J6nW"), []byte(b.Password)) // equal timing
		return httpx.Unauthorized("Email or password is incorrect")
	}
	if err != nil {
		return err
	}
	if hash == "" {
		return httpx.Unauthorized("This account uses Google sign-in. Please choose Continue with Google, or reset your password to add one.")
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.Password)) != nil {
		return httpx.Unauthorized("Email or password is incorrect")
	}
	return a.signedIn(c, 200, u)
}

func (a *App) logout(c *gin.Context) error {
	http.SetCookie(c.Writer, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
		Secure: a.cfg.IsProduction(), SameSite: http.SameSiteLaxMode})
	c.Status(204)
	return nil
}

func (a *App) me(c *gin.Context) error {
	c.JSON(200, currentUser(c))
	return nil
}

// userFromRequest accepts a session token (cookie, "Authorization: Bearer", or ?token= on the WebSocket, which
// cannot send headers from a browser) or a Bearer API token (extension, MCP).
func (a *App) userFromRequest(c *gin.Context) (*User, error) {
	bearer := ""
	if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
		bearer = strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	} else if t := c.Query("token"); t != "" && c.FullPath() == "/api/v1/ws" && isSessionToken(t) {
		bearer = t
	}
	if isSessionToken(bearer) {
		return a.sessionUser(c, bearer)
	}
	if bearer != "" {
		sum := sha256.Sum256([]byte(bearer))
		var u User
		err := a.db.QueryRow(c, `UPDATE api_tokens t SET last_used_at=now() FROM users u
			WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.id=t.user_id
			RETURNING u.id,u.email,u.name,u.avatar_color,u.created_at,t.kind`, hex.EncodeToString(sum[:])).
			Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt, &u.TokenKind)
		if err != nil {
			return nil, httpx.Unauthorized("Invalid, expired or revoked token")
		}
		return &u, nil
	}
	ck, err := c.Cookie(cookieName)
	if err != nil || ck == "" {
		return nil, httpx.Unauthorized("Please sign in")
	}
	return a.sessionUser(c, ck)
}

func (a *App) authMiddleware(c *gin.Context) {
	u, err := a.userFromRequest(c)
	if err != nil {
		httpx.WriteError(c, err)
		return
	}
	// API tokens may only reach the endpoints their kind needs.
	if (u.TokenKind == "extension" && !extensionAllowed(c.Request.Method, c.FullPath())) || u.TokenKind == "mcp" {
		httpx.WriteError(c, httpx.Forbidden("This token cannot be used here"))
		return
	}
	c.Set("user", u)
	c.Next()
}

func extensionAllowed(method, route string) bool {
	switch {
	case strings.HasPrefix(route, "/api/v1/capture/"), strings.HasPrefix(route, "/api/v1/goal/"), route == "/api/v1/pages/:id/preview", route == "/api/v1/me",
		route == "/api/v1/extension/state", route == "/api/v1/workspaces" && method == "GET":
		return true
	}
	return false
}

/* ---------------------------------------------------------------- API tokens */

type ApiToken struct {
	ID         string     `json:"id" db:"id"`
	Name       string     `json:"name" db:"name"`
	Kind       string     `json:"kind" db:"kind"`
	CreatedAt  time.Time  `json:"created_at" db:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at" db:"last_used_at"`
	RevokedAt  *time.Time `json:"revoked_at" db:"revoked_at"`
}

func (a *App) listTokens(c *gin.Context) error {
	rows, _ := a.db.Query(c, `SELECT id,name,kind,created_at,last_used_at,revoked_at FROM api_tokens
		WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, currentUser(c).ID)
	out, err := pgx.CollectRows(rows, pgx.RowToStructByName[ApiToken])
	if err != nil {
		return err
	}
	c.JSON(200, out)
	return nil
}

func (a *App) createToken(c *gin.Context) error {
	var b struct {
		Kind, Name    string
		ExpiresInDays int `json:"expires_in_days"` // optional; 0 = never expires
	}
	if err := bind(c, &b); err != nil {
		return err
	}
	if b.ExpiresInDays < 0 || b.ExpiresInDays > 3650 {
		return httpx.Validation("expires_in_days must be between 1 and 3650")
	}
	var expires *time.Time
	if b.ExpiresInDays > 0 {
		t := time.Now().Add(time.Duration(b.ExpiresInDays) * 24 * time.Hour)
		expires = &t
	}
	if b.Kind != "extension" && b.Kind != "mcp" {
		return httpx.Validation("kind must be extension or mcp")
	}
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" || len(b.Name) > 60 {
		b.Name = b.Kind
	}
	raw := make([]byte, 24)
	_, _ = rand.Read(raw)
	plain := "rm_" + b.Kind[:3] + "_" + hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(plain))
	rows, _ := a.db.Query(c, `INSERT INTO api_tokens (user_id,name,kind,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)
		RETURNING id,name,kind,created_at,last_used_at,revoked_at`, currentUser(c).ID, b.Name, b.Kind, hex.EncodeToString(sum[:]), expires)
	t, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[ApiToken])
	if err != nil {
		return err
	}
	c.JSON(201, gin.H{"id": t.ID, "name": t.Name, "kind": t.Kind, "created_at": t.CreatedAt,
		"last_used_at": nil, "revoked_at": nil, "expires_at": expires, "token": plain})
	return nil
}

func (a *App) revokeToken(c *gin.Context) error {
	tag, err := a.db.Exec(c, `UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
		c.Param("id"), currentUser(c).ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("Token")
	}
	mcpAuthCache.Clear() // the cache is keyed by the raw token, so drop every entry
	c.Status(204)
	return nil
}

/* ---------------------------------------------------------------- rate limiter */

type rateLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{max: max, window: window, hits: map[string][]time.Time{}}
}

func (r *rateLimiter) allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	h := r.hits[key][:0]
	for _, t := range r.hits[key] {
		if now.Sub(t) < r.window {
			h = append(h, t)
		}
	}
	if len(h) >= r.max {
		r.hits[key] = h
		return false
	}
	r.hits[key] = append(h, now)
	return true
}
