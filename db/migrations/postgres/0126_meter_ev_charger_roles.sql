-- Migration 0126: optional EV / wallbox roles for energy reports.

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
    'ev_charger_pv'
  )
);
