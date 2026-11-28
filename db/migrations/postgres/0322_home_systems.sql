-- Haus › Anlagen, stage 1 (documentation/plans/haus-anlagen.md, #1926):
-- a reference handbook per technical system of the house. Visibility as for
-- meters: the owner plus every member of group_id.
CREATE TABLE IF NOT EXISTS home_systems (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN
    ('heating', 'water', 'ventilation', 'sanitary', 'electrical', 'garden', 'building', 'other')),
  location TEXT,
  manufacturer TEXT,
  model TEXT,
  installed_on DATE,
  description TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  archived_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_systems_owner_idx ON home_systems (owner_user_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_systems_group_idx ON home_systems (group_id);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS home_system_guides (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_system_guides_system_idx ON home_system_guides (system_id, sort);--> statement-breakpoint
-- The state of a guide before each change, so an edit can be undone.
CREATE TABLE IF NOT EXISTS home_system_guide_revisions (
  id SERIAL PRIMARY KEY,
  guide_id INTEGER NOT NULL REFERENCES home_system_guides(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  edited_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_system_guide_revisions_guide_idx ON home_system_guide_revisions (guide_id, created_at);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS home_system_items (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  location TEXT,
  attributes JSONB NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_system_items_system_idx ON home_system_items (system_id, sort);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS home_system_notes (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  noted_on DATE NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_system_notes_system_idx ON home_system_notes (system_id, noted_on);
