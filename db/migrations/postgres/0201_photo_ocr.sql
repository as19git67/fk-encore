-- Text recognised inside photos (issue #1029): searchable, and positioned so
-- a viewer can later put a box around a line.

ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'text_ocr';--> statement-breakpoint

-- One row per scanned photo, including photos that turned out to have no text
-- on them: the row is what stops the queue from looking at them again.
CREATE TABLE IF NOT EXISTS "photo_ocr" (
  "photo_id" integer PRIMARY KEY REFERENCES "photos"("id") ON DELETE CASCADE,
  "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "full_text" text NOT NULL DEFAULT '',
  "mean_confidence" real NOT NULL DEFAULT 0,
  "scanned_long_side" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "text_tsv" tsvector
);--> statement-breakpoint

-- The tsvector is maintained by a trigger rather than being a generated
-- column. A GENERATED ALWAYS ... STORED tsvector fails the whole INSERT when
-- to_tsvector exceeds Postgres's 1 MB lexeme limit — migration 0155 learned
-- that on the documents table, where a single page of dense text was enough.
-- A photo of a page of text can reach the same size, and losing the OCR row
-- over an unsearchable amount of text would be the wrong trade.
CREATE OR REPLACE FUNCTION photo_ocr_text_tsv_refresh() RETURNS trigger AS $$
BEGIN
  BEGIN
    NEW.text_tsv := to_tsvector('german', COALESCE(NEW.full_text, ''));
  EXCEPTION WHEN program_limit_exceeded OR data_exception THEN
    NEW.text_tsv := to_tsvector('german', left(COALESCE(NEW.full_text, ''), 400000));
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS photo_ocr_text_tsv_trg ON "photo_ocr";--> statement-breakpoint
CREATE TRIGGER photo_ocr_text_tsv_trg
  BEFORE INSERT OR UPDATE OF "full_text" ON "photo_ocr"
  FOR EACH ROW EXECUTE FUNCTION photo_ocr_text_tsv_refresh();--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_photo_ocr_text_tsv" ON "photo_ocr" USING GIN ("text_tsv");
