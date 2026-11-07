-- Reise module, first feature: hotel price watches
-- (documentation/plans/reise-hotelpreise.md). A watch is one hotel with
-- fixed dates and guests; the travel job checks it until end_date and
-- writes one check row plus every rate it saw.
CREATE TABLE IF NOT EXISTS travel_hotel_watch (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  hotel_name TEXT,
  property_token TEXT,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  adults INTEGER NOT NULL,
  children_ages JSONB NOT NULL DEFAULT '[]'::jsonb,
  currency TEXT NOT NULL DEFAULT 'EUR',
  limit_per_night DOUBLE PRECISION,
  free_cancellation_only BOOLEAN NOT NULL DEFAULT TRUE,
  breakfast_required BOOLEAN NOT NULL DEFAULT FALSE,
  end_date DATE NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_hotel_watch_dates_check CHECK (check_out > check_in)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_hotel_watch_user_idx ON travel_hotel_watch (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_hotel_check (
  id BIGSERIAL PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES travel_hotel_watch(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  searches INTEGER NOT NULL DEFAULT 0,
  offer_count INTEGER NOT NULL DEFAULT 0,
  lowest_per_night DOUBLE PRECISION,
  lowest_free_per_night DOUBLE PRECISION,
  lowest_free_breakfast_per_night DOUBLE PRECISION,
  matching_per_night DOUBLE PRECISION,
  matching_source TEXT,
  below_limit BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_hotel_check_watch_idx ON travel_hotel_check (watch_id, checked_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_hotel_check_time_idx ON travel_hotel_check (checked_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS travel_hotel_offer (
  id BIGSERIAL PRIMARY KEY,
  check_id BIGINT NOT NULL REFERENCES travel_hotel_check(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  room TEXT NOT NULL,
  per_night DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION,
  free_cancellation BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_until TEXT,
  breakfast BOOLEAN NOT NULL DEFAULT FALSE,
  guests INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS travel_hotel_offer_check_idx ON travel_hotel_offer (check_id);
