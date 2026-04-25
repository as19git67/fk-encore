-- Persist the lib-fints `bankingInformation` (BPD + UPD + the bank-
-- assigned `systemId`) on the bankcontact so subsequent syncs can
-- reuse it via `FinTSConfig.fromBankingInformation` and skip the
-- per-sync TAN under PSD2's 90-day rule.
--
-- Nullable: NULL means "no warm-start cache yet, do a cold init via
-- forFirstTimeUse on the next sync". Cleared on credential changes
-- so an outdated session doesn't poison the next dialog.

ALTER TABLE finance_bankcontact
    ADD COLUMN IF NOT EXISTS banking_information JSONB;
