-- Document-type facet (Dokumentart), orthogonal to the category (Lebensbereich)
-- taxonomy. Answers "what KIND of paperwork is it?" (Rechnung, Bescheid,
-- Vertrag …) independently of the life-area the category encodes. The
-- controlled vocabulary lives in documents/document-types.ts and is validated
-- in the service layer (no Postgres enum), so new types need no migration.
--
-- A document has exactly one type, so the value sits directly on `documents`
-- rather than in a join table. Both columns are nullable: existing rows stay
-- untyped until the next (re-)classification writes a value, and a document the
-- classifier cannot type keeps NULL rather than a forced "sonstiges".
ALTER TABLE documents
  ADD COLUMN document_type TEXT,
  ADD COLUMN document_type_confidence REAL;
