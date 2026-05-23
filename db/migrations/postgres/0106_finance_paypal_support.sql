-- PayPal connector foundation for finance_bankcontact (Issue #427, Etappe 1).
--
-- Introduces an `access_type` discriminator alongside the existing FinTS
-- columns so the upcoming PayPal connector can share the same table.
-- FinTS-specific columns (blz, login, server_url) become nullable; the
-- per-access_type validation now lives in the application layer
-- (finance/bankcontacts.ts).
--
-- New PayPal columns (all NULL for FinTS rows):
--   paypal_environment   — "sandbox" | "live", switchable per contact
--   paypal_client_id     — public PayPal-side identifier of the connected
--                          account (e.g. payer_id), populated by the
--                          OAuth callback in Etappe 5
--   paypal_merchant_id   — held in reserve for the Phase-2 webhook
--                          router so events can be matched to a contact
--
-- finance_account_balance.source picks up "paypal" as a third value
-- (alongside "fints" | "manual" | "import"). It is a free-text column,
-- so no DDL change is needed there.

ALTER TABLE finance_bankcontact
    ADD COLUMN IF NOT EXISTS access_type text NOT NULL DEFAULT 'fints';

ALTER TABLE finance_bankcontact
    ADD COLUMN IF NOT EXISTS paypal_environment text;

ALTER TABLE finance_bankcontact
    ADD COLUMN IF NOT EXISTS paypal_client_id text;

ALTER TABLE finance_bankcontact
    ADD COLUMN IF NOT EXISTS paypal_merchant_id text;

ALTER TABLE finance_bankcontact ALTER COLUMN blz DROP NOT NULL;
ALTER TABLE finance_bankcontact ALTER COLUMN login DROP NOT NULL;
ALTER TABLE finance_bankcontact ALTER COLUMN server_url DROP NOT NULL;
