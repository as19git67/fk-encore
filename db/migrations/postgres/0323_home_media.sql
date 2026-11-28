-- Haus › Anlagen, stage 2 (documentation/plans/haus-anlagen.md): photos of a
-- system, its guides, items and notes. The files live on a volume
-- (HOME_MEDIA_DIR); a row names one of them by `object_key`.
--
-- `target_kind`/`target_id` say what the photo belongs to and have no foreign
-- key (the target is one of several tables). `system_id` is the system every
-- target belongs to: visibility comes from it, and deleting a system takes its
-- rows along. The service removes the files with their target; a nightly sweep
-- removes rows whose target is gone and files without a row.
CREATE TABLE IF NOT EXISTS home_media (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('system', 'guide', 'item', 'note')),
  target_id INTEGER NOT NULL,
  object_key TEXT NOT NULL CONSTRAINT home_media_object_key_unique UNIQUE,
  caption TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_media_system_idx ON home_media (system_id, id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS home_media_target_idx ON home_media (target_kind, target_id);
