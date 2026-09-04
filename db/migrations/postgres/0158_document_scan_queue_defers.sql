-- Bounded deferrals for the documents scan queue.
--
-- A deferred job goes back to `pending` without counting as a failure. That
-- was unbounded: a job whose defer condition never clears (llm-service
-- returning 5xx/timeouts for one specific document, an ai-queue slot that
-- keeps timing out, a stale document status) cycled pending → processing →
-- pending forever. It showed up as "wartend" in the queue panel for hours
-- with no error anywhere and no way to tell which document it was.
--
-- `defer_count` makes the deferral budget observable and lets the worker
-- turn an exhausted job into a real failure.
ALTER TABLE document_scan_queue
  ADD COLUMN IF NOT EXISTS defer_count INTEGER NOT NULL DEFAULT 0;
