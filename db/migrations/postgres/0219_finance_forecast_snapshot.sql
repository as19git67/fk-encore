-- Retirement forecast: plan vs. actual (#1342).
--
-- A snapshot keeps the yearly series of a scenario as the forecast saw it
-- on a day, together with the liquid wealth and total wealth the household
-- had then. Later the page puts today's actual wealth next to what the
-- snapshot expected for today. Taken by hand or by the monthly cron.

CREATE TABLE finance_forecast_snapshot (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id INTEGER REFERENCES finance_forecast_scenario(id) ON DELETE SET NULL,
  scenario_name TEXT NOT NULL,
  source TEXT NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  start_liquid NUMERIC(14,2) NOT NULL,
  start_wealth NUMERIC(14,2) NOT NULL,
  -- [{ year, wealth, liquid }] per simulated year
  series JSONB NOT NULL,
  config JSONB NOT NULL,
  CONSTRAINT finance_forecast_snapshot_source_check CHECK (source IN ('manual', 'cron'))
);

CREATE INDEX idx_finance_forecast_snapshot_user ON finance_forecast_snapshot (user_id, taken_at DESC);
