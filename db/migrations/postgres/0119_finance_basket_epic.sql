ALTER TABLE finance_transaction
  ADD COLUMN reviewed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN is_tax_relevant BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX finance_transaction_reviewed_idx
  ON finance_transaction (reviewed_at);

CREATE INDEX finance_transaction_tax_relevant_idx
  ON finance_transaction (is_tax_relevant)
  WHERE is_tax_relevant = true;
