ALTER TABLE photo_scan_queue
  ADD COLUMN priority INT NOT NULL DEFAULT 2;

ALTER TABLE document_scan_queue
  ADD COLUMN priority INT NOT NULL DEFAULT 2;

ALTER TABLE finance_tag_queue
  ADD COLUMN priority INT NOT NULL DEFAULT 2;

-- Update pickup indexes to include priority for efficient dequeue ordering.
-- Photo: drop old, create new composite index
DROP INDEX IF EXISTS idx_scan_queue_pickup;
CREATE INDEX idx_scan_queue_pickup
  ON photo_scan_queue (service, priority, enqueued_at ASC)
  WHERE status = 'pending';

-- Documents: drop old, create new composite index
DROP INDEX IF EXISTS idx_document_scan_queue_pickup;
CREATE INDEX idx_document_scan_queue_pickup
  ON document_scan_queue (service, priority, enqueued_at ASC)
  WHERE status = 'pending';

-- Finance: drop old, create new composite index
DROP INDEX IF EXISTS idx_finance_tag_queue_pickup;
CREATE INDEX idx_finance_tag_queue_pickup
  ON finance_tag_queue (priority, enqueued_at ASC)
  WHERE status = 'pending';
