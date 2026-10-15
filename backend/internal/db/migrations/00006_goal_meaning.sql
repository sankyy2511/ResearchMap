-- +goose Up
-- What the AI understood the goal to mean (short forms written in full), and whether the goal was unclear.
ALTER TABLE sessions ADD COLUMN goal_meaning text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN goal_unclear boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE sessions DROP COLUMN IF EXISTS goal_unclear;
ALTER TABLE sessions DROP COLUMN IF EXISTS goal_meaning;
