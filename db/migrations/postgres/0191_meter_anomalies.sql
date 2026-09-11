-- Migration 0191: meter anomaly detection (Issue #792, Etappe 7 / #1015).
--
-- A daily job derives the daily consumption rate of the latest reading
-- intervals per metering point and compares it against the rolling
-- mean/stddev of the intervals before (z-score) and against the same month a
-- year earlier (seasonality). Findings land here with a status the user
-- works through: pending → confirmed | dismissed.
--
-- (meter_id, type, interval_end) is the idempotency anchor: the job re-runs
-- every day over the same recent intervals and must not duplicate a finding.

CREATE TABLE IF NOT EXISTS meter_anomalies (
  id BIGSERIAL PRIMARY KEY,
  meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  -- Reading that closes the flagged interval (NULL once it is deleted).
  reading_id BIGINT REFERENCES meter_readings(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'consumption_spike',
    'consumption_drop',
    'standstill',
    'negative_consumption'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  -- z-score of the interval's daily rate against the baseline (NULL where a
  -- z-score is not meaningful, e.g. negative consumption).
  score NUMERIC(8,3),
  interval_start TIMESTAMPTZ NOT NULL,
  interval_end TIMESTAMPTZ NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (meter_id, type, interval_end)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS meter_anomalies_meter_status_idx
  ON meter_anomalies (meter_id, status, created_at DESC);
