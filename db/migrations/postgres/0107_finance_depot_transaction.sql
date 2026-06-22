-- Track AC Phase 2 (#439 / #428): per-position depot transactions.
--
-- Records buys / sells / dividends / corporate actions per holding so a
-- depot position can show when and at what price it was acquired or sold.
-- This first iteration covers the table itself plus manual entry; later
-- iterations add giro-booking derivation (source='giro-derived') and CSV
-- import (source='csv-import').
--
-- A position is identified the same way as in finance_account_holding:
-- COALESCE(isin, wkn, name). The optional linked_transaction_id ties a
-- derived row back to the giro/clearing booking it came from.
--
-- `dedupe_hash` makes idempotent imports possible; manual rows leave it
-- NULL (no dedup) and the partial unique index only guards non-NULL
-- hashes.

CREATE TABLE finance_depot_transaction (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
  isin                  TEXT,
  wkn                   TEXT,
  name                  TEXT,
  -- buy | sell | in | out | dividend | split | corp_action
  kind                  TEXT NOT NULL,
  executed_at           DATE NOT NULL,
  amount                NUMERIC(20, 8),
  price                 NUMERIC(20, 6),
  gross_amount          NUMERIC(18, 2),
  fees                  NUMERIC(18, 2),
  tax                   NUMERIC(18, 2),
  net_amount            NUMERIC(18, 2),
  currency              TEXT,
  -- fints-mt536 | giro-derived | csv-import | manual
  source                TEXT NOT NULL DEFAULT 'manual',
  linked_transaction_id BIGINT REFERENCES finance_transaction(id) ON DELETE SET NULL,
  note                  TEXT,
  dedupe_hash           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX finance_depot_transaction_account_idx
  ON finance_depot_transaction (account_id, executed_at DESC);

CREATE INDEX finance_depot_transaction_position_idx
  ON finance_depot_transaction (account_id, isin, wkn);

CREATE UNIQUE INDEX finance_depot_transaction_dedupe_unique
  ON finance_depot_transaction (account_id, dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;
