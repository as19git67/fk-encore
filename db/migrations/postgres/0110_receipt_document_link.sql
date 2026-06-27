ALTER TABLE finance_transaction
  ADD COLUMN receipt_document_id integer
    REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX finance_transaction_receipt_doc_idx
  ON finance_transaction(receipt_document_id)
  WHERE receipt_document_id IS NOT NULL;
