-- Migration 0038: Social feed (photo activity timeline).
--
-- Every feed-worthy action fans out into one row per recipient, using
-- the same fan-out-on-write pattern as the realtime outbox. The actor
-- is the user who performed the action; the user_id column names the
-- viewer whose feed this row belongs to.
--
-- Kinds `photo_added` and `album_shared` are populated by phase 5a.
-- `photo_liked` and `photo_commented` are reserved for phase 5b so we
-- avoid a second ALTER TYPE migration once reactions land.
--
-- Retention: none — feed history is kept indefinitely per product
-- decision.

CREATE TYPE feed_item_kind AS ENUM (
  'photo_added',
  'album_shared',
  'photo_liked',
  'photo_commented'
);--> statement-breakpoint

CREATE TABLE feed_items (
  id            BIGSERIAL      PRIMARY KEY,
  user_id       INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable so a deleted user doesn't wipe the history — we just
  -- display "Unknown" for the actor.
  actor_user_id INTEGER                 REFERENCES users(id) ON DELETE SET NULL,
  kind          feed_item_kind NOT NULL,
  album_id      INTEGER                 REFERENCES albums(id) ON DELETE CASCADE,
  photo_id      INTEGER                 REFERENCES photos(id) ON DELETE CASCADE,
  payload       JSONB          NOT NULL DEFAULT '{}'::jsonb,
  seen_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- Hot path: timeline paginates by (created_at DESC, id DESC) for a
-- single user. Composite index matches that ORDER BY exactly.
CREATE INDEX idx_feed_items_user_created
  ON feed_items (user_id, created_at DESC, id DESC);--> statement-breakpoint

-- Partial index for the unread-badge query. Rows transition out of
-- the index as soon as they're marked seen so the index stays lean
-- even though the table grows forever.
CREATE INDEX idx_feed_items_user_unseen
  ON feed_items (user_id)
  WHERE seen_at IS NULL;
