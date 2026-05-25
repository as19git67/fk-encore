-- Migration 0090: Make document tags discoverable via full-text search.
--
-- The text_tsv generated column built in 0027 covers title, sender and
-- extracted_text. Tags live in the document_tag_links many-to-many
-- table, which Postgres generated columns cannot reach. We add a
-- denormalised tags_text column on documents, keep it in sync via
-- AFTER triggers on the link and tag-name tables, and fold it into
-- the regenerated text_tsv so a search for "mutter" finds documents
-- tagged with that name even if the word never appears in the OCR.

DROP INDEX IF EXISTS idx_documents_text_tsv;--> statement-breakpoint
ALTER TABLE documents DROP COLUMN text_tsv;--> statement-breakpoint

ALTER TABLE documents ADD COLUMN tags_text TEXT NOT NULL DEFAULT '';--> statement-breakpoint

-- Backfill tags_text for existing documents before re-adding the
-- generated tsvector — STORED columns are materialised at ADD time.
UPDATE documents d
   SET tags_text = COALESCE(
     (SELECT string_agg(dt.name, ' ' ORDER BY dt.name)
        FROM document_tag_links dtl
        JOIN document_tags dt ON dt.id = dtl.tag_id
       WHERE dtl.document_id = d.id),
     ''
   );--> statement-breakpoint

ALTER TABLE documents ADD COLUMN text_tsv TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector(
      'german',
      coalesce(title, '') || ' ' ||
      coalesce(sender, '') || ' ' ||
      coalesce(tags_text, '') || ' ' ||
      coalesce(extracted_text, '')
    )
  ) STORED;--> statement-breakpoint

CREATE INDEX idx_documents_text_tsv ON documents USING GIN (text_tsv);--> statement-breakpoint

-- Trigger function: rebuild tags_text for one or two document ids
-- after a row in document_tag_links is inserted, updated or deleted.
-- An UPDATE that moves the link to a different document refreshes
-- both the old and the new owner.
CREATE OR REPLACE FUNCTION document_tag_links_refresh()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE documents d
       SET tags_text = COALESCE(
         (SELECT string_agg(dt.name, ' ' ORDER BY dt.name)
            FROM document_tag_links dtl
            JOIN document_tags dt ON dt.id = dtl.tag_id
           WHERE dtl.document_id = NEW.document_id),
         ''
       )
     WHERE d.id = NEW.document_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') AND
     (TG_OP = 'DELETE' OR NEW.document_id IS DISTINCT FROM OLD.document_id)
  THEN
    UPDATE documents d
       SET tags_text = COALESCE(
         (SELECT string_agg(dt.name, ' ' ORDER BY dt.name)
            FROM document_tag_links dtl
            JOIN document_tags dt ON dt.id = dtl.tag_id
           WHERE dtl.document_id = OLD.document_id),
         ''
       )
     WHERE d.id = OLD.document_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS document_tag_links_refresh_trg ON document_tag_links;--> statement-breakpoint
CREATE TRIGGER document_tag_links_refresh_trg
  AFTER INSERT OR UPDATE OR DELETE ON document_tag_links
  FOR EACH ROW
  EXECUTE FUNCTION document_tag_links_refresh();--> statement-breakpoint

-- Tag rename: every document that links to the renamed tag needs its
-- tags_text rebuilt so the new name reaches the tsvector.
CREATE OR REPLACE FUNCTION document_tags_rename_refresh()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE documents d
       SET tags_text = COALESCE(
         (SELECT string_agg(dt.name, ' ' ORDER BY dt.name)
            FROM document_tag_links dtl
            JOIN document_tags dt ON dt.id = dtl.tag_id
           WHERE dtl.document_id = d.id),
         ''
       )
     WHERE d.id IN (
       SELECT document_id FROM document_tag_links WHERE tag_id = NEW.id
     );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS document_tags_rename_refresh_trg ON document_tags;--> statement-breakpoint
CREATE TRIGGER document_tags_rename_refresh_trg
  AFTER UPDATE ON document_tags
  FOR EACH ROW
  EXECUTE FUNCTION document_tags_rename_refresh();
