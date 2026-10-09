-- Dossiers: a Sammelmappe with a membership rule (#1480).
--
-- A collection of `kind = 'dossier'` carries a `rule` — correspondent,
-- normalised reference numbers, an origin-folder prefix — and a document that
-- matches it joins after classification without anyone lifting a finger.
-- `joined_by` on the membership says who put a document in: what the rule
-- added, the rule may take away again when the document stops matching; what
-- a person added stays. Documents a person took out are remembered inside the
-- rule (`excluded_document_ids`) so the next run leaves them out.
ALTER TABLE "document_collections" ADD COLUMN "kind" text NOT NULL DEFAULT 'manual';
ALTER TABLE "document_collections" ADD COLUMN "rule" jsonb;
ALTER TABLE "document_collection_items" ADD COLUMN "joined_by" text NOT NULL DEFAULT 'user';
CREATE INDEX "document_collections_kind_idx" ON "document_collections" ("kind");
