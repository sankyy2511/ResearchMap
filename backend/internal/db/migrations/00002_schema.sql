-- +goose Up
-- IDs are UUID strings stored as text (gen_random_uuid()::text) so they map 1:1 to the JSON contract.

CREATE TABLE users (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  avatar_color  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('extension','mcp')),
  token_hash   text UNIQUE NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE workspaces (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id    text NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  settings    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE workspace_members (
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  joined_at      timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user ON workspace_members(user_id);

CREATE TABLE branches (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('main','personal','agent')),
  owner_id     text REFERENCES users(id),
  name         text NOT NULL,
  color        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_main_branch ON branches(workspace_id) WHERE kind = 'main';

CREATE TABLE share_links (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   text UNIQUE NOT NULL,
  token_enc    text NOT NULL,           -- AES-GCM encrypted token so owners can copy the link again
  role         text NOT NULL CHECK (role IN ('editor','viewer')),
  created_by   text NOT NULL REFERENCES users(id),
  expires_at   timestamptz,
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE view_states (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id),
  branch_id    text NOT NULL REFERENCES branches(id),
  title        text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  open_tabs    jsonb NOT NULL DEFAULT '[]',
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','stopped')),
  paused_ms    bigint NOT NULL DEFAULT 0,
  paused_at    timestamptz
);
CREATE INDEX sessions_ws ON sessions(workspace_id, started_at DESC);
CREATE UNIQUE INDEX one_open_session ON sessions(workspace_id, user_id) WHERE state <> 'stopped';

CREATE TABLE pages (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url                 text NOT NULL,
  url_normalized      text NOT NULL,
  domain              text NOT NULL,
  title               text NOT NULL,
  favicon_url         text,
  og_image_url        text,
  site_name           text,
  author              text,
  published_at        timestamptz,
  lang                text,
  content_text        text NOT NULL DEFAULT '',
  content_hash        text NOT NULL DEFAULT '',
  word_count          int  NOT NULL DEFAULT 0,
  outgoing_links      jsonb NOT NULL DEFAULT '[]',
  analysis_status     text NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','done','failed','skipped')),
  is_research         boolean,
  is_research_reason  text,
  page_type           text,
  main_concept        text,
  summary             text,
  topics              jsonb NOT NULL DEFAULT '[]',
  questions_answered  jsonb NOT NULL DEFAULT '[]',
  embedding           vector(384),
  embeddable          boolean NOT NULL DEFAULT true,
  preview             bytea,
  preview_mime        text,
  preview_captured_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  search_tsv          tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary,'')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(content_text,''), 50000)), 'C')) STORED,
  UNIQUE (workspace_id, url_normalized)
);
CREATE INDEX pages_embedding ON pages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX pages_tsv ON pages USING gin (search_tsv);
CREATE INDEX pages_title_trgm ON pages USING gin (title gin_trgm_ops);

CREATE TABLE claims (
  id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id   text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  text      text NOT NULL,
  quote     text NOT NULL,
  embedding vector(384)
);
CREATE INDEX claims_page ON claims(page_id);

CREATE TABLE categories (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('topic','source','importance','custom')),
  name         text NOT NULL,
  color        text NOT NULL
);

CREATE TABLE tags (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL
);
CREATE UNIQUE INDEX tags_name ON tags(workspace_id, lower(name));

CREATE TABLE nodes (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id       text NOT NULL REFERENCES branches(id),
  type            text NOT NULL CHECK (type IN ('page','question','note','finding','topic')),
  page_id         text REFERENCES pages(id) ON DELETE SET NULL,
  parent_id       text REFERENCES nodes(id) ON DELETE SET NULL,
  origin_node_id  text REFERENCES nodes(id) ON DELETE SET NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  x               double precision NOT NULL DEFAULT 0,
  y               double precision NOT NULL DEFAULT 0,
  width           double precision,
  height          double precision,
  collapsed       boolean NOT NULL DEFAULT false,
  category_id     text REFERENCES categories(id) ON DELETE SET NULL,
  importance      smallint CHECK (importance BETWEEN 1 AND 3),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inbox','analyzing')),
  position_locked boolean NOT NULL DEFAULT false,
  group_locked    boolean NOT NULL DEFAULT false,
  name_locked     boolean NOT NULL DEFAULT false,
  why_opened      jsonb NOT NULL DEFAULT '{}',
  created_by      text REFERENCES users(id),
  created_via     text NOT NULL CHECK (created_via IN ('extension','manual','ai','mcp','import')),
  version         int NOT NULL DEFAULT 1,
  ai_stage        text NOT NULL DEFAULT 'ready',
  duplicate_of    text REFERENCES nodes(id) ON DELETE SET NULL,
  tag_ids         text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX nodes_ws ON nodes(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_page ON nodes(page_id);

CREATE TABLE edges (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id    text NOT NULL REFERENCES branches(id),
  source_id    text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id    text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation     text NOT NULL,
  label        text,
  reason       text,
  evidence     jsonb NOT NULL DEFAULT '[]',
  confidence   real,
  origin       text NOT NULL CHECK (origin IN ('ai','user','navigation','link','embedding')),
  state        text NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','accepted','rejected')),
  locked       boolean NOT NULL DEFAULT false,
  created_by   text REFERENCES users(id),
  decided_by   text REFERENCES users(id),
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, target_id, relation)
);
CREATE INDEX edges_ws ON edges(workspace_id);

CREATE TABLE annotations (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id      text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('note','highlight','comment')),
  body         text NOT NULL DEFAULT '',
  quote        text,
  fragment_url text,
  parent_id    text REFERENCES annotations(id) ON DELETE CASCADE,
  resolved     boolean NOT NULL DEFAULT false,
  author_id    text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX annotations_ws ON annotations(workspace_id);

CREATE TABLE visits (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id     text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id),
  page_id        text REFERENCES pages(id) ON DELETE SET NULL,
  url            text NOT NULL,
  url_normalized text NOT NULL,
  tab_id         int,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  CHECK (ended_at >= started_at),
  UNIQUE (session_id, url_normalized, started_at)
);
CREATE INDEX visits_ws ON visits(workspace_id, started_at);

CREATE TABLE session_references (
  session_id        text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id           text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ref_number        int NOT NULL,
  first_accessed_at timestamptz NOT NULL DEFAULT now(),
  added_by          text REFERENCES users(id),
  PRIMARY KEY (session_id, page_id),
  UNIQUE (session_id, ref_number)
);

CREATE TABLE conflicts (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_a_id       text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_b_id       text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label           text NOT NULL,
  analysis        jsonb NOT NULL,
  confidence      real NOT NULL,
  status          text NOT NULL DEFAULT 'open',
  resolution_note text,
  resolved_by     text REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_a_id, node_b_id)
);

CREATE TABLE reports (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id   text UNIQUE NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status       text NOT NULL,
  model        text NOT NULL,
  content      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_item_states (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_key     text NOT NULL,
  status       text NOT NULL DEFAULT 'open',
  suggestions  jsonb,
  PRIMARY KEY (workspace_id, item_key)
);

CREATE TABLE reorganize_undo (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  token        text NOT NULL,
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS events, reorganize_undo, radar_item_states, reports, conflicts, session_references, visits,
  annotations, edges, nodes, tags, categories, claims, pages, sessions, view_states, share_links, branches,
  workspace_members, workspaces, api_tokens, users CASCADE;
