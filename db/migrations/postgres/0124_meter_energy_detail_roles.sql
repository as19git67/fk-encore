ALTER TABLE meters DROP CONSTRAINT IF EXISTS meters_role_check;

ALTER TABLE meters ADD CONSTRAINT meters_role_check CHECK (
  role IS NULL OR role IN (
    'grid_import',
    'grid_export',
    'pv_production',
    'heat_pump_total',
    'heat_heating_total',
    'heat_heating_pv',
    'hot_water_total',
    'hot_water_pv'
  )
);

UPDATE meters
SET role = 'heat_pump_total'
WHERE role IS NULL AND type = 'electricity' AND name = 'Wärmepumpe Komplett';

UPDATE meters
SET role = 'heat_heating_total'
WHERE role IS NULL AND type = 'electricity' AND name = 'Fußbodenheizung';

UPDATE meters
SET role = 'heat_heating_pv'
WHERE role IS NULL AND type = 'electricity' AND name = 'Fußbodenheizung PV';

UPDATE meters
SET role = 'hot_water_total'
WHERE role IS NULL AND type = 'electricity' AND name = 'Warmwasser';

UPDATE meters
SET role = 'hot_water_pv'
WHERE role IS NULL AND type = 'electricity' AND name = 'Warmwasser PV';
