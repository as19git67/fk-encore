-- Album-scoped photo comments.
--
-- Previously a comment was attached to a photo only. Because a photo can
-- live in several albums (album_photos M:N), a comment written while
-- viewing the photo in album B leaked into album A's view as well.
--
-- Comments are now bound to the album they were written in: exactly one
-- album per comment. Reads and the guest fan-out filter by album_id, so
-- a comment is only visible in the album it belongs to.

ALTER TABLE photo_comments
    ADD COLUMN album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE;--> statement-breakpoint

-- Backfill: attach each existing comment to an album that actually
-- contains its photo. When the photo is in several albums we pick the
-- lowest album id deterministically — there is no historical album
-- context to recover, so any containing album is an acceptable home.
UPDATE photo_comments pc
SET album_id = (
    SELECT MIN(ap.album_id)
    FROM album_photos ap
    WHERE ap.photo_id = pc.photo_id
)
WHERE album_id IS NULL;--> statement-breakpoint

-- Orphans: comments on photos that are in no album at all have no valid
-- scope under the album-bound model and cannot satisfy the NOT NULL
-- constraint below. Drop them.
DELETE FROM photo_comments WHERE album_id IS NULL;--> statement-breakpoint

ALTER TABLE photo_comments
    ALTER COLUMN album_id SET NOT NULL;--> statement-breakpoint

-- Listing comments for a photo within a given album, chronologically.
CREATE INDEX idx_photo_comments_album_photo_created
    ON photo_comments (album_id, photo_id, created_at ASC, id ASC);
