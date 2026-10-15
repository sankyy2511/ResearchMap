-- +goose Up
-- Session goal: what the user wants to finish in this session, the key topics the AI split it into,
-- and one relevance check per page the user opened (also the cache: a page is checked once per session).
ALTER TABLE sessions ADD COLUMN goal text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN goal_topics jsonb NOT NULL DEFAULT '[]';

CREATE TABLE goal_checks (
  session_id     text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_normalized text NOT NULL,
  url            text NOT NULL,
  domain         text NOT NULL,
  title          text NOT NULL DEFAULT '',
  on_goal        boolean NOT NULL,
  score          smallint NOT NULL DEFAULT 50,
  reason         text NOT NULL DEFAULT '',
  covers         jsonb NOT NULL DEFAULT '[]',   -- indexes into sessions.goal_topics
  source         text NOT NULL CHECK (source IN ('ai','similarity','user')),
  checked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url_normalized)
);

-- +goose Down
DROP TABLE IF EXISTS goal_checks;
ALTER TABLE sessions DROP COLUMN IF EXISTS goal_topics;
ALTER TABLE sessions DROP COLUMN IF EXISTS goal;
