-- Album names are unique per owner, ignoring case and surrounding spaces.
-- Albums that already share a name stay untouched: nothing is deleted or
-- merged. Every album but the oldest of such a group is flagged
-- legacy_duplicate_name and left out of the unique index, so the index can be
-- built today; the flag is cleared when the album is renamed.
ALTER TABLE "albums" ADD COLUMN IF NOT EXISTS "legacy_duplicate_name" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "albums" AS a
SET "legacy_duplicate_name" = true
WHERE EXISTS (
  SELECT 1 FROM "albums" AS b
  WHERE b."user_id" = a."user_id"
    AND lower(btrim(b."name")) = lower(btrim(a."name"))
    AND b."id" < a."id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "albums_owner_name_unique"
  ON "albums" ("user_id", lower(btrim("name")))
  WHERE NOT "legacy_duplicate_name";
