-- Migration 0148: assumptions for the gas-heating and petrol-car comparisons.
--
-- These are model assumptions, not measured tariffs, but they share the same
-- shape (kind, valid_from, amount, unit) and the same "which value was in
-- force when" logic, so they live in the existing table rather than a second
-- one with duplicated CRUD.

ALTER TABLE meter_electricity_tariffs
  DROP CONSTRAINT IF EXISTS meter_electricity_tariffs_kind_check;--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  ADD CONSTRAINT meter_electricity_tariffs_kind_check CHECK (
    kind IN (
      'grid_import',
      'base_price',
      'feed_in',
      'self_consumption_value',
      'pv_investment_net',
      'pv_investment_vat',
      'opportunity_cost_year',
      'opportunity_cost_total',
      'amortization_years',
      'gas_price',
      'gas_base_price',
      'boiler_efficiency',
      'heat_pump_scop',
      'ev_consumption',
      'petrol_consumption',
      'petrol_price',
      'grid_co2',
      'gas_co2',
      'petrol_co2'
    )
  );--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  DROP CONSTRAINT IF EXISTS meter_electricity_tariffs_unit_check;--> statement-breakpoint

ALTER TABLE meter_electricity_tariffs
  ADD CONSTRAINT meter_electricity_tariffs_unit_check CHECK (
    unit IN (
      'eur_per_kwh',
      'eur_per_month',
      'eur',
      'years',
      'ratio',
      'kwh_per_100km',
      'l_per_100km',
      'eur_per_l',
      'kg_per_kwh',
      'kg_per_l'
    )
  );
