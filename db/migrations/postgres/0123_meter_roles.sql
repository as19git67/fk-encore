-- Explicit roles for utility meters used by aggregate reports.
-- The application logic must not infer these from display names.

ALTER TABLE meters
  ADD COLUMN role TEXT;

ALTER TABLE meters
  ADD CONSTRAINT meters_role_check
  CHECK (
    role IS NULL OR role IN (
      'grid_import',
      'grid_export',
      'pv_production'
    )
  );

-- Backfill already imported historical data. New imports set role directly.
UPDATE meters
SET role = 'grid_import'
WHERE role IS NULL
  AND type = 'electricity'
  AND name = 'Netzstrom Bezug (1.8.0)';

UPDATE meters
SET role = 'grid_export'
WHERE role IS NULL
  AND type = 'electricity'
  AND name = 'Netzstrom Einspeisung (2.8.0)';

UPDATE meters
SET role = 'pv_production'
WHERE role IS NULL
  AND type = 'electricity'
  AND name = 'PV Produktion';

CREATE INDEX meters_role_idx ON meters(role) WHERE role IS NOT NULL;
