-- +goose Up
-- Remember which share link granted a membership, so disabling that link revokes the access it granted
-- (and only that access: members who joined through another link, or were added directly, keep theirs).
ALTER TABLE workspace_members ADD COLUMN share_link_id text REFERENCES share_links(id) ON DELETE SET NULL;
CREATE INDEX members_share_link ON workspace_members(share_link_id) WHERE share_link_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS members_share_link;
ALTER TABLE workspace_members DROP COLUMN IF EXISTS share_link_id;
