-- A place somebody brought into a trip is a top pick, whichever way it
-- came in (documentation/plans/kandidaten-ranking.md, stage 0). New
-- finds enter at 10 (`MANUAL_SCORE` in trip-planner/candidates.ts);
-- this raises the ones already in a pool, which entered at 1 unless
-- they came out of the idea collection, so trips already planned see
-- the same order.
UPDATE trip_plan_pool
SET score = 10,
    reasons = CASE
      WHEN reasons @> '["von euch hinzugefügt"]'::jsonb THEN reasons
      ELSE '["von euch hinzugefügt"]'::jsonb
        || COALESCE((SELECT jsonb_agg(r) FROM jsonb_array_elements(reasons) r
                     WHERE r <> '"selbst hinzugefügt"'::jsonb), '[]'::jsonb)
    END
WHERE origin = 'manual' AND score < 10;
