-- +goose Up
-- "Different context" pairs do not disagree, so they are no longer shown as conflicts.
UPDATE conflicts SET status='dismissed' WHERE label='different_context' AND status='open';

-- +goose Down
SELECT 1;
