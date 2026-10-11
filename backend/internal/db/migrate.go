package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// RequiredExtensions must exist for the app to work (checked by /readyz).
var RequiredExtensions = []string{"vector", "pg_trgm", "pgcrypto"}

func newProvider(pool *pgxpool.Pool) (*goose.Provider, error) {
	fsys, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	// A Postgres advisory lock stops two servers from migrating at the same time.
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, stdlib.OpenDBFromPool(pool), fsys,
		goose.WithSessionLocker(locker))
}

// Migrate applies all pending migrations and returns the resulting schema version.
func Migrate(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	p, err := newProvider(pool)
	if err != nil {
		return 0, err
	}
	results, err := p.Up(ctx)
	if err != nil {
		return 0, fmt.Errorf("migrate up: %w", err)
	}
	for _, r := range results {
		slog.Info("migration applied", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration.String())
	}
	return p.GetDBVersion(ctx)
}

// SchemaVersion returns the applied version and whether migrations are still pending.
func SchemaVersion(ctx context.Context, pool *pgxpool.Pool) (version int64, pending bool, err error) {
	p, err := newProvider(pool)
	if err != nil {
		return 0, false, err
	}
	if version, err = p.GetDBVersion(ctx); err != nil {
		return 0, false, err
	}
	pending, err = p.HasPending(ctx)
	return version, pending, err
}
