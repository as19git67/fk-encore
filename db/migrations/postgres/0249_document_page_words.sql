-- Where each word of a document stands on its page (issue #1531,
-- prerequisite of stage 6 of documentation/plans/ki-assistent.md).
--
-- text_extract knew every word's box at the moment it read a page and threw
-- it away. It now writes the corrected rows per page here, in the same
-- transaction as documents.extracted_text, so finding where a value stands
-- (a purchase price to redact) never needs OCR to run again. Pixels of the
-- rasterized page for a scan, points for a born-digital page.
CREATE TABLE IF NOT EXISTS "document_page_words" (
  "document_id" integer NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "page" integer NOT NULL,
  "width" real NOT NULL,
  "height" real NOT NULL,
  "unit" text NOT NULL CHECK ("unit" IN ('px', 'pt')),
  "rotation" integer NOT NULL DEFAULT 0,
  "words" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_id", "page")
);
--> statement-breakpoint
-- Documents extracted before this table existed get their rows from a
-- low-priority job that re-reads them and yields to text_extract.
ALTER TYPE "document_job_service" ADD VALUE IF NOT EXISTS 'page_words';
