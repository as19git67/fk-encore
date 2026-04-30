-- Recurring mandate registry and anomaly detection tables.
--
-- finance_recurring_mandate: one row per unique SEPA mandate (or
-- counterparty-IBAN group as fallback). Updated incrementally by the
-- daily anomaly-detection cron job.
--
-- finance_anomaly: one row per detected anomaly, linked to the
-- triggering transaction and optionally the mandate. acknowledged_at
-- stays NULL until the user dismisses the alert in the UI.

CREATE TABLE finance_recurring_mandate (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
  -- Primary grouping key: mandate_ref + creditor_id when available,
  -- counterparty_iban alone as fallback, counterparty name as last resort.
  mandate_ref           TEXT,
  creditor_id           TEXT,
  counterparty_iban     TEXT,
  counterparty          TEXT,
  -- Statistical baseline updated on every new matching transaction.
  typical_amount        NUMERIC(12,2),
  typical_interval_days INTEGER,
  transaction_count     INTEGER NOT NULL DEFAULT 0,
  first_seen            DATE,
  last_seen             DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- At least one of the grouping keys must be set.
  CONSTRAINT chk_mandate_key CHECK (
    mandate_ref IS NOT NULL OR creditor_id IS NOT NULL
    OR counterparty_iban IS NOT NULL OR counterparty IS NOT NULL
  )
);

-- Unique mandate per account: prefer mandate_ref+creditor_id, fall back
-- to iban, fall back to name. Separate partial indexes avoid nullability
-- issues with multi-column unique constraints.
CREATE UNIQUE INDEX uq_mandate_mref_cred
  ON finance_recurring_mandate (account_id, mandate_ref, creditor_id)
  WHERE mandate_ref IS NOT NULL AND creditor_id IS NOT NULL;

CREATE UNIQUE INDEX uq_mandate_iban
  ON finance_recurring_mandate (account_id, counterparty_iban)
  WHERE mandate_ref IS NULL AND creditor_id IS NULL AND counterparty_iban IS NOT NULL;

CREATE UNIQUE INDEX uq_mandate_name
  ON finance_recurring_mandate (account_id, counterparty)
  WHERE mandate_ref IS NULL AND creditor_id IS NULL AND counterparty_iban IS NULL AND counterparty IS NOT NULL;

CREATE TABLE finance_anomaly (
  id              BIGSERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES finance_account(id) ON DELETE CASCADE,
  transaction_id  BIGINT REFERENCES finance_transaction(id) ON DELETE SET NULL,
  mandate_id      BIGINT REFERENCES finance_recurring_mandate(id) ON DELETE SET NULL,
  -- 'amount_change' | 'duplicate' | 'new_mandate'
  type            TEXT NOT NULL,
  -- 0..1 confidence / severity score
  score           NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  -- Structured payload, type-specific:
  --   amount_change: {previous, current, diff, pct}
  --   duplicate:     {original_transaction_id, amount, booking_date}
  --   new_mandate:   {counterparty, amount}
  details         JSONB NOT NULL DEFAULT '{}',
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: unacknowledged anomalies per account (UI badge count).
CREATE INDEX idx_finance_anomaly_unread
  ON finance_anomaly (account_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- Avoid duplicate anomalies for the same transaction+type combo.
CREATE UNIQUE INDEX uq_finance_anomaly_tx_type
  ON finance_anomaly (transaction_id, type)
  WHERE transaction_id IS NOT NULL;
