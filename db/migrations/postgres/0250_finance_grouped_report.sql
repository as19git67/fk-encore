-- Transaction reports in groups with subtotals and an optional yield
-- (documentation/plans/ki-assistent.md, stage 6, issue #1533).
--
-- The definition is what the report is made of — groups of booking ids or
-- of one user tag each, the bookings it covers, the yield's groups — never
-- the numbers: every run computes them from the bookings as they are, so a
-- tag group picks up bookings tagged since.
CREATE TABLE IF NOT EXISTS "finance_grouped_report" (
  "id" bigserial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "definition" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_grouped_report_by_user" ON "finance_grouped_report" ("user_id", "created_at");
