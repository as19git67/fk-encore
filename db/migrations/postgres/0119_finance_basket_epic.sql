ALTER TABLE finance_transaction
  ADD COLUMN reviewed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN is_tax_relevant BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX finance_transaction_reviewed_idx
  ON finance_transaction (reviewed_at);

CREATE INDEX finance_transaction_tax_relevant_idx
  ON finance_transaction (is_tax_relevant)
  WHERE is_tax_relevant = true;

CREATE TABLE finance_transaction_split (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  notice TEXT,
  is_tax_relevant BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX finance_transaction_split_tx_idx ON finance_transaction_split(transaction_id);

CREATE TABLE finance_basket_snapshot (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tx_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE finance_datev_mapping (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL,
  konto_soll TEXT NOT NULL,
  konto_haben TEXT NOT NULL,
  bu_schluessel TEXT,
  UNIQUE(user_id, tag_name)
);
