-- Etappe 1: Receipt-OCR async pipeline data model
--
-- 1. Enum for OCR processing state on receipt documents.
-- 2. New columns on `documents`: state tracker, chosen cash account,
--    idempotency anchor (FK to the auto-created transaction).
-- 3. New 1:1 table `document_receipt_extraction` holding the structured
--    extraction result so the `documents` row stays slim.

CREATE TYPE receipt_ocr_state AS ENUM ('pending', 'booked', 'incomplete', 'failed');

ALTER TABLE documents
  ADD COLUMN receipt_ocr_state receipt_ocr_state,
  ADD COLUMN receipt_account_id integer REFERENCES finance_account(id) ON DELETE SET NULL,
  ADD COLUMN receipt_transaction_id bigint REFERENCES finance_transaction(id) ON DELETE SET NULL;

CREATE TABLE document_receipt_extraction (
  id            serial PRIMARY KEY,
  document_id   integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount        numeric(14, 2),
  receipt_date  text,
  store         text,
  items         jsonb NOT NULL DEFAULT '[]',
  ocr_confidence real,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT document_receipt_extraction_document_unique UNIQUE (document_id)
);
