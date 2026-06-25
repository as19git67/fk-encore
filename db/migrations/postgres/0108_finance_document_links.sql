CREATE TABLE finance_transaction_document (
  transaction_id BIGINT NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transaction_id, document_id)
);

CREATE TABLE finance_document_match_suggestion (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  amount_score REAL NOT NULL DEFAULT 0,
  date_score REAL NOT NULL DEFAULT 0,
  text_score REAL NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'accepted', 'rejected', 'ignored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  UNIQUE (transaction_id, document_id)
);
