-- External photo libraries (issue #75).
--
-- A library represents a directory under PHOTO_LIBRARIES_ROOT that the
-- backend imports photos from. Two import modes are supported:
--   link — leave files in place; deletion of the file deletes the photo row
--   move — move files into the standard UPLOAD_DIR layout
--
-- Auto-import enables a chokidar watcher; otherwise the library is scanned
-- on demand or by the periodic reconcile job.
CREATE TYPE library_import_mode AS ENUM ('link', 'move');--> statement-breakpoint

CREATE TABLE photo_libraries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  import_mode library_import_mode NOT NULL DEFAULT 'link',
  auto_import BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  last_scan_at TIMESTAMP
);--> statement-breakpoint

ALTER TABLE photos
  ADD COLUMN library_id INTEGER REFERENCES photo_libraries(id) ON DELETE SET NULL,
  ADD COLUMN external_path TEXT;--> statement-breakpoint

CREATE INDEX idx_photos_library_id ON photos (library_id) WHERE library_id IS NOT NULL;--> statement-breakpoint
-- Fast lookup by external path during reconcile / unlink handling.
CREATE UNIQUE INDEX uq_photos_external_path ON photos (external_path) WHERE external_path IS NOT NULL;
