-- Migration 0018: Make photo_landmarks global (remove user_id)
--
-- Landmark detection results are the same regardless of which user owns the photo.
-- By removing user_id, detection runs once per photo and results are shared.
-- Access control is handled by checking photo ownership at query time.

-- Drop the user_id foreign key and column
ALTER TABLE photo_landmarks DROP CONSTRAINT IF EXISTS photo_landmarks_user_id_users_id_fk;
DROP INDEX IF EXISTS idx_landmarks_user_id;
ALTER TABLE photo_landmarks DROP COLUMN user_id;
