-- Migration 0032: track when a user has viewed a recap.
--
-- The frontend stamps `seen_at` when the user opens a recap's detail view.
-- This lets the UI render a subtle "neu"-badge on cards that have not been
-- viewed yet and lets the feed sort fresh memories to the top without
-- needing heuristics based on `created_at`.
--
-- Nullable: existing recaps start as unseen; the column is never reset.
-- If the recap is rebuilt (content changes), the value is preserved — we
-- only want to mark "the user acknowledged this recap exists at least once".

ALTER TABLE recaps
  ADD COLUMN seen_at TIMESTAMP;--> statement-breakpoint

CREATE INDEX idx_recaps_user_unseen
  ON recaps (user_id)
  WHERE dismissed_at IS NULL AND seen_at IS NULL;
