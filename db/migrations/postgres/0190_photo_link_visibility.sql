-- Per-photo visibility in anonymous public-link views.
--
--   'auto'    (default) — shown unless the photo carries a face an album
--                         participant has assigned to a named person
--   'visible'           — always shown, even with a known face on it
--   'hidden'            — never shown, even without a face on it
--
-- Signed-in users and album collaborators are unaffected by this column.
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "link_visibility" text NOT NULL DEFAULT 'auto';

ALTER TABLE "photos" DROP CONSTRAINT IF EXISTS "photos_link_visibility_check";
ALTER TABLE "photos" ADD CONSTRAINT "photos_link_visibility_check"
  CHECK ("link_visibility" IN ('auto', 'visible', 'hidden'));

CREATE INDEX IF NOT EXISTS "idx_photos_link_visibility" ON "photos" ("link_visibility")
  WHERE "link_visibility" <> 'auto';
