-- iOS hash-based sync protocol: full_hash and device_asset_id columns (issue #432).
-- image_data_hash was already added in migration 0088.
--
-- full_hash:       SHA-256(imageDataHash + "\n" + caption + "\n" + isFavorite + "\n" + capturedAt)
--                  sent via X-Full-Hash. Changes on any sync-relevant metadata edit.
--                  Mirrored from photos.hash (which stores the same value) for an
--                  explicit, semantically-named column.
-- device_asset_id: iOS PHAsset.localIdentifier sent via X-Asset-Id.
--                  Most reliable dedup key: stable UUID, independent of byte content.

ALTER TABLE photos ADD COLUMN IF NOT EXISTS full_hash text;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS device_asset_id text;

CREATE INDEX IF NOT EXISTS idx_photos_full_hash
    ON photos (user_id, full_hash) WHERE full_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_photos_device_asset_id
    ON photos (user_id, device_asset_id) WHERE device_asset_id IS NOT NULL;
