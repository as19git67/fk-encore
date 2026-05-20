ALTER TABLE "photos" ADD COLUMN "image_data_hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_user_hash_idx" ON "photos" ("user_id","hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_user_image_data_hash_idx" ON "photos" ("user_id","image_data_hash");
