-- Trip planner: keep the hour a block begins.
--
-- `scheduleDay` already works out where every block sits on the day's notional
-- clock — that is how a fixpoint knows which block to cut (§4.4). Until now the
-- result was thrown away and only the budget kept, which is enough to plan a
-- day but not enough to *show* one: the time slider of §8.3 answers "where
-- would we be at this hour", and that question needs the hour each block
-- starts.
--
-- Nullable, because a plan written before this column has no frame time and
-- inventing one would put the traveller somewhere they were never planned to
-- be. The slider simply has nothing to show for those days, which is the
-- honest answer.

ALTER TABLE trip_plan_blocks
  ADD COLUMN IF NOT EXISTS start_minutes integer;
