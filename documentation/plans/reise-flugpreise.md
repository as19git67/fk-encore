# Travel module (Reise): flight price watches

## Goal

Next to the hotel price watches (`reise-hotelpreise.md`), watch the price
of a flight: a route, passengers and filters, either for fixed dates or
for a window the traveller is flexible about — when to leave and how long
to stay. Keep the history of every check, show Google's own assessment
and price history from the first day, and report a price below the limit
by push and mail.

## Decisions

- **Source:** SerpApi with `engine=google_flights`, the same key
  (`SerpApiKey`, only as the `api_key` URL parameter) and the same monthly
  budget as the hotel watches. The budget is counted over both check
  tables (`travel/search-budget.ts`).
- **Criteria:** origin and destination as IATA codes, several per side
  ("FRA,HHN"); round trip or one way; adults, children, infants on lap
  (at most 9 travellers); class (economy … first); max stops (any, nonstop,
  1, 2); airlines or an alliance to include or exclude; departure hours for
  the outbound and the return flight; limit for the whole trip and all
  travellers; currency.
- **One search per check.** On a round trip Google lists the outbound
  flights, each with the price of the whole round trip, so one search gives
  the price. Return flights and booking options cost a search each and are
  only fetched when a price is reported (see Reports).
- **Google's insight from the first day.** Every answer carries
  `price_insights`: level (low/typical/high), the typical range and a price
  history of the last weeks for these dates. The level and range are kept
  on the check; the history per day in `travel_flight_price_point` (upsert
  per watch, date combination and day), so the page shows a curve after the
  first check.
- **No stored links.** Booking links in the answer are POSTs to Google's
  click redirect (`google.com/travel/clk/f`) and stop working. The watch
  links a Google Flights search built from its criteria
  (`googleFlightsLink`: `travel/flights?q=Flights to … from … on … through …`),
  which is an ordinary search page and stays valid. Nothing link-like from
  the answer is written to the database.
- **Every watch ends.** `end_date` is required, at most two years ahead and
  before the last possible outbound flight. A watch past its end or its
  last departure keeps its history and is not checked again.
- **Cadence:** the job `travel-flight-watches` runs daily at 06:15 German
  time, a quarter of an hour after the hotels, and checks every running
  watch not checked within the last five hours.

## Flexible dates

An option for travellers who are flexible about when and for how long.
Searching every possible pair of dates every day would spend the month's
budget within days, so:

- A flexible watch names a window — earliest outbound and latest return
  (one way: latest outbound) — and a range of nights. Every pair that fits
  is one combination (`stayCombinations` in `travel/flexible-dates.ts`,
  shared with the hotel watches). At most 120 combinations
  (`MAX_COMBINATIONS`) and a window of at most 180 days.
- The job checks **one combination per day**, in turn
  (`rotationPick`, column `flex_rotation` = index checked last). A flexible
  watch costs exactly as many searches as a fixed one; one round through
  all combinations takes as many days as there are combinations. The page
  says so in the dialog.
- The price of a combination is what its last check found. The watch's
  **best price** is the cheapest of the latest checks of the combinations
  still ahead (`bestOf`); the limit and the report compare that, so the
  rotation through dearer dates does not clear a report and repeat it the
  next day.
- Changing the window starts the rotation over.
- Not used: SerpApi's Google Travel Explore engine (`month`,
  `travel_duration`) only knows a weekend, one or two weeks and the next six
  months, and its answer for a fixed destination is one date pair; it may
  later seed the order of the rotation.

## Reports

- The rule is the hotel watch's (`alertDecision`): report when the best
  price falls below the limit, again only for a new low, and again after
  the price stood at or above the limit. Changing any criterion clears the
  last report. "Check now" never reports.
- When a report goes out and the reported price is the flight of this
  check, the check spends up to two more searches on who sells it: on a
  round trip the return flights of the cheapest outbound flight
  (`departure_token`), then the booking options of the cheapest return
  (`booking_token`); one way only the latter. The options (seller, price,
  fare, conditions) are kept in `travel_flight_booking` and named in the
  report. Without budget for them the report goes out without sellers.
- Push via `push.notifyFlightPrice` (kind `flight_price`), mail via
  `sendFlightPriceAlertEmail` with a button to the Google Flights search and
  one to the watch.

## Data model (migration 0312)

- `travel_flight_watch`: owner, route, trip type, fixed dates or window
  and nights, `flex_rotation`, passengers, class, stops, airlines and mode,
  departure hours, currency, `limit_total`, end, pause, ways to report,
  `notified_price`/`notified_at`, last check and error.
- `travel_flight_check`: one row per check — the dates searched, searches
  used, number of flights, cheapest price with airlines and stops, Google's
  level and typical range, `below_limit`, error.
- `travel_flight_offer`: the 20 cheapest flights of a check (no links).
- `travel_flight_booking`: sellers of the reported flight.
- `travel_flight_price_point`: Google's price history per date combination
  and day.

## Code

- `travel/flight-offers.ts` — reading the answer, booking options, the
  Google Flights link (pure).
- `travel/flight-search-client.ts` — the client, `setFlightSearchClient`.
- `travel/flexible-dates.ts` — combinations and rotation (shared).
- `travel/search-budget.ts` — searches this month over hotels and flights.
- `travel/flight-watch.service.ts` — criteria, CRUD, one check, the job.
- `travel/flight-alerts.ts` — the words, push and mail.
- `travel/flight-watch.ts` — endpoints under `/travel/flight-watches` and
  the schedule. Key and budget for the page come from
  `/travel/hotel-search-status`.
- Web: Reise › Flugpreise (`TravelFlightWatchesView.vue`, dialog
  `components/travel/FlightWatchDialog.vue`).

## Open

- Check against the first real answers that Google's price is for all
  travellers (the docs and the web page say so) and that the history's
  timestamps are seconds.
- From the itinerary: "watch the flight" on a journey of the trip planner.
- Price chart across checks (stage 5 of the hotel plan) and a tool for the
  assistant.
