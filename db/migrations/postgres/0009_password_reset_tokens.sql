CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp NOT NULL
);
