-- Migration 0077: clear stale AI auto-pick state.
--
-- Migration 0075 introduced `ai_pick_details` on photo_groups and the
-- toPhotoSignals adapter that feeds the scorer. The adapter looked up
-- the wrong JSONB keys (e.g. `blur_score` instead of `sharpness`,
-- `eyes_open_score` instead of `eyes_open`), so 4 of the 9 signals
-- silently fell back to the neutral 0.5 default and the resulting
-- picks were dominated by clip_aesthetics + face_sharpness alone.
--
-- The adapter is fixed; clearing the stored picks here forces the next
-- `recomputeAiPicksForAllUsers` (admin button) and the next
-- `exportCalibrationDatasetLogic` (inline rescorer for reviewed
-- groups) to repopulate everything against the corrected mapping.
--
-- Idempotent: rerunning on an already-cleared row is a no-op.

UPDATE photo_groups
   SET ai_picked_photo_ids = NULL,
       ai_picked_at        = NULL,
       ai_picked_confidence = NULL,
       ai_pick_details     = NULL;
