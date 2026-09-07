-- A manually edited stay length belongs to the spot, not to one generated
-- stop row. Re-planning therefore needs the override to survive alongside
-- the title, note and source URL.
ALTER TABLE trip_spot_notes
  ADD COLUMN IF NOT EXISTS dwell_minutes integer;
