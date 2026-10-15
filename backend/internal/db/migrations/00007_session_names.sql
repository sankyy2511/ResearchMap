-- +goose Up
-- Old sessions were called "Session 1", "Session 2". Name them after their goal, or after their date.
UPDATE sessions SET title = CASE WHEN goal <> '' THEN left(goal, 80) ELSE 'Research on ' || to_char(started_at, 'FMDD Mon') END
WHERE title ~ '^Session [0-9]+$';

-- +goose Down
SELECT 1;
