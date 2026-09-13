-- What the planner had to go around (§4.5, §14).
--
-- The travel estimate is the straight line times a per-mode factor,
-- which is a fair average over a road network and nonsense across a
-- lake: from the east shore of Lake Garda to Lago d'Idro is twenty
-- kilometres straight and seventy by road, because the way runs around
-- the north end.
--
-- The planner now asks the region database whether a named water body
-- lies on the line (geo's /water) and adds half its extent. The answer
-- is stored rather than recomputed on every read, for two reasons: the
-- read path serves every plan load and must not make an HTTP call per
-- day, and the plan was *built* on this assumption — recomputing it
-- later would let the card drift away from the day it describes.
ALTER TABLE trip_plan_days
  -- Extra metres the way round costs. Null means nobody looked;
  -- zero means somebody looked and there was nothing in the way.
  ADD COLUMN anchor_water_detour_m INTEGER,
  -- What is being gone around, for the sentence the app shows.
  ADD COLUMN anchor_water_around TEXT;
