-- +goose Up
-- Extensions used across the schema: pgvector (embeddings), pg_trgm (fuzzy search),
-- pgcrypto (gen_random_uuid, digest).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- +goose Down
-- Extensions are left in place on purpose: other database objects may depend on them.
SELECT 1;
