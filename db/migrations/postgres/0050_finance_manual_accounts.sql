-- Manual-account flow + opt-in bank linking schema diff.
--
-- Brings an existing finance_account up to the post-refactor shape:
--
--   bankcontact_id            INTEGER NULL  REFERENCES finance_bankcontact(id)
--                                ON DELETE SET NULL
--                              (was NOT NULL + ON DELETE RESTRICT)
--   fints_account_number      TEXT NULL     -- new column
--   UNIQUE (bankcontact_id, fints_account_number)  -- new index
--
-- All changes are written with IF NOT EXISTS / IF EXISTS guards so a
-- fresh DB that already picked up the changes via the (in-place-
-- amended) 0047 migration treats this as a no-op.

-- 1. Drop the old RESTRICT FK on bankcontact_id so we can change its
--    delete-rule (Postgres has no ALTER TABLE … ALTER CONSTRAINT for
--    rule changes — drop + re-add is the standard path).
ALTER TABLE finance_account
    DROP CONSTRAINT IF EXISTS finance_account_bankcontact_id_fkey;

-- 2. Make bankcontact_id nullable. NOT VALID isn't needed — DROP NOT
--    NULL is cheap and immediate.
ALTER TABLE finance_account
    ALTER COLUMN bankcontact_id DROP NOT NULL;

-- 3. Add the new fints_account_number column.
ALTER TABLE finance_account
    ADD COLUMN IF NOT EXISTS fints_account_number TEXT;

-- 4. Backfill: every account that was already linked to a bankcontact
--    keeps its existing FinTS-side account number (we used to read
--    that out of `account_number` directly).
UPDATE finance_account
SET fints_account_number = account_number
WHERE bankcontact_id IS NOT NULL
  AND fints_account_number IS NULL;

-- 5. Re-add the FK with the new SET NULL rule.
ALTER TABLE finance_account
    ADD CONSTRAINT finance_account_bankcontact_id_fkey
    FOREIGN KEY (bankcontact_id)
    REFERENCES finance_bankcontact(id) ON DELETE SET NULL;

-- 6. Unique slot per (bankcontact, fints account number). Two manual
--    accounts (both NULLs) coexist fine — Postgres' default unique
--    semantics treat NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS finance_account_unique_bank_link
    ON finance_account (bankcontact_id, fints_account_number);
