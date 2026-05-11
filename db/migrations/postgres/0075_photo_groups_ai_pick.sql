-- Migration 0075: AI auto-pick metadata on photo_groups.
--
-- Phase 1 of Track I — "Photos: Similar-Groups Auto-Selection". The KI
-- picks one (or several, see ai_picked_photo_ids[]) photo per similar
-- group as the suggested "best of group". User decisions still take
-- precedence: when reviewed_at is set, the AI pick is ignored by the
-- gallery filter and never overwritten.
--
-- Columns:
--   ai_picked_photo_ids   The IDs of the AI-chosen photos within this
--                         group. Multi-pick is allowed (top-1 plus any
--                         runner-up within 8% of top score). NULL until
--                         the group has been scored.
--   ai_picked_at          Wall-clock timestamp of the last scoring pass.
--                         NULL = not yet scored → today's review workflow
--                         still applies (no auto-hide).
--   ai_picked_confidence  "high" | "medium" | "low" gate derived from
--                         the Δ between top-1 and best non-pick:
--                           Δ ≥ 0.10 → high   (auto-hide non-picks)
--                           0.04..   → medium (no auto-hide, marker
--                                              rendered prominently)
--                           < 0.04  → low    (no auto-hide, fall back to
--                                              today's review dialog)
--   ai_pick_details       Per-photo sub-scores + final weighted score,
--                         kept around so future calibration runs can be
--                         regressed without re-fetching every signal.

ALTER TABLE photo_groups
  ADD COLUMN ai_picked_photo_ids INTEGER[],
  ADD COLUMN ai_picked_at        TIMESTAMP WITH TIME ZONE,
  ADD COLUMN ai_picked_confidence TEXT,
  ADD COLUMN ai_pick_details     JSONB;

-- Cheap partial index for the gallery filter: "is this group AI-picked,
-- not yet user-reviewed, and high-confidence?". The filter runs on every
-- grid page; reviewed groups overwhelmingly dominate at 50k+ photos so
-- a partial index is much smaller than a full one.
CREATE INDEX IF NOT EXISTS photo_groups_ai_picked_active_idx
  ON photo_groups (user_id)
  WHERE ai_picked_at IS NOT NULL
    AND reviewed_at IS NULL
    AND ai_picked_confidence = 'high';
