-- Migration 0101: Pin human-edited document attributes against re-classify.
--
-- A re-classify (runClassify) overwrites the editable attributes — title,
-- doc_date, sender, document_number, summary, category — unconditionally.
-- Mirroring `tax_reviewed`, this flag lets the edit dialog mark a document as
-- human-asserted so the classifier leaves those fields alone. The "let the AI
-- decide again" action clears the flag (PATCH /documents/:id with
-- attributes_reviewed=false).

ALTER TABLE documents
  ADD COLUMN attributes_reviewed BOOLEAN NOT NULL DEFAULT false;
