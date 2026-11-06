-- A description per place where Wikipedia is thin (candidate ranking
-- plan, stage 4): the map's website tag, and what was found with its
-- source and when it was looked for.
ALTER TABLE trip_spot_fame ADD COLUMN IF NOT EXISTS website TEXT;
--> statement-breakpoint
ALTER TABLE trip_spot_fame ADD COLUMN IF NOT EXISTS description JSONB;
--> statement-breakpoint
ALTER TABLE trip_spot_fame ADD COLUMN IF NOT EXISTS described_at TIMESTAMPTZ;
