-- A fixpoint that is the frame of a block (§7.3).
--
-- "Als Abendtermin einplanen" used to write an ordinary appointment:
-- a label and an hour beside the blocks, while the spot itself stayed
-- in the pool or in an afternoon block. The traveller then watched two
-- places for one outing — and the pool, not knowing, could plan the
-- same terrace a second time in the wrong light.
--
-- Now the fixpoint may say which block it frames and which spot that
-- block is for. The scheduler places that block at the fixpoint's hour
-- with its length, and the planner puts the spot into it as a pinned
-- stop on every plan and re-plan. One place: the block.
ALTER TABLE trip_plan_fixpoints
  -- Template id of the block this fixpoint frames ("evening"), or
  -- null for an ordinary appointment or departure.
  ADD COLUMN block_id TEXT,
  -- The OSM reference of the spot the framed block is planned around.
  ADD COLUMN spot_ref TEXT;
