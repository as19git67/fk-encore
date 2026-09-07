-- The forecast, kept per place and day (§7.2).
--
-- "Ein Abruf pro Tag reicht": a city forecast does not change between
-- two people opening the same trip, and asking again for every screen
-- would be rude to a service that asks for neither a key nor a fee.
--
-- The coordinate stored here is the **rounded** one — about five
-- kilometres, the grid `weather-client.ts` snaps to before anything
-- leaves the house. That is what makes the cache useful: everybody in
-- the same city asks the same question. It is also the whole of what
-- was ever sent, so this table cannot become a movement profile even
-- if somebody reads it.
CREATE TABLE IF NOT EXISTS weather_forecast_cache (
  id serial PRIMARY KEY,
  lat real NOT NULL,
  lon real NOT NULL,
  day date NOT NULL,
  -- The hours as the API delivered them, already parsed into the
  -- planner's shape. Stored whole rather than as classes: the
  -- thresholds in weather.ts will be argued about, and re-deriving
  -- them from kept numbers beats re-fetching a past forecast.
  hours jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS weather_forecast_cache_place_day_key
  ON weather_forecast_cache (lat, lon, day);

-- For the sweep that drops what nobody will ask for again.
CREATE INDEX IF NOT EXISTS weather_forecast_cache_day_idx
  ON weather_forecast_cache (day);
