-- Migration 0092: persistent album public links (issue #435).
--
-- A share link should keep its token across delete + re-create cycles so a
-- URL that was already shared keeps working when the owner toggles the
-- feature off and on. Previously the delete path hard-DELETEd the row,
-- and the next create issued a fresh token, breaking every external link.
--
-- We model "deleted" as a soft state: `disabled_at` carries the timestamp
-- when the owner last revoked the link. Active links have disabled_at IS
-- NULL. Re-creating just clears `disabled_at`, returning the same token.
--
-- The existing UNIQUE constraint on `token` and the per-album lookup both
-- stay valid — there is still at most one row per album.

ALTER TABLE album_public_links
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMP;
