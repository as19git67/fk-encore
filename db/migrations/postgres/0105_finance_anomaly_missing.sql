-- Track AE: "missing regular transaction" anomaly (issue #430).
--
-- A new anomaly type "missing_transaction" fires when a recurring
-- mandate's next expected booking has been overdue past a grace period
-- with no matching transaction.  These rows carry transaction_id=NULL
-- (there is no triggering booking, by definition), so the existing
-- (transaction_id, type) unique index does not protect against
-- duplicate emission across cron runs.
--
-- We deduplicate on (mandate_id, expected_date) via a partial unique
-- expression index.  `expected_date` is the YYYY-MM-DD string stored in
-- the JSON details payload.

CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_anomaly_missing
  ON finance_anomaly (mandate_id, ((details->>'expected_date')))
  WHERE type = 'missing_transaction' AND transaction_id IS NULL;
