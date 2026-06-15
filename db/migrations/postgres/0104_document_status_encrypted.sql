-- Add 'encrypted' to the document_status enum. Documents whose PDF needs an
-- open ("user") password are parked in this state by the scan pipeline
-- (runTextExtract) so the UI can prompt for the password instead of failing
-- the document with a cryptic poppler error. The unlock endpoint decrypts the
-- file with the supplied password and re-runs the pipeline.
--
-- Postgres requires the ADD VALUE to be committed before the value can be
-- referenced, so this migration is kept intentionally small.

ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'encrypted';
