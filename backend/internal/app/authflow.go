package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/mail"
	"strings"
	"time"
	"unicode"

	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	codeTTL      = 10 * time.Minute
	codeCooldown = time.Minute
	codeAttempts = 5
)

/* ---------------------------------------------------------------- validation */

// Throw-away inbox services: sign-ups from them are refused.
var disposableDomains = map[string]bool{
	"mailinator.com": true, "guerrillamail.com": true, "10minutemail.com": true, "tempmail.com": true, "temp-mail.org": true,
	"yopmail.com": true, "trashmail.com": true, "getnada.com": true, "sharklasers.com": true, "dispostable.com": true,
	"maildrop.cc": true, "fakeinbox.com": true, "throwawaymail.com": true, "mintemail.com": true, "emailondeck.com": true,
}

// checkEmail returns the normalised address, or a message for the user.
func checkEmail(ctx context.Context, raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	addr, err := mail.ParseAddress(email)
	at := strings.LastIndex(email, "@")
	if err != nil || addr.Address != email || len(email) > 254 || at < 1 || !strings.Contains(email[at+1:], ".") {
		return "", httpx.Validation("Enter a valid email address, for example name@company.com")
	}
	domain := email[at+1:]
	if disposableDomains[domain] {
		return "", httpx.Validation("Temporary email addresses are not accepted. Please use your own email.")
	}
	// The domain must be able to receive email. Only a clear "does not exist" answer is refused, so a slow DNS
	// server never blocks a real address; the email code then proves the inbox is real.
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if _, err := net.DefaultResolver.LookupMX(ctx, domain); err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			if _, err := net.DefaultResolver.LookupHost(ctx, domain); err != nil {
				return "", httpx.Validation("This email domain does not exist. Please check the address.")
			}
		}
	}
	return email, nil
}

var commonPasswords = []string{"password", "12345678", "123456789", "qwerty", "letmein", "welcome", "iloveyou", "admin123", "abc12345"}

// checkPassword enforces the strong password rules that the sign-up form also shows.
func checkPassword(pw, email, name string) error {
	if len(pw) < 8 || len(pw) > 72 {
		return httpx.Validation("Password must be 8 to 72 characters long.")
	}
	var lower, upper, digit, symbol bool
	for _, r := range pw {
		switch {
		case unicode.IsLower(r):
			lower = true
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsDigit(r):
			digit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r) || r == ' ':
			symbol = true
		}
	}
	if !lower || !upper || !digit || !symbol {
		return httpx.Validation("Password must include an uppercase letter, a lowercase letter, a number and a symbol.")
	}
	low := strings.ToLower(pw)
	for _, c := range commonPasswords {
		if strings.Contains(low, c) {
			return httpx.Validation("This password is too common. Please choose a different one.")
		}
	}
	if local, _, _ := strings.Cut(email, "@"); len(local) >= 3 && strings.Contains(low, local) {
		return httpx.Validation("Password must not contain your email address.")
	}
	for _, part := range strings.Fields(strings.ToLower(name)) {
		if len(part) >= 3 && strings.Contains(low, part) {
			return httpx.Validation("Password must not contain your name.")
		}
	}
	return nil
}

func checkName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if len([]rune(name)) < 2 || len([]rune(name)) > 80 {
		return "", httpx.Validation("Enter your name (2 to 80 characters).")
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsMark(r) && r != ' ' && r != '\'' && r != '-' && r != '.' {
			return "", httpx.Validation("Your name can contain only letters, spaces, apostrophes, dots and hyphens.")
		}
	}
	return name, nil
}

/* ---------------------------------------------------------------- email codes */

func newCode() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

func codeHash(email, purpose, code string) string {
	sum := sha256.Sum256([]byte(email + "|" + purpose + "|" + code))
	return hex.EncodeToString(sum[:])
}

