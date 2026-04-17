-- Auto-album support for external photo libraries (issue #75).
--
-- When auto_albums is enabled on a library, each photo imported from a
-- sub-directory of the library is attached to an album named after the
-- first path segment relative to the library root. The album is owned
-- by the library's configured user; existing albums with a matching
-- name are reused.
ALTER TABLE photo_libraries
  ADD COLUMN auto_albums BOOLEAN NOT NULL DEFAULT false;
