-- Migration 0030: Library scan queue.
--
-- Tracks scan jobs for external photo libraries so they appear in the
-- same scan-worker status table as the per-photo services (embedding,
-- face_detection, ...). One row per enqueued scan; at most one active
-- row per library (partial unique index on pending/processing).

CREATE TABLE library_scan_queue (
  id                  SERIAL PRIMARY KEY,
  library_id          INTEGER NOT NULL REFERENCES photo_libraries(id) ON DELETE CASCADE,
  status              scan_status NOT NULL DEFAULT 'pending',
  reconcile           BOOLEAN NOT NULL DEFAULT false,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error_msg           TEXT,
  enqueued_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMP,
  finished_at         TIMESTAMP,
  scanned             INTEGER,
  imported            INTEGER,
  skipped_duplicate   INTEGER,
  skipped_unsupported INTEGER,
  skipped_empty       INTEGER,
  errors              INTEGER,
  removed             INTEGER
);--> statement-breakpoint

-- At most one active job per library — prevents two overlapping scans
-- of the same library from being queued.
CREATE UNIQUE INDEX uq_active_library_scan
  ON library_scan_queue (library_id)
  WHERE status IN ('pending', 'processing');
