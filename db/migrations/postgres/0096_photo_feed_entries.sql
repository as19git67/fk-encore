-- Migration 0096: Instagram-style chronological content feed.
--
-- A second feed alongside `feed_items` (which stays the notification/activity
-- tab). This one is a scrollable stream of *photos*, one entry per (viewer,
-- photo), ordered strictly by "last relevant activity" — no ranking.
--
-- Why a materialized per-viewer table?  The sort key is viewer-accurate
-- (variant B): an activity in album X only bumps the photo for participants
-- of X. So the ordering value differs per (photo, viewer) and cannot be
-- computed stably at query time (no indexable column → no stable keyset
-- pagination). We therefore fan out on write, deduplicated to one row per
-- (user, photo), and keep `last_activity_at` monotonic (GREATEST on bump).
--
-- Visibility rule: a photo appears in user A's feed iff it sits in at least
-- one album A participates in (owner `albums.user_id` OR a row in
-- `album_shares`). Standalone photos in no album appear in no feed.
--
-- Bump sources (maintained by the content-feed service, see Etappe 2):
--   * photo added to album X        → participants of X
--   * comment created/edited in X   → participants of X
--   * photo metadata edited         → everyone who can see the photo
-- A "like" (favorite) deliberately does NOT bump — likes never reorder.
--
-- Retention: none — kept indefinitely, matching feed_items.

CREATE TABLE photo_feed_entries (
  user_id          INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  photo_id         INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, photo_id)
);--> statement-breakpoint

-- Hot path: timeline paginates by (last_activity_at DESC, photo_id DESC) for
-- a single user. Composite index matches that ORDER BY exactly.
CREATE INDEX idx_photo_feed_entries_timeline
  ON photo_feed_entries (user_id, last_activity_at DESC, photo_id DESC);--> statement-breakpoint

-- Backfill: seed one row per (participant, photo) for every photo that lives
-- in at least one album the user participates in. The seeded timestamp is an
-- approximation of historical "last activity": the latest of the photo's
-- metadata timestamp, the added_at of the containing albums the user sees,
-- and the newest comment in those albums. Runtime bumps refine it from here.
--
-- GREATEST() ignores NULL inputs, so missing legacy timestamps fall through
-- to the non-null metadata floor.
INSERT INTO photo_feed_entries (user_id, photo_id, last_activity_at)
SELECT
  parts.user_id,
  parts.photo_id,
  GREATEST(
    MAX(parts.added_at),
    MAX(cm.ts),
    MAX(COALESCE(p.updated_at, p.created_at, NOW()))
  )
FROM (
  -- album owners who can see the photo
  SELECT a.user_id AS user_id, ap.photo_id, ap.album_id, ap.added_at
  FROM album_photos ap
  JOIN albums a ON a.id = ap.album_id
  UNION ALL
  -- users the containing album was shared with
  SELECT s.user_id, ap.photo_id, ap.album_id, ap.added_at
  FROM album_photos ap
  JOIN album_shares s ON s.album_id = ap.album_id
) parts
JOIN photos p ON p.id = parts.photo_id
LEFT JOIN LATERAL (
  SELECT MAX(GREATEST(pc.created_at, COALESCE(pc.edited_at, pc.created_at))) AS ts
  FROM photo_comments pc
  WHERE pc.photo_id = parts.photo_id
    AND pc.album_id = parts.album_id
) cm ON TRUE
GROUP BY parts.user_id, parts.photo_id
ON CONFLICT (user_id, photo_id) DO NOTHING;
