package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const oauthCookie = "rm_oauth"

var googleHTTP = &http.Client{Timeout: 15 * time.Second}

func (a *App) webOrigin() string { return strings.TrimRight(a.cfg.WebOrigins[0], "/") }

// Google sends the user back to this backend: its public address (PUBLIC_API_URL) when the web app is hosted
// elsewhere, otherwise the web app address, which forwards /api here.
func (a *App) googleRedirectURI() string {
	base := a.cfg.PublicAPIURL
	if base == "" {
		base = a.webOrigin()
	}
	return base + "/api/v1/auth/google/callback"
}

// safeNextPath keeps redirects inside the web app.
func safeNextPath(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.Contains(p, "\\") {
		return "/workspaces"
	}
	return p
}

func (a *App) googleFail(c *gin.Context, reason string) {
	c.Redirect(http.StatusFound, a.webOrigin()+"/login?error="+url.QueryEscape(reason))
}

// googleStart sends the browser to Google's sign-in page.
func (a *App) googleStart(c *gin.Context) {
	if a.cfg.GoogleClientID == "" {
		a.googleFail(c, "google_off")
		return
	}
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	state := hex.EncodeToString(raw)
	next := safeNextPath(c.Query("next"))
	http.SetCookie(c.Writer, &http.Cookie{Name: oauthCookie, Value: state + "|" + url.QueryEscape(next), Path: "/api/v1/auth/google",
		HttpOnly: true, Secure: a.cfg.IsProduction(), SameSite: http.SameSiteLaxMode, MaxAge: 600})
	q := url.Values{
		"client_id": {a.cfg.GoogleClientID}, "redirect_uri": {a.googleRedirectURI()}, "response_type": {"code"},
		"scope": {"openid email profile"}, "state": {state}, "prompt": {"select_account"},
	}
	c.Redirect(http.StatusFound, "https://accounts.google.com/o/oauth2/v2/auth?"+q.Encode())
}

type googleProfile struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

// googleCallback finishes Google sign-in: checks the state, reads the verified profile and signs the user in.
func (a *App) googleCallback(c *gin.Context) {
	ck, _ := c.Cookie(oauthCookie)
	http.SetCookie(c.Writer, &http.Cookie{Name: oauthCookie, Value: "", Path: "/api/v1/auth/google", HttpOnly: true, MaxAge: -1,
		Secure: a.cfg.IsProduction(), SameSite: http.SameSiteLaxMode})
	state, nextEnc, _ := strings.Cut(ck, "|")
	if c.Query("error") != "" {
		a.googleFail(c, "google_cancelled")
		return
	}
	if state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(c.Query("state"))) != 1 || c.Query("code") == "" {
		a.googleFail(c, "google_failed")
		return
	}
	if !a.limiter.allow("google:" + c.ClientIP()) {
		a.googleFail(c, "google_failed")
		return
	}
	p, err := a.googleProfile(c, c.Query("code"))
	if err != nil {
		slog.Error("[AUTH] Google sign-in failed", "err", err)
		a.googleFail(c, "google_failed")
		return
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if p.Sub == "" || email == "" || !p.EmailVerified {
		a.googleFail(c, "google_unverified")
		return
	}
	u, created, err := a.googleUser(c, p.Sub, email, p.Name)
	if err != nil {
		slog.Error("[AUTH] Google account could not be saved", "err", err)
		a.googleFail(c, "google_failed")
		return
	}
	tok, err := a.newSession(c, u.ID)
	if err != nil {
		a.googleFail(c, "google_failed")
		return
	}
	next, _ := url.QueryUnescape(nextEnc)
	next = safeNextPath(next)
	if created { // new accounts see the extension install steps first
		next = "/extension?next=" + url.QueryEscape(next)
	}
	// The web app may be on another address, so the session token travels in the URL fragment, which browsers
	// never send to any server. The /signed-in page stores it and removes it from the address bar at once.
	c.Redirect(http.StatusFound, a.webOrigin()+"/signed-in#"+url.Values{"token": {tok}, "next": {next}}.Encode())
}

// googleProfile exchanges the one-time code for a token and reads the user's profile from Google.
func (a *App) googleProfile(ctx context.Context, code string) (googleProfile, error) {
	var p googleProfile
	form := url.Values{"code": {code}, "client_id": {a.cfg.GoogleClientID}, "client_secret": {a.cfg.GoogleClientSecret},
		"redirect_uri": {a.googleRedirectURI()}, "grant_type": {"authorization_code"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := googleHTTP.Do(req)
	if err != nil {
		return p, err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		return p, fmt.Errorf("token exchange: %s %s", tok.Error, tok.Description)
	}
	req, _ = http.NewRequestWithContext(ctx, http.MethodGet, "https://openidconnect.googleapis.com/v1/userinfo", nil)
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	res2, err := googleHTTP.Do(req)
	if err != nil {
		return p, err
	}
	defer res2.Body.Close()
	if res2.StatusCode != 200 {
		return p, fmt.Errorf("userinfo: status %d", res2.StatusCode)
	}
	return p, json.NewDecoder(res2.Body).Decode(&p)
}

// googleUser finds the account by Google id, links an existing account with the same (Google-verified) email,
// or creates a new account (created = true).
func (a *App) googleUser(ctx context.Context, sub, email, name string) (User, bool, error) {
	var u User
	err := a.db.QueryRow(ctx, `SELECT id,email,name,avatar_color,created_at FROM users WHERE google_sub=$1`, sub).
		Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt)
	if err == nil {
		return u, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return u, false, err
	}
	err = a.db.QueryRow(ctx, `UPDATE users SET google_sub=$1 WHERE email=$2 AND google_sub IS NULL
		RETURNING id,email,name,avatar_color,created_at`, sub, email).Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt)
	if err == nil {
		slog.Info("[AUTH] Google linked to existing account", "user_id", u.ID)
		return u, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return u, false, err
	}
	if name = strings.Join(strings.Fields(name), " "); name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if len([]rune(name)) > 80 {
		name = string([]rune(name)[:80])
	}
	u, err = a.createUser(ctx, email, name, nil, &sub)
	if err == nil {
		slog.Info("[AUTH] account created", "user_id", u.ID, "via", "google")
	}
	return u, err == nil, err
}
