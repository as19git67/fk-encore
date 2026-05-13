CREATE TABLE finance_account_holding (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
  as_of         DATE    NOT NULL,
  isin          TEXT,
  wkn           TEXT,
  name          TEXT,
  amount        NUMERIC(20, 8),
  price         NUMERIC(20, 6),
  value         NUMERIC(18, 2),
  currency      TEXT,
  acquisition_date  DATE,
  acquisition_price NUMERIC(20, 6),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX finance_account_holding_account_asof_idx
  ON finance_account_holding (account_id, as_of DESC);

CREATE UNIQUE INDEX finance_account_holding_unique_idx
  ON finance_account_holding (account_id, as_of, COALESCE(isin, wkn, name));
