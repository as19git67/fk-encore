-- Track who invited each album participant. Used to let a write_share
-- participant remove only the shares they themselves created, without
-- giving them permission to revoke shares the owner (or other delegates)
-- established. NULL for historical rows predating this migration — the
-- authorization check treats NULL as "invited by the owner", so legacy
-- shares remain owner-managed.

ALTER TABLE album_shares
  ADD COLUMN invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
