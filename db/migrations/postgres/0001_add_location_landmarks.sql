-- Migration 0001: Add GPS location columns to photos, add photo_landmarks table

-- GPS and reverse-geocoded location columns
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "latitude" double precision;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "longitude" double precision;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "location_name" text;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "location_city" text;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "location_country" text;

CREATE INDEX IF NOT EXISTS "idx_photos_location_city"
  ON "photos" ("user_id", "location_city")
  WHERE "location_city" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_photos_location_coords"
  ON "photos" ("user_id", "latitude", "longitude")
  WHERE "latitude" IS NOT NULL;

-- Landmarks detected by Grounding DINO
CREATE TABLE IF NOT EXISTS "photo_landmarks" (
  "id" serial PRIMARY KEY NOT NULL,
  "photo_id" integer NOT NULL REFERENCES "photos"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "confidence" real NOT NULL,
  "bbox" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_landmarks_photo_id" ON "photo_landmarks" ("photo_id");
CREATE INDEX IF NOT EXISTS "idx_landmarks_user_id" ON "photo_landmarks" ("user_id");
