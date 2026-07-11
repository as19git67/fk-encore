-- Migration 0125: electricity tariff timelines and PV price assumptions.

CREATE TABLE meter_electricity_tariffs (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  amount NUMERIC(14, 6) NOT NULL,
  unit TEXT NOT NULL,
  tax_status TEXT,
  name TEXT,
  capacity_limit_kw NUMERIC(10, 3),
  source JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meter_electricity_tariffs_kind_check CHECK (
    kind IN (
      'grid_import',
      'base_price',
      'feed_in',
      'self_consumption_value',
      'pv_investment_net',
      'pv_investment_vat',
      'opportunity_cost_year',
      'opportunity_cost_total',
      'amortization_years'
    )
  ),
  CONSTRAINT meter_electricity_tariffs_unit_check CHECK (
    unit IN ('eur_per_kwh', 'eur_per_month', 'eur', 'years')
  )
);--> statement-breakpoint

CREATE INDEX meter_electricity_tariffs_owner_kind_idx
  ON meter_electricity_tariffs (owner_user_id, kind, valid_from);--> statement-breakpoint

CREATE UNIQUE INDEX meter_electricity_tariffs_unique_idx
  ON meter_electricity_tariffs (
    owner_user_id,
    kind,
    valid_from,
    unit,
    COALESCE(name, '')
  );
