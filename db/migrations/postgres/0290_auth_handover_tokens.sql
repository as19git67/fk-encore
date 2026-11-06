-- One-time tokens with which a signed-in app hands its session to the web
-- app in an in-app browser (documentation/plans/assistent-ios.md, stage 5).
CREATE TABLE IF NOT EXISTS "auth_handover_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp NOT NULL
);
