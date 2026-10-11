package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func clearEnv(t *testing.T) {
	for _, k := range []string{"APP_ENV", "API_ADDR", "DATABASE_URL", "WEB_ORIGINS", "TRUSTED_PROXIES", "DB_MAX_CONNS",
		"MAX_BODY_BYTES", "MIGRATE_ON_START", "SHUTDOWN_TIMEOUT", "LOG_LEVEL", "JWT_SECRET", "AGENT_INTERNAL_KEY"} {
		t.Setenv(k, "")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://u:p@localhost:5432/app")
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("AGENT_INTERNAL_KEY", "0123456789abcdef")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.MaxBodyBytes != 1<<20 || !c.MigrateOnStart || c.ShutdownTimeout != 20*time.Second {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if len(c.WebOrigins) != 1 || c.WebOrigins[0] != "http://localhost:3000" {
		t.Fatalf("origins: %v", c.WebOrigins)
	}
}

func TestLoadReportsAllErrors(t *testing.T) {
	clearEnv(t)
	t.Setenv("APP_ENV", "staging")
	t.Setenv("DB_MAX_CONNS", "0")
	t.Setenv("WEB_ORIGINS", "localhost:3000")
	_, err := Load()
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"APP_ENV", "DATABASE_URL", "DB_MAX_CONNS", "WEB_ORIGINS"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestLoadDotEnv(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".env")
	body := "# comment\nDOTENV_A=one\nexport DOTENV_B=\"two words\"\nDOTENV_C=three # note\nDOTENV_SET=file\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"DOTENV_A", "DOTENV_B", "DOTENV_C"} {
		os.Unsetenv(k)
		t.Cleanup(func() { os.Unsetenv(k) })
	}
	t.Setenv("DOTENV_SET", "real")
	if err := LoadDotEnv(p); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{"DOTENV_A": "one", "DOTENV_B": "two words", "DOTENV_C": "three", "DOTENV_SET": "real"} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if err := LoadDotEnv(filepath.Join(dir, "missing.env")); err != nil {
		t.Errorf("missing file should be ignored: %v", err)
	}
}
