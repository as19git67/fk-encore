-- Migration 0076: Persist photo dimensions on `photos`.
--
-- Needed for the orientation-diversity rule in the AI auto-pick
-- (see photo/group-auto-pick.ts): a similar group that contains both
-- a portrait and a landscape of the same subject should keep the best
-- of each instead of forcing a single orientation choice.
--
-- The values are stored post-EXIF-orientation (i.e. as the user sees
-- the photo on screen) — sharp's .rotate() is applied before reading
-- the metadata everywhere we populate these columns. A 4032x3024
-- phone photo with EXIF rotation 6 ends up as 3024x4032 here, which
-- correctly classifies as portrait.
--
-- NULL = not yet backfilled; the orientation classifier defaults
-- those to "landscape", so the diversity rule degenerates to "do
-- nothing" while the backfill runs (safe).

ALTER TABLE photos
  ADD COLUMN width  INTEGER,
  ADD COLUMN height INTEGER;
