-- Binder labels (label/binder-sheet.ts): a filled A4 page of four spine
-- labels of 192 × 61 mm, saved under a name to be opened and changed again.
-- The PDF is rendered from these values on every download, no file is kept.
CREATE TABLE IF NOT EXISTS label_binder_page (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  labels JSONB NOT NULL,
  direction TEXT NOT NULL DEFAULT 'across' CHECK (direction IN ('across', 'along')),
  align TEXT NOT NULL DEFAULT 'center' CHECK (align IN ('left', 'center')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS label_binder_page_user_name_idx ON label_binder_page (user_id, lower(name));
