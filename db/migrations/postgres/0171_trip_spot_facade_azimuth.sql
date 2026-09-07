-- Which way a spot faces (§7.3).
--
-- The import computes the facade azimuth once per outline
-- (`geo/src/facade-azimuth.ts`) because `osm_pois` otherwise keeps only
-- a centroid and the polygon is gone. Carrying it onto the planned stop
-- and the pool entry finishes that chain: the light hint is then a
-- comparison of two angles against a row the planner already has, with
-- no lookup back into the region database — which matters, because a
-- day has a dozen stops and the answer is wanted while somebody is
-- looking at the screen.
--
-- Degrees clockwise from north in [0, 180), exactly as the column it
-- comes from: a wall running east-west faces either north or south, and
-- an outline cannot say which. Null for every POI mapped as a node,
-- which is most of them.
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS facade_azimuth real;
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS facade_azimuth real;
