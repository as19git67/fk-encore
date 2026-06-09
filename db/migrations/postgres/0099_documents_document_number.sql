-- Migration 0099: Add document_number column and include it in full-text search.
--
-- The LLM classifier extracts document/invoice/reference numbers from the
-- OCR text (patterns like #1234, Rechnungsnummer 2661160, Az. 12/34).
-- Stored as a plain text field, included in the text_tsv generated column
-- so users can search by document number.

ALTER TABLE documents ADD COLUMN document_number TEXT;--> statement-breakpoint

-- Rebuild the generated text_tsv column to include document_number.
-- Must drop and re-add because Postgres does not allow ALTER on generated columns.
DROP INDEX IF EXISTS idx_documents_text_tsv;--> statement-breakpoint
ALTER TABLE documents DROP COLUMN text_tsv;--> statement-breakpoint

ALTER TABLE documents ADD COLUMN text_tsv TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector(
      'german',
      coalesce(title, '') || ' ' ||
      coalesce(sender, '') || ' ' ||
      coalesce(document_number, '') || ' ' ||
      coalesce(tags_text, '') || ' ' ||
      coalesce(extracted_text, '')
    )
  ) STORED;--> statement-breakpoint

CREATE INDEX idx_documents_text_tsv ON documents USING GIN (text_tsv);
