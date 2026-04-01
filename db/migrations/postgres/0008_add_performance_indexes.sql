CREATE INDEX IF NOT EXISTS "photos_user_id_idx" ON "photos" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_taken_at_idx" ON "photos" ("taken_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_user_id_idx" ON "faces" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_photo_id_idx" ON "faces" ("photo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_person_id_idx" ON "faces" ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_user_id_idx" ON "persons" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "albums_user_id_idx" ON "albums" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_groups_user_id_idx" ON "photo_groups" ("user_id");
