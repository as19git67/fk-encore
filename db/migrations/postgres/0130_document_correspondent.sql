-- Migration 0130: Persist the canonical correspondent per document.
--
-- The on-disk layout groups documents under a correspondent folder
-- (<category>/<correspondent>/<year>/…, see documents/correspondent.ts).
-- To let the document list filter and offer a "by correspondent" facet
-- without re-deriving the correspondent from sender/title/tags on every
-- query, persist the institution-level identity on the row.
--
-- `correspondent_slug` is the stable folder/filter key (e.g. "janitos"),
-- `correspondent_display` the human-readable name (e.g. "Janitos"). Both
-- are NULL until a document is (re)located; the existing "Dateinamen
-- aktualisieren" backfill (POST /documents/relocate-all) fills them for
-- the whole corpus because it runs relocateDocument on every row.

ALTER TABLE documents
  ADD COLUMN correspondent_slug TEXT;--> statement-breakpoint
ALTER TABLE documents
  ADD COLUMN correspondent_display TEXT;--> statement-breakpoint

-- Index the filter/facet key. Partial (NOT NULL) keeps it small since
-- unclassified documents carry no correspondent yet.
CREATE INDEX idx_documents_correspondent_slug
  ON documents (correspondent_slug)
  WHERE correspondent_slug IS NOT NULL;
