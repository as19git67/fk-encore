-- Add photos.updated_at plus triggers that keep it current whenever a row
-- or any of its dependent per-user state changes. This powers the
-- /photos/index ETag: a request handler can compute a cheap MAX(updated_at)
-- + COUNT(*) fingerprint scoped to the caller and return 304 Not Modified
-- when the client already holds the latest snapshot.
--
-- Design notes:
--  * photo_curation carries the per-user favorite / hide flags that are
--    included in the /photos/index payload. A curation change is a content
--    change from the client's perspective, so we propagate it up to
--    photos.updated_at via an AFTER trigger. We bump photos.updated_at on
--    *any* curation mutation (INSERT / UPDATE / DELETE) so the ETag is
--    correct even when an existing photo gains or loses a curation row.
--  * The index on (user_id, updated_at DESC) makes MAX(updated_at) a cheap
--    index scan even in libraries with hundreds of thousands of photos.

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Backfill: rows that predate this migration get their created_at as a
-- reasonable starting value (updated_at defaults to NULL for existing rows
-- because DEFAULT only applies to new inserts).
UPDATE photos SET updated_at = COALESCE(updated_at, created_at, NOW());

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE photos
  ALTER COLUMN updated_at SET NOT NULL;

-- Touch photos.updated_at whenever the row itself changes.
CREATE OR REPLACE FUNCTION touch_photos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS photos_touch_updated_at ON photos;
CREATE TRIGGER photos_touch_updated_at
  BEFORE UPDATE ON photos
  FOR EACH ROW
  EXECUTE FUNCTION touch_photos_updated_at();

-- Propagate curation changes (favorite / hide / votes) up to the photo so
-- the ETag flips for the affected user's next /photos/index call.
CREATE OR REPLACE FUNCTION touch_photo_on_curation()
RETURNS TRIGGER AS $$
DECLARE
  target_photo_id INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_photo_id := OLD.photo_id;
  ELSE
    target_photo_id := NEW.photo_id;
  END IF;
  UPDATE photos SET updated_at = NOW() WHERE id = target_photo_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS photo_curation_touch_photo ON photo_curation;
CREATE TRIGGER photo_curation_touch_photo
  AFTER INSERT OR UPDATE OR DELETE ON photo_curation
  FOR EACH ROW
  EXECUTE FUNCTION touch_photo_on_curation();

-- Index used by the /photos/index ETag computation.
CREATE INDEX IF NOT EXISTS photos_user_id_updated_at_idx
  ON photos (user_id, updated_at DESC);
