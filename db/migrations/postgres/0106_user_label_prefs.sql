-- Per-user label-printing preferences for the Label module. Stores the CUPS
-- printer the user last selected (e.g. {"printer": "DYMO_LabelWriter_450"})
-- so the choice is persisted across sessions and devices.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS label_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
