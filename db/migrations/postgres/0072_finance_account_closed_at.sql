-- Allow accounts to be marked as closed.
--
-- Closed accounts stay visible (so historical transactions and balances
-- remain accessible read-only) but reject new bookings: the manual
-- transaction-insert API and the FinTS sync path both refuse to write
-- once `closed_at` is non-null. Re-opening is a simple `closed_at = NULL`
-- update.
--
-- Nullable timestamp instead of a boolean so the UI can show *when* an
-- account was closed without a separate audit table.

ALTER TABLE finance_account
    ADD COLUMN closed_at TIMESTAMP WITH TIME ZONE;
