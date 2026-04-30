-- Finance AI tag suggestion queue.
-- Mirrors the photo/document scan queue pattern: one row per pending
-- tagging job. The worker polls this table, calls the llm-service, and
-- writes AI tags back into finance_tag_transaction.

CREATE TABLE finance_tag_queue (
  id            SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         scan_status NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  error_msg      TEXT,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

-- Dedup: only one active (pending|processing) job per transaction.
CREATE UNIQUE INDEX uq_active_finance_tag_job
  ON finance_tag_queue (transaction_id)
  WHERE status IN ('pending', 'processing');

-- Worker pickup: oldest pending jobs first.
CREATE INDEX idx_finance_tag_queue_pickup
  ON finance_tag_queue (enqueued_at)
  WHERE status = 'pending';

-- Status queries for the DataManagement UI.
CREATE INDEX idx_finance_tag_queue_user_status
  ON finance_tag_queue (user_id, status);
