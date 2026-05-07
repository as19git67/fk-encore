-- Rename gv_code → transaction_type and add the two flanking ISO Bank
-- Transaction Code (BTC) fields.
--
-- ISO BTC hierarchy:
--   Domain     → funds_code       (e.g. "PMNT", "CAMT", "TRAD")
--   Family     → transaction_type (e.g. "RCDT", "ICDT", "IDDT", "ODDT")
--   SubFamily  → transaction_code (e.g. "AUTT", "DMCT", "ESCT", "UPAY")
--
-- In MT940 format these map to:
--   funds_code       ← funds code character (field :61: position after C/D)
--   transaction_type ← GVC / Geschäftsvorfall-Code (formerly gv_code)
--   transaction_code ← sub-field 61 transaction code
--
-- In CAMT.053 format:
--   funds_code       ← BkTxCd/Domn/Cd  or credit/debit indicator
--   transaction_type ← BkTxCd/Domn/Fmly/Cd
--   transaction_code ← BkTxCd/Domn/Fmly/SubFmlyCd
--
-- The rename is non-destructive: existing values in gv_code (imported
-- from Finanzkraft) are preserved under the new column name.

ALTER TABLE finance_transaction
    RENAME COLUMN gv_code TO transaction_type;

ALTER TABLE finance_transaction
    ADD COLUMN funds_code      TEXT,
    ADD COLUMN transaction_code TEXT;
