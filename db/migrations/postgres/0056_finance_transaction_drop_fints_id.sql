-- Drop finance_transaction.fints_id. The column held lib-fints'
-- bankReference (and a synthetic "fk-<id>" string for Finanzkraft
-- imports). The same bank reference now lives in bank_ref (added in
-- 0055), so the column is redundant. Idempotency was never on
-- fints_id — that's `dedupe_hash` plus the unique
-- (account_id, dedupe_hash) index — so dropping the column is safe.

ALTER TABLE finance_transaction DROP COLUMN IF EXISTS fints_id;
