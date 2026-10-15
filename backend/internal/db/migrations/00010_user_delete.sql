-- +goose Up
-- Deleting a user removes their own data (workspaces, sessions, notes, visits, share links).
-- Content they added to other people's shared workspaces stays, without the author link.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_owner_id_fkey,
  ADD CONSTRAINT workspaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_created_by_fkey,
  ADD CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey,
  ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE annotations DROP CONSTRAINT IF EXISTS annotations_author_id_fkey,
  ADD CONSTRAINT annotations_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_user_id_fkey,
  ADD CONSTRAINT visits_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_owner_id_fkey,
  ADD CONSTRAINT branches_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_created_by_fkey,
  ADD CONSTRAINT nodes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_created_by_fkey,
  ADD CONSTRAINT edges_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_decided_by_fkey,
  ADD CONSTRAINT edges_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE session_references DROP CONSTRAINT IF EXISTS session_references_added_by_fkey,
  ADD CONSTRAINT session_references_added_by_fkey FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conflicts DROP CONSTRAINT IF EXISTS conflicts_resolved_by_fkey,
  ADD CONSTRAINT conflicts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
SELECT 1;
