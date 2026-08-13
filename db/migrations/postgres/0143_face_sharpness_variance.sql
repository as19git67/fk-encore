-- Raw Laplace variance behind `faces.sharpness`.
--
-- `sharpness` is the variance normalised against LAPLACIAN_FULL_SCALE (500), a
-- value calibrated for the frontend's focus peaking — which measures the
-- *rendered*, downscaled image. The backfill reads the full-resolution
-- original, where the same face crop carries far more high-frequency detail
-- and can hit the 1.0 ceiling: every face then looks equally sharp and the
-- score stops discriminating, which is exactly what the first production run
-- of scripts/photos/diagnose-face-sharpness-variance.mjs looked like.
--
-- Storing the raw value makes re-calibrating the scale an UPDATE instead of a
-- second pass over 130k crops. NULL carries the same meaning as on
-- `sharpness`: not measured yet, or below the measurable size.
ALTER TABLE faces
  ADD COLUMN sharpness_variance REAL;

-- The backfill now walks "either column missing", so faces measured before
-- this migration get picked up again and receive their raw variance. Replaces
-- the narrower index from 0142.
DROP INDEX IF EXISTS idx_faces_sharpness_missing;
CREATE INDEX IF NOT EXISTS idx_faces_measurement_missing
  ON faces (photo_id)
  WHERE sharpness IS NULL OR sharpness_variance IS NULL;
