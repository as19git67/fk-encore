-- Classify-time provenance for the category decision.
--
-- runClassify resolves the stored category as
--     contentSlug ?? ruleSlug ?? learnedCatSlug ?? classification.category_slug
-- and, when the resulting slug matches no category row, silently keeps the
-- document's previous category. None of that was persisted: the only record was
-- a console.log line, so a container restart erased the answer to "did the model
-- or a rule decide this?".
--
-- The 2026-08-24 cloud audit ran into precisely that wall. Nine category slugs
-- were never once stored across 380 audited documents, and with the logs gone
-- there was no way to distinguish a model that never picks them from a rule that
-- overrides them or from a slug that failed to resolve.
--
-- Both columns are diagnostics. Nothing reads them to make a decision, and a
-- NULL simply means "classified before this migration".
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS classifier_raw_category_slug TEXT,
  ADD COLUMN IF NOT EXISTS category_decided_by TEXT;

COMMENT ON COLUMN documents.classifier_raw_category_slug IS
  'Category slug the model returned, verbatim, before rule overrides and before slug resolution.';
COMMENT ON COLUMN documents.category_decided_by IS
  'Layer that produced the stored category: model | content_rule | sender_rule | learned | unresolved_slug | pinned.';

-- Answering "which layer decided?" scans by that layer; the column is NULL for
-- every pre-existing row, so a partial index keeps it to the classified ones.
CREATE INDEX IF NOT EXISTS documents_category_decided_by_idx
  ON documents (category_decided_by)
  WHERE category_decided_by IS NOT NULL;
