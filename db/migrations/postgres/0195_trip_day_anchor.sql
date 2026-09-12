-- The day anchor (§4.5): a base and day trips out of it.
--
-- The leg's anchor assumes the quarters move with it — Tokyo, then
-- Osaka, then Hakata. One of the commonest holidays looks nothing like
-- that: four days in one Airbnb, and three of them fifty to eighty
-- kilometres away. That is *one* leg — the quarters never change, there
-- is no transfer day, the luggage stays put — and it could not be said
-- at all: the anchor belonged to the leg and every day inherited it.
--
-- Nullable throughout, and that is the point: no anchor means the leg's,
-- which is every ordinary day and every free day at the base. Nothing
-- about the existing arithmetic changes for them.
ALTER TABLE trip_plan_days
  ADD COLUMN anchor_lat DOUBLE PRECISION,
  ADD COLUMN anchor_lon DOUBLE PRECISION,
  -- What to call it on the day card. Free text: "Pisa" is what somebody
  -- says, whatever the geocoder called the point.
  ADD COLUMN anchor_label TEXT,
  -- How far to look around it. NULL falls back to the leg's radius,
  -- which itself follows the transport mode (`search-reach.ts`).
  ADD COLUMN anchor_radius_m INTEGER;
