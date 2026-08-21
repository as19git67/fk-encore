-- Migration 0149: equipment-condition reports.
--
-- Adds a role for the compressor hour meter (kWh per compressor hour is the
-- readable efficiency trend of a heat pump) and the assumptions the PV yield
-- and water cost reports need.

ALTER TABLE meters DROP CONSTRAINT IF EXISTS meters_role_check;--> statement-breakpoint

ALTER TABLE meters ADD CONSTRAINT meters_role_check CHECK (
  role IS NULL OR role IN (
    'grid_import',
    'grid_export',
    'pv_production',
    'heat_pump_total',
    'heat_heating_total',
    'heat_heating_pv',
    'hot_water_total',
    'hot_water_pv',
    'ev_charger_total',
    'ev_charger_pv',
    'compressor_hours'
  )
);--> statement-breakpoint

UPDATE meters
SET role = 'compressor_hours'
WHERE role IS NULL AND type = 'operating_hours' AND name = 'Verdichter';--> statement-breakpoint

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
      'petrol_co2',
      'pv_capacity_kwp',
      'water_price',
      'water_base_price',
      'sewage_price'
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
      'kg_per_l',
      'kw',
      'eur_per_m3'
    )
  );
