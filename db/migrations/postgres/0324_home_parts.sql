-- Haus › Anlagen, stage 3 (documentation/plans/haus-anlagen.md): a catalog of
-- spare parts and consumables for the whole household. Visibility as for the
-- systems: the owner plus every member of group_id.
CREATE TABLE IF NOT EXISTS home_parts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT,
  part_number TEXT,
  ean TEXT,
  specification TEXT,
  supplier_url TEXT,
  storage_location TEXT,
  -- NULL = not counted; 0 is shown as "none left".
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  notes TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_parts_owner_idx ON home_parts (owner_user_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_parts_group_idx ON home_parts (group_id);--> statement-breakpoint
-- A part can fit several systems (one seal for two pumps).
CREATE TABLE IF NOT EXISTS home_system_parts (
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES home_parts(id) ON DELETE CASCADE,
  PRIMARY KEY (system_id, part_id)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_system_parts_part_idx ON home_system_parts (part_id);--> statement-breakpoint
-- The part an item in place takes (the aerator at each tap).
ALTER TABLE home_system_items ADD COLUMN IF NOT EXISTS part_id INTEGER REFERENCES home_parts(id) ON DELETE SET NULL;--> statement-breakpoint
-- A part's photo belongs to no system: system_id is empty exactly for parts,
-- and visibility comes from the part.
ALTER TABLE home_media ALTER COLUMN system_id DROP NOT NULL;--> statement-breakpoint
ALTER TABLE home_media DROP CONSTRAINT IF EXISTS home_media_target_kind_check;--> statement-breakpoint
ALTER TABLE home_media ADD CONSTRAINT home_media_target_kind_check
  CHECK (target_kind IN ('system', 'guide', 'item', 'note', 'part'));--> statement-breakpoint
ALTER TABLE home_media ADD CONSTRAINT home_media_part_without_system
  CHECK ((target_kind = 'part') = (system_id IS NULL));
