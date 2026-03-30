CREATE TABLE IF NOT EXISTS "album_user_settings" (
	"album_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"hide_mode" text DEFAULT 'mine' NOT NULL,
	"active_view" text DEFAULT 'all' NOT NULL,
	"view_config" jsonb,
	CONSTRAINT "album_user_settings_album_id_user_id_pk" PRIMARY KEY("album_id","user_id")
);
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='album_photos' AND column_name='added_by_user_id') THEN
        ALTER TABLE "album_photos" ADD COLUMN "added_by_user_id" integer;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='album_photos' AND column_name='added_at') THEN
        ALTER TABLE "album_photos" ADD COLUMN "added_at" timestamp DEFAULT now();
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='album_user_settings_album_id_albums_id_fk') THEN
        ALTER TABLE "album_user_settings" ADD CONSTRAINT "album_user_settings_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='album_user_settings_user_id_users_id_fk') THEN
        ALTER TABLE "album_user_settings" ADD CONSTRAINT "album_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='album_photos_added_by_user_id_users_id_fk') THEN
        ALTER TABLE "album_photos" ADD CONSTRAINT "album_photos_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
-- Ensure scan_service enum has 'quality' value
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'scan_service' AND e.enumlabel = 'quality') THEN
        ALTER TYPE scan_service ADD VALUE 'quality';
    END IF;
END
$$;