CREATE TABLE IF NOT EXISTS finance_transaction_seen (
  transaction_id INTEGER NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transaction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_transaction_seen_user
  ON finance_transaction_seen (user_id);
