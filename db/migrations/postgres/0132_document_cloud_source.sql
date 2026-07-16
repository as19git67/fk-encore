-- Migration 0132: Cloud-Teacher provenance markers (source = 'cloud').
--
-- Introduces a third, "cloud"-verified trust tier between the raw local Qwen
-- output ('ai') and a human review ('user'), so the offline Cloud-Teacher
-- (scripts/taxonomy/cloud_teacher.py) can grow the trusted example set without
-- manual classification. See docs/design/cloud-teacher-gold-set.md.
--
-- Semantics: 'ai' (raw Qwen) < 'cloud' (Claude-verified, offline) < 'user'
-- (human). Reversible by design — deleting the 'cloud' rows (or resetting
-- category_source to 'ai') lets a re-classify fall back to the Qwen values.
--
-- Scope of this migration is PURE PERSISTENCE. The classify path is NOT yet
-- wired to honour 'cloud' (that is step 4 in the design); these columns/enum
-- values only let the teacher script record its labels for later inspection.
--
-- document_tag_links.source and document_subject_persons.source are plain TEXT
-- columns and already accept 'cloud' — only the Drizzle $type annotations were
-- widened, no DDL needed here.

-- 1) New three-tier provenance enum for the category assignment and the column
--    that carries it. Backfill preserves human-pinned rows: a document that was
--    attributes_reviewed at migration time keeps 'user' provenance so the later
--    category-source guard protects it exactly like the boolean did.
CREATE TYPE document_category_source AS ENUM ('ai', 'cloud', 'user');--> statement-breakpoint

ALTER TABLE documents
  ADD COLUMN category_source document_category_source NOT NULL DEFAULT 'ai';--> statement-breakpoint

UPDATE documents SET category_source = 'user' WHERE attributes_reviewed = true;--> statement-breakpoint

-- 2) Extend the existing tax-section source enum with the cloud tier. The value
--    is only ADDED here (never used in this transaction), which PostgreSQL 12+
--    allows inside a migration transaction.
ALTER TYPE document_tax_source ADD VALUE IF NOT EXISTS 'cloud';
