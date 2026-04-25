-- Lift the SEPA / MT940 / multi-currency fields out of the `raw` jsonb
-- blob into proper typed columns. The Finanzkraft import pre-parses
-- these from the raw bank text, fk-encore's own FinTS path produces
-- them from `lib-fints` — both ends end up writing the same shape.
--
-- Naming follows the SEPA / ISO-20022 conventions (end_to_end_ref,
-- mandate_ref, creditor_id) plus a few legacy MT940 fields (gv_code,
-- entry_text, prima_nota_no) that lib-fints still surfaces.
--
-- All columns nullable: most transactions don't carry a full SEPA
-- mandate context, and historical MT940 imports can be sparse.

ALTER TABLE finance_transaction
    ADD COLUMN end_to_end_ref       TEXT,
    ADD COLUMN mandate_ref          TEXT,
    ADD COLUMN creditor_id          TEXT,
    ADD COLUMN bank_ref             TEXT,
    ADD COLUMN originator_name      TEXT,
    ADD COLUMN recipient_name       TEXT,
    ADD COLUMN counterparty_bic     TEXT,
    ADD COLUMN counterparty_bank_id TEXT,
    ADD COLUMN gv_code              TEXT,
    ADD COLUMN entry_text           TEXT,
    ADD COLUMN prima_nota_no        TEXT,
    ADD COLUMN original_amount      NUMERIC(14, 2),
    ADD COLUMN original_currency_code TEXT,
    ADD COLUMN exchange_rate        NUMERIC(12, 6);
