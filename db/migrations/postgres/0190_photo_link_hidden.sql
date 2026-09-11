-- Per-photo opt-out of public link sharing.
-- When true the photo stays visible to signed-in users but is excluded from
-- every anonymous public-link view (listing, cover and raw file access).
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "link_hidden" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_photos_link_hidden" ON "photos" ("link_hidden") WHERE "link_hidden";
