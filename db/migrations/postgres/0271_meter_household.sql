-- Migration 0271: share utility meters with the household (#1647).
--
-- A group can be marked as a household. Its members see the meters shared
-- with it, and the meter settings that shape costs and reports (tariffs,
-- fuel prices, heating degree days, home location) belong to the household
-- instead of the person looking, so everybody sees the same numbers.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS household BOOLEAN NOT NULL DEFAULT false;--> statement-breakpoint

-- Tariffs: group_id set = the household's row; owner_user_id stays as the
-- person who entered it. NULL = a personal row, as before.
ALTER TABLE meter_electricity_tariffs
  ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE;--> statement-breakpoint

DROP INDEX IF EXISTS meter_electricity_tariffs_unique_idx;--> statement-breakpoint

CREATE UNIQUE INDEX meter_electricity_tariffs_unique_idx
  ON meter_electricity_tariffs (
    owner_user_id,
    kind,
    valid_from,
    unit,
    COALESCE(name, '')
  )
  WHERE group_id IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX meter_electricity_tariffs_group_unique_idx
  ON meter_electricity_tariffs (
    group_id,
    kind,
    valid_from,
    unit,
    COALESCE(name, '')
  )
  WHERE group_id IS NOT NULL;--> statement-breakpoint

CREATE INDEX meter_electricity_tariffs_group_kind_idx
  ON meter_electricity_tariffs (group_id, kind, valid_from)
  WHERE group_id IS NOT NULL;--> statement-breakpoint

-- Home location: either one person's or one household's.
ALTER TABLE meter_home_locations DROP CONSTRAINT IF EXISTS meter_home_locations_pkey;--> statement-breakpoint
ALTER TABLE meter_home_locations ADD COLUMN IF NOT EXISTS id SERIAL PRIMARY KEY;--> statement-breakpoint
ALTER TABLE meter_home_locations ALTER COLUMN user_id DROP NOT NULL;--> statement-breakpoint
ALTER TABLE meter_home_locations
  ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE meter_home_locations
  ADD CONSTRAINT meter_home_locations_scope_check CHECK (num_nonnulls(user_id, group_id) = 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meter_home_locations_user_key ON meter_home_locations (user_id);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meter_home_locations_group_key ON meter_home_locations (group_id);
