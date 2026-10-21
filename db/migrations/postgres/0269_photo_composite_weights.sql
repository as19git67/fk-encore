-- Weights of the overall quality score for photos with a Q-Align value
-- (documentation/plans/foto-aesthetik.md). NULL keeps the original formula.
ALTER TABLE "photo_aesthetic_settings" ADD COLUMN IF NOT EXISTS "composite" jsonb;