// issueCode saves a new code (one per email and purpose, at most one per minute) and emails it.
// With DEV_AUTH_CODES (development only) the code is returned instead of emailed, for automated tests.
func (a *App) issueCode(ctx context.Context, email, purpose, name string, passwordHash *string) (string, error) {
	var sentAt time.Time
	err := a.db.QueryRow(ctx, `SELECT sent_at FROM email_codes WHERE email=$1 AND purpose=$2`, email, purpose).Scan(&sentAt)
	if err == nil && time.Since(sentAt) < codeCooldown {
		wait := int((codeCooldown - time.Since(sentAt)).Seconds()) + 1
		return "", httpx.RateLimited(fmt.Sprintf("A code was just sent. Please wait %d seconds before asking for a new one.", wait))
	}
	code := newCode()
	if _, err := a.db.Exec(ctx, `INSERT INTO email_codes (email,purpose,code_hash,name,password_hash,expires_at)
		VALUES ($1,$2,$3,$4,$5,now()+$6::interval)
		ON CONFLICT (email,purpose) DO UPDATE SET code_hash=EXCLUDED.code_hash, name=coalesce(EXCLUDED.name,email_codes.name),
		  password_hash=coalesce(EXCLUDED.password_hash,email_codes.password_hash), attempts=0, sent_at=now(), expires_at=EXCLUDED.expires_at`,
		email, purpose, codeHash(email, purpose, code), nullIfEmpty(name), passwordHash, fmt.Sprintf("%d seconds", int(codeTTL.Seconds()))); err != nil {
		return "", err
	}
	if a.cfg.DevAuthCodes {
		return code, nil
	}
	if err := a.sendCodeEmail(email, name, code, purpose); err != nil {
		slog.Error("[MAIL] could not send email code", "to", email, "err", err)
		_, _ = a.db.Exec(ctx, `DELETE FROM email_codes WHERE email=$1 AND purpose=$2`, email, purpose)
		return "", httpx.NewError(503, httpx.CodeInternal, "We could not send the email right now. Please try again in a moment.")
	}
	slog.Info("[AUTH] email code sent", "to", email, "purpose", purpose)
	return "", nil
}

// codeReply adds the code to a response only in development test mode.
func codeReply(h gin.H, devCode string) gin.H {
	if devCode != "" {
		h["dev_code"] = devCode
	}
	return h
}

type pendingCode struct {
	name, passwordHash string
}

