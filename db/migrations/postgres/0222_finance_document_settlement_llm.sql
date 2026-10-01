-- What the language model read from a settlement document (#1336).
--
-- The portfolio reads Wertpapierabrechnungen with fixed rules and, beside
-- them, asks the local model for the same fields; arithmetic checks decide
-- which value to trust. The model is slow next to the rules, and the
-- review page re-reads every unlinked settlement on each visit, so its
-- answer is kept here, once per document. A failed call is not stored —
-- the next read-in asks again.
CREATE TABLE finance_document_settlement_llm (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  -- The validated field values (depot-settlement-merge.ts parseLlmSettlement).
  "values"    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
