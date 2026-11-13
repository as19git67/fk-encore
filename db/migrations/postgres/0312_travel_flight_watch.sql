-- Reise module: flight price watches (documentation/plans/reise-flugpreise.md).
-- A watch is a route with passengers and filters, either fixed dates or a
-- flexible window that the job walks one date combination per check.
CREATE TABLE IF NOT EXISTS travel_flight_watch (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  trip_type TEXT NOT NULL DEFAULT 'round',
  outbound_date DATE,
  return_date DATE,
  flexible BOOLEAN NOT NULL DEFAULT FALSE,
  date_from DATE,
  date_until DATE,
  min_nights INTEGER,
  max_nights INTEGER,
  flex_rotation INTEGER NOT NULL DEFAULT -1,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  infants_on_lap INTEGER NOT NULL DEFAULT 0,
  travel_class INTEGER NOT NULL DEFAULT 1,
  max_stops INTEGER,
  airlines TEXT,
  airlines_mode TEXT,
  outbound_times TEXT,
  return_times TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  limit_total DOUBLE PRECISION,
  end_date DATE NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  notify_push BOOLEAN NOT NULL DEFAULT TRUE,
  notify_email BOOLEAN NOT NULL DEFAULT TRUE,
  notified_price DOUBLE PRECISION,
  notified_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_flight_watch_trip_type_check CHECK (trip_type IN ('round', 'oneway'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_flight_watch_user_idx ON travel_flight_watch (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_flight_check (
  id BIGSERIAL PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES travel_flight_watch(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  searches INTEGER NOT NULL DEFAULT 0,
  outbound_date DATE NOT NULL,
  return_date DATE,
  flight_count INTEGER NOT NULL DEFAULT 0,
  lowest_price DOUBLE PRECISION,
  lowest_airlines TEXT,
  lowest_stops INTEGER,
  price_level TEXT,
  typical_low DOUBLE PRECISION,
  typical_high DOUBLE PRECISION,
  below_limit BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_flight_check_watch_idx ON travel_flight_check (watch_id, checked_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_flight_check_time_idx ON travel_flight_check (checked_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_flight_offer (
  id BIGSERIAL PRIMARY KEY,
  check_id BIGINT NOT NULL REFERENCES travel_flight_check(id) ON DELETE CASCADE,
  price DOUBLE PRECISION NOT NULL,
  airlines TEXT NOT NULL,
  flight_numbers TEXT NOT NULL DEFAULT '',
  departs_at TEXT,
  arrives_at TEXT,
  duration_min INTEGER,
  stops INTEGER NOT NULL DEFAULT 0,
  layovers TEXT NOT NULL DEFAULT '',
  best BOOLEAN NOT NULL DEFAULT FALSE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_flight_offer_check_idx ON travel_flight_offer (check_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_flight_booking (
  id BIGSERIAL PRIMARY KEY,
  check_id BIGINT NOT NULL REFERENCES travel_flight_check(id) ON DELETE CASCADE,
  book_with TEXT NOT NULL,
  price DOUBLE PRECISION,
  option_title TEXT,
  extensions TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_flight_booking_check_idx ON travel_flight_booking (check_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_flight_price_point (
  id BIGSERIAL PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES travel_flight_watch(id) ON DELETE CASCADE,
  combo TEXT NOT NULL,
  day DATE NOT NULL,
  price DOUBLE PRECISION NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS travel_flight_price_point_uniq ON travel_flight_price_point (watch_id, combo, day);