// useCode checks a code and deletes it once it is used, expired or guessed wrong too many times.
func (a *App) useCode(ctx context.Context, email, purpose, code string) (pendingCode, error) {
	var p pendingCode
	var hash string
	var attempts int
	var expires time.Time
	err := a.db.QueryRow(ctx, `SELECT code_hash, coalesce(name,''), coalesce(password_hash,''), attempts, expires_at
		FROM email_codes WHERE email=$1 AND purpose=$2`, email, purpose).Scan(&hash, &p.name, &p.passwordHash, &attempts, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpx.Validation("This code is no longer valid. Please request a new code.")
	}
	if err != nil {
		return p, err
	}
	remove := func() { _, _ = a.db.Exec(ctx, `DELETE FROM email_codes WHERE email=$1 AND purpose=$2`, email, purpose) }
	if time.Now().After(expires) {
		remove()
		return p, httpx.Validation("This code has expired. Please request a new code.")
	}
	code = strings.TrimSpace(code)
	if subtle.ConstantTimeCompare([]byte(hash), []byte(codeHash(email, purpose, code))) != 1 {
		if attempts+1 >= codeAttempts {
			remove()
			return p, httpx.Validation("Too many wrong codes. Please request a new code.")
		}
		_, _ = a.db.Exec(ctx, `UPDATE email_codes SET attempts=attempts+1 WHERE email=$1 AND purpose=$2`, email, purpose)
		return p, httpx.Validation(fmt.Sprintf("The code is not correct. %d attempts left.", codeAttempts-attempts-1))
	}
	remove()
	return p, nil
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

/* ---------------------------------------------------------------- handlers */

// register checks the details and emails a code. The account is created only when the code is confirmed.
func (a *App) register(c *gin.Context) error {
	if !a.limiter.allow("reg:" + c.ClientIP()) {
		return httpx.RateLimited("Too many attempts. Please try again in a minute.")
	}
	var b struct{ Name, Email, Password string }
	if err := bind(c, &b); err != nil {
		return err
	}
	name, err := checkName(b.Name)
	if err != nil {
		return err
	}
	email, err := checkEmail(c, b.Email)
	if err != nil {
		return err
	}
	if err := checkPassword(b.Password, email, name); err != nil {
		return err
	}
	var exists bool
	if err := a.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM users WHERE email=$1)`, email).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return httpx.NewError(409, httpx.CodeConflict, "An account with this email already exists. Please sign in instead.")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if err != nil {
		return err
	}
	h := string(hash)
	if !a.cfg.EmailVerification {
		// No email code on this server: the checked details create the account straight away.
		u, err := a.createUser(c, email, name, &h, nil)
		if err != nil {
			return err
		}
		slog.Info("[AUTH] account created", "user_id", u.ID, "via", "email (no code)")
		return a.signedIn(c, 201, u)
	}
	devCode, err := a.issueCode(c, email, "signup", name, &h)
	if err != nil {
		return err
	}
	c.JSON(202, codeReply(gin.H{"verification_required": true, "email": email}, devCode))
	return nil
}

// verifyEmail confirms the sign-up code, creates the account and signs the user in.
func (a *App) verifyEmail(c *gin.Context) error {
	var b struct{ Email, Code string }
	if err := bind(c, &b); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !a.limiter.allow("verify:"+c.ClientIP()) || !a.limiter.allow("verify:"+email) {
		return httpx.RateLimited("Too many attempts. Please try again in a minute.")
	}
	p, err := a.useCode(c, email, "signup", b.Code)
	if err != nil {
		return err
	}
	u, err := a.createUser(c, email, p.name, &p.passwordHash, nil)
	if err != nil {
		return err
	}
	slog.Info("[AUTH] account created", "user_id", u.ID, "via", "email")
	return a.signedIn(c, 201, u)
}

// resendCode sends a new sign-up code for a sign-up that is waiting for confirmation.
func (a *App) resendCode(c *gin.Context) error {
	var b struct{ Email string }
	if err := bind(c, &b); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !a.limiter.allow("resend:" + c.ClientIP()) {
		return httpx.RateLimited("Too many attempts. Please try again in a minute.")
	}
	var name string
	err := a.db.QueryRow(c, `SELECT coalesce(name,'') FROM email_codes WHERE email=$1 AND purpose='signup'`, email).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Validation("Your sign-up has expired. Please fill in the form again.")
	}
	if err != nil {
		return err
	}
	devCode, err := a.issueCode(c, email, "signup", name, nil)
	if err != nil {
		return err
	}
	c.JSON(202, codeReply(gin.H{"sent": true}, devCode))
	return nil
}

// forgotPassword emails a reset code. The answer is the same whether or not the account exists.
func (a *App) forgotPassword(c *gin.Context) error {
	var b struct{ Email string }
	if err := bind(c, &b); err != nil {
		return err
	}
	if !a.cfg.EmailVerification {
		return httpx.Validation("Password reset by email is not available. Please sign in with Google instead.")
	}
	if !a.limiter.allow("forgot:" + c.ClientIP()) {
		return httpx.RateLimited("Too many attempts. Please try again in a minute.")
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		return httpx.Validation("Enter a valid email address.")
	}
	var name, devCode string
	err := a.db.QueryRow(c, `SELECT name FROM users WHERE email=$1`, email).Scan(&name)
	if err == nil {
		var he *httpx.Error
		if devCode, err = a.issueCode(c, email, "reset", name, nil); err != nil && !(errors.As(err, &he) && he.Status == 429) {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	c.JSON(202, codeReply(gin.H{"sent": true}, devCode))
	return nil
}

// resetPassword sets a new password after the reset code is confirmed, then signs the user in.
func (a *App) resetPassword(c *gin.Context) error {
	var b struct{ Email, Code, Password string }
	if err := bind(c, &b); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !a.limiter.allow("reset:"+c.ClientIP()) || !a.limiter.allow("reset:"+email) {
		return httpx.RateLimited("Too many attempts. Please try again in a minute.")
	}
	var u User
	err := a.db.QueryRow(c, `SELECT id,email,name,avatar_color,created_at FROM users WHERE email=$1`, email).
		Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Validation("This code is no longer valid. Please request a new code.")
	}
	if err != nil {
		return err
	}
	if err := checkPassword(b.Password, email, u.Name); err != nil {
		return err
	}
	if _, err := a.useCode(c, email, "reset", b.Code); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if err != nil {
		return err
	}
	if _, err := a.db.Exec(c, `UPDATE users SET password_hash=$2 WHERE id=$1`, u.ID, string(hash)); err != nil {
		return err
	}
	slog.Info("[AUTH] password reset", "user_id", u.ID)
	return a.signedIn(c, 200, u)
}

// createUser inserts a verified account (email code confirmed, or signed in with Google).
func (a *App) createUser(ctx context.Context, email, name string, passwordHash, googleSub *string) (User, error) {
	var n int
	_ = a.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	var u User
	err := a.db.QueryRow(ctx, `INSERT INTO users (email,name,password_hash,avatar_color,google_sub) VALUES ($1,$2,$3,$4,$5)
		RETURNING id,email,name,avatar_color,created_at`, email, name, passwordHash, avatarColors[n%len(avatarColors)], googleSub).
		Scan(&u.ID, &u.Email, &u.Name, &u.AvatarColor, &u.CreatedAt)
	if isUnique(err) {
		return u, httpx.NewError(409, httpx.CodeConflict, "An account with this email already exists. Please sign in instead.")
	}
	return u, err
}
