-- Text documents the user writes in the app (documents/text-documents.ts).
-- The Markdown is the source the editor opens; the PDF at `disk_path` is
-- rendered from it on every save, so list, search, previews, exports and
-- collections treat a text document like any other. NULL for every
-- uploaded or imported document.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "markdown_source" text;
