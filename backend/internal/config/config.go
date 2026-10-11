// Package config loads and validates all runtime settings from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env             string // "development" or "production"
	Addr            string
	DatabaseURL     string
	DBMaxConns      int32
	WebOrigins      []string // browser origins allowed for WebSocket and state-changing requests
	TrustedProxies  []string
	MaxBodyBytes    int64
	LogLevel        slog.Level
	MigrateOnStart  bool
	ShutdownTimeout time.Duration
	JWTSecret       string
	AgentURL        string
	AgentKey        string
	// Email codes (sign-up and password reset). Without SMTP_USER, codes are only written to the log (development).
	SMTPHost, SMTPPort, SMTPUser, SMTPPassword, MailFrom string
	// EMAIL_VERIFICATION=false creates accounts without an email code and turns off password reset by email
	// (for hosts that block outgoing email). Default true.
	EmailVerification bool
	// Google sign-in; turned off when GOOGLE_CLIENT_ID is empty.
	GoogleClientID, GoogleClientSecret string
	// Development only: email codes are returned in the response instead of emailed (automated tests).
	DevAuthCodes bool
	// Public address of this backend (for example https://api.example.com) when the web app is
	// hosted on another address. Used for the Google sign-in return address. Empty: the web app forwards /api here.
	PublicAPIURL string
}

func (c Config) IsProduction() bool { return c.Env == "production" }

// Load reads the environment and returns every validation problem at once.
func Load() (Config, error) {
	var errs []error
	c := Config{
		Env:            get("APP_ENV", "development"),
		Addr:           get("API_ADDR", ":8080"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		WebOrigins:     list(get("WEB_ORIGINS", "http://localhost:3000")),
		TrustedProxies: list(get("TRUSTED_PROXIES", "127.0.0.1,::1")),
	}

	c.JWTSecret = os.Getenv("JWT_SECRET")
	c.AgentURL = strings.TrimRight(get("AGENT_URL", "http://127.0.0.1:8000"), "/")
	c.AgentKey = os.Getenv("AGENT_INTERNAL_KEY")
	c.SMTPHost, c.SMTPPort = get("SMTP_HOST", "smtp.gmail.com"), get("SMTP_PORT", "587")
	c.SMTPUser, c.SMTPPassword = get("SMTP_USER", ""), strings.ReplaceAll(os.Getenv("SMTP_PASSWORD"), " ", "")
	c.MailFrom = get("MAIL_FROM", c.SMTPUser)
	c.GoogleClientID, c.GoogleClientSecret = get("GOOGLE_CLIENT_ID", ""), get("GOOGLE_CLIENT_SECRET", "")
	c.PublicAPIURL = strings.TrimRight(get("PUBLIC_API_URL", ""), "/")
	if u, err := url.Parse(c.PublicAPIURL); c.PublicAPIURL != "" && (err != nil || u.Scheme == "" || u.Host == "" || u.Path != "") {
		errs = append(errs, errors.New("PUBLIC_API_URL must look like https://host, without a path"))
	}
	if c.SMTPUser != "" && c.SMTPPassword == "" {
		errs = append(errs, errors.New("SMTP_PASSWORD is required when SMTP_USER is set"))
	}
	c.EmailVerification = boolVar("EMAIL_VERIFICATION", true, &errs)
	if c.SMTPUser == "" && c.EmailVerification && c.Env == "production" {
		errs = append(errs, errors.New("SMTP_USER and SMTP_PASSWORD are required in production (email codes), or set EMAIL_VERIFICATION=false"))
	}
	if (c.GoogleClientID == "") != (c.GoogleClientSecret == "") {
		errs = append(errs, errors.New("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together"))
	}
	if len(c.JWTSecret) < 32 {
		errs = append(errs, errors.New("JWT_SECRET must be at least 32 characters"))
	}
	if len(c.AgentKey) < 16 {
		errs = append(errs, errors.New("AGENT_INTERNAL_KEY must be at least 16 characters"))
	}
	if c.Env != "development" && c.Env != "production" {
		errs = append(errs, fmt.Errorf("APP_ENV must be development or production, got %q", c.Env))
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	} else if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		errs = append(errs, errors.New("DATABASE_URL must be a postgres:// URL"))
	}
	for _, o := range c.WebOrigins {
		if u, err := url.Parse(o); err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" {
			errs = append(errs, fmt.Errorf("WEB_ORIGINS entry %q must look like https://host[:port]", o))
		}
	}

	c.DBMaxConns = int32(intVar("DB_MAX_CONNS", 10, 1, 100, &errs))
	c.MaxBodyBytes = int64(intVar("MAX_BODY_BYTES", 1<<20, 1024, 20<<20, &errs))
	c.MigrateOnStart = boolVar("MIGRATE_ON_START", true, &errs)
	c.DevAuthCodes = boolVar("DEV_AUTH_CODES", false, &errs)
	if c.DevAuthCodes && c.Env == "production" {
		errs = append(errs, errors.New("DEV_AUTH_CODES must not be used in production"))
	}
	c.ShutdownTimeout = durVar("SHUTDOWN_TIMEOUT", 20*time.Second, &errs)

	if err := c.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}
	return c, errors.Join(errs...)
}

func get(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func list(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimRight(strings.TrimSpace(p), "/"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func intVar(key string, def, min, max int, errs *[]error) int {
	v := get(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		*errs = append(*errs, fmt.Errorf("%s must be a number between %d and %d", key, min, max))
		return def
	}
	return n
}

func boolVar(key string, def bool, errs *[]error) bool {
	v := get(key, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		*errs = append(*errs, fmt.Errorf("%s must be true or false", key))
		return def
	}
	return b
}

func durVar(key string, def time.Duration, errs *[]error) time.Duration {
	v := get(key, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		*errs = append(*errs, fmt.Errorf("%s must be a duration like 20s", key))
		return def
	}
	return d
}
