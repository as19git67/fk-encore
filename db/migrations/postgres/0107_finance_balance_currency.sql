-- Multi-currency balance support (Issue #427, Etappe 6).
--
-- Until now finance_account_balance had a (account_id, as_of) primary
-- key, which silently assumed one balance per account per timestamp.
-- That assumption breaks for PayPal wallets where a single
-- finance_account can hold balances in EUR, USD, … at the same time.
--
-- We add the currency_code column with the account's currency as the
-- backfill value (every existing FinTS row already implicitly stored
-- the account's home currency) and recompose the primary key around it.
-- Existing FinTS sync continues to write its single row per as_of
-- unchanged; the new PayPal path can now write one row per currency
-- under the same as_of.
--
-- finance_account_balance.source picks up "paypal" alongside
-- "fints" | "manual" | "import". No DDL change needed (free-text).

ALTER TABLE finance_account_balance
    ADD COLUMN IF NOT EXISTS currency_code text;

UPDATE finance_account_balance b
SET currency_code = a.currency_code
FROM finance_account a
WHERE b.account_id = a.id
  AND b.currency_code IS NULL;

ALTER TABLE finance_account_balance
    ALTER COLUMN currency_code SET NOT NULL;

ALTER TABLE finance_account_balance
    DROP CONSTRAINT IF EXISTS finance_account_balance_account_id_as_of_pk;
ALTER TABLE finance_account_balance
    DROP CONSTRAINT IF EXISTS finance_account_balance_pkey;
ALTER TABLE finance_account_balance
    ADD CONSTRAINT finance_account_balance_pkey
    PRIMARY KEY (account_id, as_of, currency_code);

ALTER TABLE finance_account_balance
    DROP CONSTRAINT IF EXISTS finance_account_balance_currency_code_finance_currency_code_fk;
ALTER TABLE finance_account_balance
    ADD CONSTRAINT finance_account_balance_currency_code_finance_currency_code_fk
    FOREIGN KEY (currency_code) REFERENCES finance_currency(code)
    ON DELETE RESTRICT;
