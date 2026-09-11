-- Migration 0193: home location of a household for the weather-adjusted
-- heating report (#1023 follow-up).
--
-- Heating degree days are fetched from the Open-Meteo archive for the
-- coordinate stored here. The coordinate is kept rounded to the ~5 km grid
-- (same rule as weather_forecast_cache): a city district is all the
-- reanalysis resolves anyway, and nothing more precise ever leaves the house.

CREATE TABLE IF NOT EXISTS meter_home_locations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Display name of the place as chosen from the search ("Musterstadt, Bayern").
  label TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  -- 'geocoded' (picked from the place search) or 'manual' (typed coordinates).
  source TEXT NOT NULL DEFAULT 'geocoded' CHECK (source IN ('geocoded', 'manual')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
