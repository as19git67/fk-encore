-- Which path produced a document's extracted_text, and how well it read.
--
-- `ExtractResult.source` has always been returned by extractPdfText and then
-- thrown away: the only record was a console.log line. So "which documents
-- actually went through OCR?" — the first question any OCR change has to
-- answer — could not be asked in SQL at all, and a container restart erased
-- even the log.
--
-- That gap is load-bearing for the model scoreboard. A classification sample
-- drawn without knowing which documents were OCR'd cannot show whether an OCR
-- change moved anything: a corpus that is mostly born-digital PDFs never
-- reaches the OCR path, and the comparison measures nothing.
--
-- Both columns are diagnostics. Nothing reads them to make a decision, and
-- NULL simply means "extracted before this migration".
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS text_source TEXT,
  ADD COLUMN IF NOT EXISTS ocr_mean_confidence REAL;

COMMENT ON COLUMN documents.text_source IS
  'Path that produced extracted_text: text_layer | ocr | mixed.';
COMMENT ON COLUMN documents.ocr_mean_confidence IS
  'Mean per-word tesseract confidence (0..100) across the OCR''d pages; NULL when OCR did not run.';

-- "Everything that needed OCR" is the selection targeted re-extraction and
-- before/after measurement both start from. NULL on every pre-existing row, so
-- a partial index keeps it to the rows that carry a value.
CREATE INDEX IF NOT EXISTS documents_text_source_idx
  ON documents (text_source)
  WHERE text_source IS NOT NULL;
