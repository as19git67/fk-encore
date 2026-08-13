-- Per-face sharpness for the auto-pick (Etappe 2 of
-- docs/auto-pick-face-relevance.md).
--
-- `photos.ai_quality_details.face_sharpness` is the *minimum* over all faces of
-- a photo. Inside a burst that minimum is usually the same tiny background face
-- in every frame, so it stays constant while the main subject's sharpness — the
-- signal the user actually decides on — varies. Storing the measurement per face
-- is what makes a prominence-weighted aggregation possible.
--
-- Nullable on purpose, with three distinct states: NULL = not measured yet
-- (backfill pending) or the crop is below MIN_FACE_PIXELS and not judgeable;
-- 0.0 = measured and out of focus. Collapsing those would reintroduce exactly
-- the bias the minimum has today.
ALTER TABLE faces
  ADD COLUMN sharpness REAL;

-- The backfill walks "faces that have no measurement yet", oldest photo first.
CREATE INDEX IF NOT EXISTS idx_faces_sharpness_missing
  ON faces (photo_id)
  WHERE sharpness IS NULL;
