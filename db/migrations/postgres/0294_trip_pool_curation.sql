-- Curation of a stay's pool by the local model (candidate ranking plan,
-- stage 3). The pool rows remember what the scoring gave them, so the
-- model's order can be applied without re-planning; the order itself
-- lives per leg, because the pool is rewritten on every re-plan.
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS search_score REAL;
--> statement-breakpoint
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS curated_score REAL;
--> statement-breakpoint
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS curated_reason TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trip_leg_curation (
  leg_id INTEGER PRIMARY KEY REFERENCES trip_plan_legs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  signature JSONB,
  picks JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trip_leg_curation_status_idx ON trip_leg_curation (status, requested_at);
