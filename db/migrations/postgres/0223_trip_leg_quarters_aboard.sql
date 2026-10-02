-- The quarters travel along (§21.3, 2026-10-02).
--
-- On a cruise the lodging is the same for three weeks and somewhere
-- else every morning. A port day is an ordinary leg whose anchor is
-- the pier; what sets it apart is that leaving it means being back
-- aboard, not catching a train. The departure a journey puts on such a
-- day reads "Alle an Bord" and keeps an hour rather than twenty
-- minutes — a missed ship costs the trip, not an hour. A tender port
-- adds the boat ride back on top.
ALTER TABLE trip_plan_legs ADD COLUMN quarters_aboard boolean NOT NULL DEFAULT false;
ALTER TABLE trip_plan_legs ADD COLUMN tender_port boolean NOT NULL DEFAULT false;
