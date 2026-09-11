-- Migration 0192: heating degree days for the weather-adjusted heating report
-- (Issue #792 / #1023, report C3).
--
-- One row per month: kind = 'heating_degree_days', valid_from = first day of
-- the month, amount = degree days (Kelvin-days, VDI 2067 style), unit = 'kd'.
-- Imported through the existing tariff file import; without any rows the
-- report falls back to a reference winter estimated from the household's own
-- consumption history.

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
      'expected_return_rate',
      'gas_price',
      'gas_base_price',
      'boiler_efficiency',
      'heat_pump_scop',
      'ev_consumption',
      'petrol_consumption',
      'petrol_price',
      'grid_co2',
      'gas_co2',
      'petrol_co2',
      'pv_capacity_kwp',
      'water_price',
      'water_base_price',
      'sewage_price',
      'heating_degree_days'
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
      'ratio',
      'kwh_per_100km',
      'l_per_100km',
      'eur_per_l',
      'kg_per_kwh',
      'kg_per_l',
      'kw',
      'eur_per_m3',
      'kd'
    )
  );
