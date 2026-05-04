CREATE INDEX IF NOT EXISTS "photos_user_taken_id_idx" ON "photos" ("user_id", "taken_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_user_created_id_idx" ON "photos" ("user_id", "created_at", "id");
