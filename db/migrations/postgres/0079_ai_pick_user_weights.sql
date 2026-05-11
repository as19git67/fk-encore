-- Migration 0079: per-user weights for the AI auto-pick scoring formula.
--
-- The defaults in `photo/group-auto-pick.ts` are good on average, but
-- the first calibration export showed that a single user's preferences
-- can diverge significantly from the averages (e.g. they may value
-- composition over sharpness, or vice versa). This table holds the
-- result of a pairwise-logistic-regression fit against the user's own
-- reviewed groups; the scoring layer reads it on every recompute pass
-- and falls back to the hardcoded defaults when absent.
--
-- One row per user. Re-fitting overwrites the row — we don't keep
-- history. The `metadata` JSONB records diagnostic counts so the user
-- can see why the fit succeeded or failed (pair counts, top-1
-- agreement against the training data, etc.).
--
-- Weight vectors are stored as JSON arrays in canonical order:
--   face: [face_sharpness, eyes_open, face_coverage, face_composition,
--          blur, clip_aesthetics, exposure_contrast_avg]
--   non_face: [blur, clip_aesthetics, clip_composition, clip_technical,
--              exposure_contrast_avg]
-- Both vectors sum to 1.0 (positive components, normalised).

CREATE TABLE ai_pick_user_weights (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weights   JSONB NOT NULL,
  fitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata  JSONB NOT NULL DEFAULT '{}'::jsonb
);
