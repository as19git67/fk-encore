-- Documents as the primary source for depot transactions (#1336, stage 4).
--
-- A Wertpapierabrechnung or a Dividendengutschrift carries what the giro
-- booking does not: quantity, price, fees and the taxes withheld. The
-- settlement parser reads them and either enriches the depot transaction
-- derived from the giro booking or creates the row itself. This table
-- records which document(s) a depot transaction was read from or
-- confirmed by — the same shape as finance_transaction_document.
CREATE TABLE finance_depot_transaction_document (
  depot_transaction_id BIGINT NOT NULL REFERENCES finance_depot_transaction(id) ON DELETE CASCADE,
  document_id          INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (depot_transaction_id, document_id)
);

CREATE INDEX finance_depot_transaction_document_document_idx
  ON finance_depot_transaction_document (document_id);
