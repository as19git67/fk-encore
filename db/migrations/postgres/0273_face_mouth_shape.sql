-- Raw mouth shape per face, from the landmarks stored since 0272
-- (photo/face-eyes.ts, mouthShape). Width is corner-to-corner along the eye
-- line over the eye distance; lift is how far the corners sit above the
-- middle of the lips, over the mouth width. One pair per landmark model.
--
-- NULL: no landmarks yet, or the face is below MIN_EYE_FACE_PIXELS. Faces
-- that already have landmarks are re-measured from them by the landmark
-- backfill without running the detector again.
ALTER TABLE faces
  ADD COLUMN mouth_width REAL,
  ADD COLUMN mouth_lift REAL,
  ADD COLUMN mouth_width_68 REAL,
  ADD COLUMN mouth_lift_68 REAL;

CREATE INDEX IF NOT EXISTS idx_faces_mouth_missing
  ON faces (photo_id)
  WHERE landmarks IS NOT NULL AND mouth_lift IS NULL AND mouth_lift_68 IS NULL;
