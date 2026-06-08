CREATE TABLE "finance_saved_analysis" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "question" text,
  "ast" jsonb NOT NULL,
  "source" text DEFAULT 'user' NOT NULL,
  "summary" jsonb,
  "fingerprint" text,
  "seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_finance_saved_analysis_user" ON "finance_saved_analysis" ("user_id", "created_at" DESC);
CREATE UNIQUE INDEX "idx_finance_saved_analysis_fingerprint" ON "finance_saved_analysis" ("user_id", "fingerprint") WHERE "fingerprint" IS NOT NULL;
