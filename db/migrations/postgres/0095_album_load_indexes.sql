-- Migration 0095: Reverse-direction indexes for album / photo-detail loads.
--
-- The album-scoped grid and the album-detail query touch album_photos and
-- photo_curation in the "photo-first" direction, but the existing indexes
-- only lead with the other column:
--
--   * album_photos  PK is (album_id, photo_id) — fine for "photos in album X",
--     but "which albums contain photo Y" (photo-detail sidebar, the
--     `notInAnyAlbum` gallery filter) has no index and falls back to a scan.
--
--   * photo_curation PK is (user_id, photo_id) and there is a (photo_id,
--     status) index, but the album-detail aggregate joins ON photo_id = p.id
--     AND user_id = ANY(participants) — i.e. photo-first, filtered by user.
--     Neither existing index serves that well on shared albums with several
--     participants.
--
-- Both are plain b-tree indexes; IF NOT EXISTS keeps the migration idempotent.

CREATE INDEX IF NOT EXISTS idx_album_photos_photo_id
  ON album_photos (photo_id);

CREATE INDEX IF NOT EXISTS idx_photo_curation_photo_user
  ON photo_curation (photo_id, user_id);
