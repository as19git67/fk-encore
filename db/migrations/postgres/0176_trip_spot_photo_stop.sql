-- "Fotostopp": the traveller says the light matters at *this* spot.
--
-- The planner routes by distance and always has (§4.1). Light is the
-- exception, and §7.3 asks for it to stay one — so instead of a bonus
-- that quietly reorders every plan, the sun only counts for spots
-- somebody marked. The flag belongs beside the note rather than on the
-- stop row for the same reason the note does: a stop row does not
-- survive a re-plan, and "we come here for the evening light" does.
ALTER TABLE trip_spot_notes
  ADD COLUMN IF NOT EXISTS photo_stop boolean NOT NULL DEFAULT false;
