-- Two gaps that only show up on very large documents.
--
-- 1. OCR TRUNCATION IS INVISIBLE. `DOCUMENTS_OCR_TIMEOUT_MS` (10 min) is
--    checked between pages and breaks the loop, so a long scan is stored with
--    PARTIAL text and status 'ready'. The only trace was a console.warn that
--    did not even carry the document id, so neither "which documents are
--    incomplete?" nor "how much did we lose?" could be answered — and a
--    container restart erased even that. `pages_total` / `pages_ocred` make
--    both answerable in SQL, the same gap `text_source` closed for the path.
--
-- 2. A HUGE DOCUMENT COULD FAIL THE WHOLE WRITE. `text_tsv` was a
--    GENERATED ALWAYS ... STORED column, so `to_tsvector` ran as part of every
--    INSERT/UPDATE. Postgres caps a tsvector's lexeme content at 1 MB, and the
--    cap is reachable: measured here, a bank statement of ~80,000 transactions
--    (every date, amount and reference a distinct lexeme) raises
--    "string is too long for tsvector". Because the column is generated, that
--    error aborts the UPDATE — the document goes to 'failed' and its entire
--    extracted text is discarded, over an index that could simply have been
--    shorter.
--
--    Prose never gets near it (2.26 MB of letter text → a 4.7 KB tsvector);
--    what accumulates distinct lexemes is numeric tables, and pathological OCR
--    where nearly every token is unique garbage.
--
--    So: a regular column maintained by a trigger that catches the failure and
--    retries on a truncated input. Everything that fits is indexed in full,
--    the pathological case is indexed up to the cut, and `extracted_text`
--    itself is never touched — the document keeps all of its text either way.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS pages_total INTEGER,
  ADD COLUMN IF NOT EXISTS pages_ocred INTEGER;

COMMENT ON COLUMN documents.pages_total IS
  'Pages the PDF has. NULL when extracted before this migration.';
COMMENT ON COLUMN documents.pages_ocred IS
  'Pages OCR actually recognised. Below pages_total means the OCR time budget truncated the document.';

-- "Which documents are incomplete?" — the selection a re-extraction starts
-- from. Partial, because the columns are NULL for every pre-existing row.
CREATE INDEX IF NOT EXISTS documents_pages_incomplete_idx
  ON documents (id)
  WHERE pages_ocred IS NOT NULL AND pages_total IS NOT NULL AND pages_ocred < pages_total;

-- ── text_tsv: generated column → trigger-maintained column ──────────────────

DROP INDEX IF EXISTS idx_documents_text_tsv;--> statement-breakpoint
ALTER TABLE documents DROP COLUMN IF EXISTS text_tsv;--> statement-breakpoint
ALTER TABLE documents ADD COLUMN text_tsv TSVECTOR;--> statement-breakpoint

CREATE OR REPLACE FUNCTION documents_text_tsv_refresh()
RETURNS TRIGGER AS $$
DECLARE
  -- Everything but the body text; these are short by construction and are
  -- kept whole even when the body has to be cut.
  head TEXT := coalesce(NEW.title, '') || ' ' ||
               coalesce(NEW.sender, '') || ' ' ||
               coalesce(NEW.document_number, '') || ' ' ||
               coalesce(NEW.tags_text, '') || ' ';
  -- Worst case measured at ~2 bytes of tsvector per character of all-distinct
  -- short tokens, so 400k characters stays comfortably under the 1 MB cap
  -- even for text that shares nothing. Only ever reached after the full
  -- attempt has already failed.
  fallback_chars CONSTANT INTEGER := 400000;
BEGIN
  BEGIN
    NEW.text_tsv := to_tsvector('german', head || coalesce(NEW.extracted_text, ''));
  EXCEPTION WHEN program_limit_exceeded OR data_exception THEN
    -- The index is degraded for this row; the text is not. A search will find
    -- the document by anything in the first 400k characters, which is far more
    -- than any query realistically reaches for.
    RAISE WARNING 'documents.text_tsv truncated for document % (extracted_text % chars)',
      NEW.id, length(coalesce(NEW.extracted_text, ''));
    NEW.text_tsv := to_tsvector(
      'german', head || left(coalesce(NEW.extracted_text, ''), fallback_chars)
    );
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- BEFORE, so the computed value is written with the row rather than needing a
-- second UPDATE. Fires for the tag triggers too: they maintain `tags_text`
-- with an UPDATE on this table, which is exactly what has to re-index.
CREATE TRIGGER documents_text_tsv_refresh_trg
  BEFORE INSERT OR UPDATE OF title, sender, document_number, tags_text, extracted_text
  ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_text_tsv_refresh();--> statement-breakpoint

-- Backfill: the column was just added empty, and a no-op UPDATE runs the
-- trigger for every row.
UPDATE documents SET extracted_text = extracted_text;--> statement-breakpoint

CREATE INDEX idx_documents_text_tsv ON documents USING GIN (text_tsv);
