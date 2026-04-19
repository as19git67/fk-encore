-- Migration 0029: Tax-return fields for documents.
--
-- Extends the documents table with three document-level tax attributes
-- (is it a tax-relevant belong, which year does it apply to, has the
-- user reviewed the AI proposal) and introduces a join table
-- `document_tax_sections` that maps a document to one or more German
-- Einkommensteuer Anlagen / Abzugsbereiche.
--
-- A document can legitimately belong to several sections (e.g. a
-- Handwerker invoice that is partly Anlage V Werbungskosten and partly
-- §35a Haushaltsnahe), so this is an N:M relation with per-link
-- `confidence` (from the LLM) and `source` (ai vs. user) so the frontend
-- can distinguish proposals from confirmed assignments.
--
-- The tax-section slug itself is **not** stored as a Postgres enum but
-- kept in TypeScript (documents/tax-sections.ts) so new sections can be
-- added without a migration. A CHECK constraint at the DB level would
-- couple the two; we validate in the service layer instead.

ALTER TABLE documents
  ADD COLUMN tax_relevant        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN tax_year            INTEGER,
  ADD COLUMN tax_year_confidence REAL,
  ADD COLUMN tax_reviewed        BOOLEAN NOT NULL DEFAULT false;--> statement-breakpoint

-- Year sanity check: guards against LLM hallucinations like "year 20".
ALTER TABLE documents
  ADD CONSTRAINT documents_tax_year_range
    CHECK (tax_year IS NULL OR (tax_year BETWEEN 2000 AND 2100));--> statement-breakpoint

-- Partial index for the "Steuer 2025"-style grouping query. Most
-- documents are not tax-relevant, so filtering out 0..9x% of the table
-- at the index level keeps this tiny.
CREATE INDEX idx_documents_tax_year
  ON documents (user_id, tax_year)
  WHERE tax_relevant = true;--> statement-breakpoint

CREATE TYPE document_tax_source AS ENUM ('ai', 'user');--> statement-breakpoint

CREATE TABLE document_tax_sections (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tax_section TEXT    NOT NULL,
  confidence  REAL,
  source      document_tax_source NOT NULL DEFAULT 'ai',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, tax_section)
);--> statement-breakpoint

-- Reverse lookup: "give me all documents assigned to section X".
CREATE INDEX idx_document_tax_sections_section
  ON document_tax_sections (tax_section);
