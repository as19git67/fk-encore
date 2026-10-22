-- Personal taste model of the auto-pick (documentation/plans/foto-aesthetik.md,
-- stage 7): a linear model on the CLIP vector, learnt from the user's own
-- reviewed groups. One row per user; no row keeps the formula as it is.
CREATE TABLE IF NOT EXISTS "ai_pick_taste_model" (
  "user_id" integer PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "version" text NOT NULL,
  "weights" jsonb NOT NULL,
  "base_weight" double precision NOT NULL,
  "offset" double precision NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "fitted_at" timestamp with time zone NOT NULL DEFAULT now()
);
