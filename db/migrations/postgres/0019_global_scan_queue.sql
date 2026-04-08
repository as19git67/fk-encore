-- Migration 0019: Make global scan services user-agnostic
--
-- Global services (face_detection, embedding, landmark, quality, geocoding)
-- run once per photo regardless of user. Previously every queue entry carried
-- a user_id, causing duplicate work when photos are shared and showing
-- different queue status per user.
--
-- Now:
--   Global services:  user_id = NULL  → one job per photo
--   Per-user services: user_id set    → one job per user per photo (face_assignment)

-- 1. Allow NULL user_id for global queue entries
ALTER TABLE photo_scan_queue ALTER COLUMN user_id DROP NOT NULL;

-- 2. Migrate existing global service rows: set user_id = NULL, keep only one row
--    per (photo_id, service) for global services.  We keep the row with the
--    highest id (most recent) and delete duplicates.
DELETE FROM photo_scan_queue a
USING photo_scan_queue b
WHERE a.service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding')
  AND b.service = a.service
  AND b.photo_id = a.photo_id
  AND a.id < b.id;

UPDATE photo_scan_queue
SET user_id = NULL
WHERE service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding');

-- 3. Replace the unique index with two partial indexes:
--    one for global services (no user_id) and one for per-user services.
DROP INDEX IF EXISTS uq_active_scan;

CREATE UNIQUE INDEX uq_active_scan_global
  ON photo_scan_queue (photo_id, service)
  WHERE status IN ('pending', 'processing') AND user_id IS NULL;

CREATE UNIQUE INDEX uq_active_scan_user
  ON photo_scan_queue (photo_id, service, user_id)
  WHERE status IN ('pending', 'processing') AND user_id IS NOT NULL;
