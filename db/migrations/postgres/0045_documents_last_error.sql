-- Persist the most recent failure reason on the document row so the
-- listing can surface why classification failed without joining the
-- scan_queue. The field is cleared whenever a document re-enters the
-- pipeline (reclassify) so a stale error never lingers on a healthy
-- document. Mirrors the realtime payload published by markDocumentFailed.

ALTER TABLE documents
  ADD COLUMN last_error TEXT;
