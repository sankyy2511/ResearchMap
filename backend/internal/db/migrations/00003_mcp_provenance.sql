-- +goose Up
-- MCP provenance (spec §18: "created_via = 'mcp' and the client name") and token expiry.
ALTER TABLE nodes ADD COLUMN client_name text;
ALTER TABLE edges ADD COLUMN client_name text;
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_origin_check;
ALTER TABLE edges ADD CONSTRAINT edges_origin_check CHECK (origin IN ('ai','user','navigation','link','embedding','mcp'));
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;

-- +goose Down
ALTER TABLE api_tokens DROP COLUMN IF EXISTS expires_at;
UPDATE edges SET origin='ai' WHERE origin='mcp';
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_origin_check;
ALTER TABLE edges ADD CONSTRAINT edges_origin_check CHECK (origin IN ('ai','user','navigation','link','embedding'));
ALTER TABLE edges DROP COLUMN IF EXISTS client_name;
ALTER TABLE nodes DROP COLUMN IF EXISTS client_name;
