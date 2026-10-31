-- The reading dialog, the API and the readings list have always carried a
-- note per reading, but the table never had the column: every note was
-- dropped on insert and update.
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS notes TEXT;
