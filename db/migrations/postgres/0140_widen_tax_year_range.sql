-- Widen the tax_year CHECK constraint's lower bound from 2000 to 1970.
--
-- Household documents legitimately span decades (a 1997 Jahresdepotauszug is
-- a real, unremarkable case). The application-level bounds in
-- llm-service/main.py (ClassifyResponse.tax_year) and documents/llm-client.ts
-- (TAX_YEAR_MIN) were already widened to 1970 — this DB-level constraint was
-- missed, so a document with e.g. tax_year=1997 passed app validation but
-- then failed on UPDATE with "violates check constraint
-- documents_tax_year_range", crashing the classify job outright (a hard SQL
-- error, not the graceful schema-mismatch path).
ALTER TABLE documents
  DROP CONSTRAINT documents_tax_year_range;

ALTER TABLE documents
  ADD CONSTRAINT documents_tax_year_range
    CHECK (tax_year IS NULL OR (tax_year BETWEEN 1970 AND 2100));
