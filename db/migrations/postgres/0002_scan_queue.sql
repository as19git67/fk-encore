-- Migration 0002: Persistent scan queue for background photo scanning

CREATE TYPE scan_service AS ENUM ('embedding', 'face_detection', 'landmark');
CREATE TYPE scan_status  AS ENUM ('pending', 'processing', 'failed', 'done');

CREATE TABLE photo_scan_queue (
  id          serial PRIMARY KEY,
  photo_id    integer NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  service     scan_service NOT NULL,
  status      scan_status  NOT NULL DEFAULT 'pending',
  force       boolean NOT NULL DEFAULT false,
  attempts    integer NOT NULL DEFAULT 0,
  error_msg   text,
  enqueued_at timestamp NOT NULL DEFAULT NOW(),
  started_at  timestamp,
  finished_at timestamp
);

-- Dedup: only one active (pending/processing) entry per (photo_id, service)
CREATE UNIQUE INDEX uq_active_scan
  ON photo_scan_queue (photo_id, service)
  WHERE status IN ('pending', 'processing');

-- Worker pickup index: FIFO per service
CREATE INDEX idx_scan_queue_pickup
  ON photo_scan_queue (service, enqueued_at ASC)
  WHERE status = 'pending';

-- Status queries per user
CREATE INDEX idx_scan_queue_user_status
  ON photo_scan_queue (user_id, service, status);
