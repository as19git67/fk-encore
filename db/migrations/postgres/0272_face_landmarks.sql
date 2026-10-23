-- Facial landmarks and eye openness per face (Etappe 5 of
-- documentation/auto-pick-face-relevance.md).
--
-- The InsightFace service runs buffalo_l, whose 106- and 68-point landmark
-- models already ran on every face; their output was discarded. `landmarks`
-- keeps them (JSON, normalised like `bbox`), `eye_aspect` / `eye_aspect_68`
-- are the raw eye-openness ratios derived from them in photo/face-eyes.ts.
--
-- NULL means "not measured": scanned before this migration, too small to
-- judge, or not found again by the backfill's re-detection. Never 0.0 —
-- that would read as "eyes closed".
ALTER TABLE faces
  ADD COLUMN landmarks TEXT,
  ADD COLUMN eye_aspect REAL,
  ADD COLUMN eye_aspect_68 REAL;

-- The backfill walks photos that still have faces without landmarks.
CREATE INDEX IF NOT EXISTS idx_faces_landmarks_missing
  ON faces (photo_id)
  WHERE landmarks IS NULL;
