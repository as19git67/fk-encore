ALTER TABLE "photo_libraries"
  ADD COLUMN "excluded_dirs" text[] NOT NULL DEFAULT '{}'::text[];
