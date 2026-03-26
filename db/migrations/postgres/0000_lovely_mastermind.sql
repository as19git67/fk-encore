CREATE TABLE "album_photos" (
	"album_id" integer NOT NULL,
	"photo_id" integer NOT NULL,
	CONSTRAINT "album_photos_album_id_photo_id_pk" PRIMARY KEY("album_id","photo_id")
);
--> statement-breakpoint
CREATE TABLE "album_shares" (
	"album_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"access_level" text DEFAULT 'read' NOT NULL,
	CONSTRAINT "album_shares_album_id_user_id_pk" PRIMARY KEY("album_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now(),
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faces" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"photo_id" integer NOT NULL,
	"bbox" text NOT NULL,
	"embedding" text NOT NULL,
	"person_id" integer,
	"quality" integer DEFAULT 0,
	"ignored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" text DEFAULT 'singleDevice' NOT NULL,
	"backed_up" integer DEFAULT 0 NOT NULL,
	"transports" text DEFAULT '[]',
	"name" text DEFAULT 'Passkey' NOT NULL,
	"disabled" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text DEFAULT '',
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text DEFAULT 'Unbenannt' NOT NULL,
	"cover_face_id" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "photo_curation" (
	"user_id" integer NOT NULL,
	"photo_id" integer NOT NULL,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "photo_curation_user_id_photo_id_pk" PRIMARY KEY("user_id","photo_id")
);
--> statement-breakpoint
CREATE TABLE "photo_group_members" (
	"group_id" integer NOT NULL,
	"photo_id" integer NOT NULL,
	"similarity_rank" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "photo_group_members_group_id_photo_id_pk" PRIMARY KEY("group_id","photo_id")
);
--> statement-breakpoint
CREATE TABLE "photo_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"cover_photo_id" integer,
	"reviewed_at" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"filename" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"hash" text,
	"taken_at" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" integer NOT NULL,
	"permission_id" integer NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "album_photos" ADD CONSTRAINT "album_photos_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_photos" ADD CONSTRAINT "album_photos_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_shares" ADD CONSTRAINT "album_shares_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_shares" ADD CONSTRAINT "album_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_curation" ADD CONSTRAINT "photo_curation_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_curation" ADD CONSTRAINT "photo_curation_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_group_members" ADD CONSTRAINT "photo_group_members_group_id_photo_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."photo_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_group_members" ADD CONSTRAINT "photo_group_members_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_groups" ADD CONSTRAINT "photo_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_groups" ADD CONSTRAINT "photo_groups_cover_photo_id_photos_id_fk" FOREIGN KEY ("cover_photo_id") REFERENCES "public"."photos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;