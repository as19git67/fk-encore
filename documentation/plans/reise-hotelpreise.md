# Travel module (Reise), first feature: hotel price watches

## Goal

A module "Reise" next to Fotos, Dokumente, Finanzen and Zähler, with its
own role and permissions. Its first feature watches the price of a hotel
for fixed dates and guests and keeps the history of every check, so the
user sees how the price moves and when it falls below a limit.

## Decisions

- **Source:** SerpApi with `engine=google_hotels`. Google Hotels already
  merges the prices of many providers, including the hotel's own site.
  Amadeus Self-Service was shut down on 17 July 2026; Makcorps' terms
  are unclear; Xotelo may come later as a second source. SerpApi's free
  plan has 250 searches a month.
- **Key:** secret `SerpApiKey` (env `SERPAPI_API_KEY`). SerpApi reads the
  key only from the `api_key` URL parameter, never from a header.
  Without a key the page says so; watches can still be created.
- **Rates, not providers.** Free cancellation and breakfast stand on the
  rate (`featured_prices[].rooms[].rates[]`), so every rate is one offer.
  A provider without rooms (only in `prices`) counts as not cancellable
  and without breakfast. Prices include taxes; a resort or destination
  fee charged on site is not in them. A free-cancellation rate often
  costs clearly more than the cheapest one, so a limit that mixed them
  would raise false alarms: by default only
  free-cancellation rates count (`free_cancellation_only`).
- **Every watch ends.** `end_date` is required, at most two years after
  today (`MAX_END_YEARS`) and before the check-in. A watch past its end
  or its check-in keeps its history but is never checked again.
- **Budget:** the job counts the searches of the calendar month across
  all users (one key per deployment) and stops at
  `TRAVEL_SERPAPI_MONTHLY_SEARCHES` (default 250). A check costs one
  search once the hotel's `property_token` is known, two the first time
  (name search, then the hit).
- **Cadence:** the job `travel-hotel-watches` runs once a day at 06:00
  German time (Europe/Berlin, following daylight saving time) and checks
  every active watch not checked within the last 5 hours, so a "check
  now" shortly before does not cost a second search.

## Data model (migration 0296)

- `travel_hotel_watch`: owner, query, matched hotel name and token,
  check-in/out, adults, children's ages, currency, limit per night,
  `free_cancellation_only`, `breakfast_required`, `end_date`, `paused`,
  last check and error.
- `travel_hotel_check`: one row per check — searches used, number of
  rates, cheapest rate, cheapest cancellable, cancellable with breakfast,
  the cheapest that meets the watch's conditions and its provider,
  `below_limit`, error.
- `travel_hotel_offer`: every rate a check saw.

## Code

- `travel/hotel-offers.ts` — reading SerpApi's answer (pure).
- `travel/serpapi-client.ts` — the client, `setHotelSearchClient` for tests.
- `travel/hotel-watch.service.ts` — criteria, CRUD, one check, the job.
- `travel/hotel-watch.ts` — endpoints under `/travel/…` and the schedule.
- Web: Reise › Hotelpreise (`TravelHotelWatchesView.vue`, dialog
  `components/travel/HotelWatchDialog.vue`), laid out like the history on
  the KI-Benchmark page.
- Role "Reise User" with `module.travel`, `travel.view`, `travel.manage`.

## Stages

1. **Watch one hotel, write the history** — done.
2. **Notify** when a check falls below the limit for the first time, or
   to a new low clearly below the last notice (push and mail, via
   `push/`).
3. **From the itinerary:** "watch this stay's hotel" on a stay of the
   trip planner, dates and guests taken over.
4. **Area watches:** any hotel in an area with minimum stars and rating,
   optional radius around a point; one search covers all hotels of the
   area, so several watched hotels of one city could share it.
5. **Price chart** on the page and a tool for the assistant.
