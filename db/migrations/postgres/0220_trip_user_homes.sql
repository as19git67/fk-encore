-- Where a person lives, once (§22.7).
--
-- A trip's home (0217) is the far end of the way there and the way
-- home. Typing one's own town into every trip is the wrong kind of
-- repetition, so it is kept once per person and copied into each new
-- trip; a trip may still be given a home of its own.
CREATE TABLE trip_user_homes (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  label text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
