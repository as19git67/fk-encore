ALTER TABLE document_receipt_extraction
  ADD COLUMN amount_confidence REAL,
  ADD COLUMN amount_source TEXT;
