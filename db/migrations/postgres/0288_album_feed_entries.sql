-- Content feed: only shared albums, and a newly shared album as one card.
--
-- 1. An album nobody else sees is its owner's archive. Putting photos there
--    (or liking, commenting, describing them) is filing, not news, so those
--    photos no longer fill the owner's own feed. The visibility rule becomes:
--    a photo is in user A's feed iff it lives in at least one album A
--    participates in AND that album is shared with at least one user
--    (a row in album_shares). Entries that no longer satisfy it go.
--
-- 2. Sharing an album with someone used to seed every photo of the album into
--    the recipient's feed. Now the recipient gets the album once, as a card
--    that opens the album: one row per (viewer, album) in album_feed_entries,
--    with the same monotonic sort key as photo_feed_entries.

CREATE TABLE IF NOT EXISTS album_feed_entries (
  user_id          INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  album_id         INTEGER     NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, album_id)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_album_feed_entries_timeline
  ON album_feed_entries (user_id, last_activity_at DESC);--> statement-breakpoint

DELETE FROM photo_feed_entries fe
WHERE NOT EXISTS (
  SELECT 1
  FROM album_photos ap
  JOIN albums a ON a.id = ap.album_id
  WHERE ap.photo_id = fe.photo_id
    AND (a.user_id = fe.user_id
         OR EXISTS (SELECT 1 FROM album_shares s
                     WHERE s.album_id = a.id AND s.user_id = fe.user_id))
    AND EXISTS (SELECT 1 FROM album_shares sx WHERE sx.album_id = a.id)
);
