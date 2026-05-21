-- iOS hash-based sync protocol: device_asset_id column (issue #432).
-- image_data_hash was already added in migration 0088; the client's identity
-- hash continues to live in photos.hash, so there is no separate full_hash
-- column.
--
-- device_asset_id: iOS PHAsset.localIdentifier, sent via the X-Asset-Id header.
--   A stable per-device key used as a fast-path dedup lookup on re-upload. The
--   metadata-only sync stays gated on image_data_hash equality so an actual
--   content edit is still stored as a new photo.

ALTER TABLE photos ADD COLUMN IF NOT EXISTS device_asset_id text;

CREATE INDEX IF NOT EXISTS idx_photos_device_asset_id
    ON photos (user_id, device_asset_id) WHERE device_asset_id IS NOT NULL;
