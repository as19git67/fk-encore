-- Migration 0134: per-recap photo exclusions.
--
-- Lets a user drop an individual photo from a recap (while viewing the collage
-- or playing the show). The exclusion is persistent and keyed by recap_id,
-- which is stable across the daily cron rebuild (recaps upsert by dedup_key),
-- so a rejected photo never comes back — and the builder backfills the
-- next-best candidate in its place.

CREATE TABLE recap_excluded_photos (
  recap_id INTEGER NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (recap_id, photo_id)
);
