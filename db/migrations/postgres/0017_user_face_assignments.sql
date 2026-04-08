-- Migration 0017: Split faces into global detection results + per-user assignments
--
-- Previously, the `faces` table stored both the InsightFace detection results
-- (bbox, embedding) AND per-user state (person_id, ignored).  This meant face
-- detection had to run separately for every user, even for the same photo.
--
-- Now:
--   faces          – global, one row per detected face per photo (no user_id)
--   user_face_assignments – per-user person assignment & ignored state
--
-- This allows InsightFace to run ONCE per photo.  When an album is shared with
-- a new user, they immediately get all face data and only need their own
-- person-matching / naming.

-- 1. Create the per-user assignment table
CREATE TABLE user_face_assignments (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  face_id    integer NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  person_id  integer REFERENCES persons(id) ON DELETE SET NULL,
  ignored    boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT NOW(),
  PRIMARY KEY (user_id, face_id)
);

CREATE INDEX idx_ufa_user_person ON user_face_assignments (user_id, person_id);
CREATE INDEX idx_ufa_face ON user_face_assignments (face_id);

-- 2. Migrate existing data: copy per-user state from faces into user_face_assignments
INSERT INTO user_face_assignments (user_id, face_id, person_id, ignored, created_at)
SELECT user_id, id, person_id, ignored, created_at FROM faces;

-- 3. Drop the per-user columns from faces (they now live in user_face_assignments)
ALTER TABLE faces DROP CONSTRAINT IF EXISTS faces_user_id_users_id_fk;
ALTER TABLE faces DROP CONSTRAINT IF EXISTS faces_person_id_persons_id_fk;
ALTER TABLE faces DROP COLUMN user_id;
ALTER TABLE faces DROP COLUMN person_id;
ALTER TABLE faces DROP COLUMN ignored;

-- 4. Add face_assignment service to scan_service enum
ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'face_assignment';

-- 5. Replace the unique index to allow per-user face_assignment jobs.
-- The old index was (photo_id, service) which only allows one active job per photo per service.
-- face_assignment needs one job per user per photo, so we include user_id.
DROP INDEX IF EXISTS uq_active_scan;
CREATE UNIQUE INDEX uq_active_scan
  ON photo_scan_queue (photo_id, service, user_id)
  WHERE status IN ('pending', 'processing');
