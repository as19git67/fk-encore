-- Migration 0194: report review follow-ups.
--
--  * ev_charging_loss — share of the wallbox reading lost between meter and
--    battery (ratio), optional input of the petrol-car comparison.
--  * water_main / water_garden — roles for water meters so the standing
--    charge is billed once and sewage only on water that goes down the drain.

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
      'heating_degree_days',
      'ev_charging_loss'
    )
  );--> statement-breakpoint

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
    'compressor_hours',
    'water_main',
    'water_garden'
  )
);
