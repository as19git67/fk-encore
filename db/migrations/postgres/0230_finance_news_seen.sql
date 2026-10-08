-- When a user last looked at the news of a security, so the quotes page
-- can count what came in since.
CREATE TABLE "finance_news_seen" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "position_key" text NOT NULL,
  "seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "finance_news_seen_user_id_position_key_pk" PRIMARY KEY("user_id","position_key")
);
