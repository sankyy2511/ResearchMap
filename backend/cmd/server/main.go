package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/SanketBhandarii/3-idiots/backend/internal/app"
	"github.com/SanketBhandarii/3-idiots/backend/internal/config"
	"github.com/SanketBhandarii/3-idiots/backend/internal/db"
	"github.com/SanketBhandarii/3-idiots/backend/internal/httpx"
)

func main() {
	time.Local = time.UTC // every timestamp in JSON is UTC
	for _, envPath := range []string{".env", "backend/.env", "../backend/.env"} {
		if err := config.LoadDotEnv(envPath); err != nil {
			slog.Error("read "+envPath, "err", err)
			os.Exit(1)
		}
	}
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel})))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	if cfg.MigrateOnStart {
		v, err := db.Migrate(ctx, pool)
		if err != nil {
			slog.Error("migrations", "err", err)
			os.Exit(1)
		}
		slog.Info("schema ready", "version", v)
	}

	engine, err := httpx.NewEngine(httpx.EngineOptions{Production: cfg.IsProduction(), MaxBodyBytes: cfg.MaxBodyBytes, TrustedProxies: cfg.TrustedProxies})
	if err != nil {
		slog.Error("engine", "err", err)
		os.Exit(1)
	}
	a := app.New(cfg, pool)
	a.Routes(engine)
	a.Start(ctx)

	srv := &http.Server{Addr: cfg.Addr, Handler: engine, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		slog.Info("api listening", "addr", cfg.Addr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	slog.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	_ = srv.Shutdown(sctx)
}
