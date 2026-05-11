-- Migration 0078: clear stale AI auto-pick state after weight retuning.
--
-- PR adds `face_composition` to the face branch of the scoring
-- formula and rebalances the existing weights:
--
--   face_sharpness:    0.45 -> 0.40
--   eyes_open:         0.20 -> 0.20
--   face_coverage:     0.15 -> 0.15
--   face_composition:    —  -> 0.10  (new)
--   blur:              0.10 -> 0.05
--   clip_aesthetics:   0.05 -> 0.05
--   exposure+contrast: 0.05 -> 0.05
--
-- Existing `ai_pick_details` rows were computed with the old weights
-- and the old (smaller) signal set, so we drop them — the next
-- recompute and the next calibration export will repopulate against
-- the new formula. Idempotent on already-cleared rows.

UPDATE photo_groups
   SET ai_picked_photo_ids = NULL,
       ai_picked_at        = NULL,
       ai_picked_confidence = NULL,
       ai_pick_details     = NULL;
