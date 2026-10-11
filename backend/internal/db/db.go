// Package db owns the PostgreSQL connection pool and schema migrations.
// Go is the only component that talks to the database.
package db

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pool and waits for the database. Serverless Postgres (Neon) can take a few
// seconds to wake up, so the first ping is retried with backoff before giving up.
func Connect(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err) // pgx errors do not include the password
	}
	cfg.MaxConns = maxConns
	cfg.MinConns = min(2, maxConns) // keep warm connections: a new TLS connection to a remote database costs several round trips
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "research-map-api"

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	delay := time.Second
	for attempt := 1; ; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = pool.Ping(pctx)
		cancel()
		if err == nil {
			return pool, nil
		}
		if attempt == 5 || ctx.Err() != nil {
			pool.Close()
			return nil, fmt.Errorf("database not reachable after %d attempts: %w", attempt, err)
		}
		slog.Warn("database not ready, retrying", "attempt", attempt, "in", delay.String(), "err", err)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
		}
		delay *= 2
	}
}
