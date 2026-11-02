-- A demo run is either the demo of the system or a household laid for the
-- assistant benchmark (demo/bench.ts); only the first is "the demo".
ALTER TABLE "demo_run" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'demo';
