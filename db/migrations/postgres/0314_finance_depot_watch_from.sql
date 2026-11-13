-- The day from which a depot is looked at (`finance/depot-watch-from.ts`):
-- holdings and transactions before it are neither read in nor counted.
ALTER TABLE "finance_account" ADD COLUMN IF NOT EXISTS "watch_from" date;
