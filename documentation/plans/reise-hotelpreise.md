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
  all users and the flight watches too (one key per deployment,
  `travel/search-budget.ts`, see `reise-flugpreise.md`) and stops at
  `TRAVEL_SERPAPI_MONTHLY_SEARCHES` (default 250). A check costs one
  search once the hotel's `property_token` is known, two the first time
  (name search, then the hit).
- **Cadence:** the job `travel-hotel-watches` runs once a day at 06:00
  German time (Europe/Berlin, following daylight saving time) and checks
  every active watch not checked within the last 5 hours, so a "check
  now" shortly before does not cost a second search.

## Reports (stage 2)

- **Rule** (`alertDecision` in `travel/hotel-alerts.ts`): the daily job
  reports a watch when its matching price is below the limit and nothing
  was reported since the price last stood at or above the limit, or the
  price undercuts the last report (a new low). A price at or above the
  limit, or no matching offer, clears `notified_per_night`, so the next
  drop is reported again. Changing the hotel, dates, guests, currency,
  limit or conditions clears it too. "Check now" never reports: the user
  is looking at the result.
- **Ways:** per watch `notify_push` and `notify_email`, both on by
  default. Push goes through `push.notifyHotelPrice` (browser and iOS,
  kind `hotel_price` in the user's notification settings); the mail
  through the app's SMTP account to the user's address, with a button to
  the offer and one to the watch. A report counts as made once it is
  tried, so a mail server that is down does not become a mail every
  morning.
- **Unknown cancellation:** a provider that Google lists only with a
  price (no rooms, no rates) gets `free_cancellation = null` and is shown
  as "unbekannt" with its link. It never meets "free cancellation only";
  migration 0297 moved the stored room-less offers from `false` to `null`.
- **Links that still open later:** most provider links SerpApi hands over
  are Google click redirects (`google.com/aclk`, `google.com/travel/clk`,
  `googleadservices.com`) bound to the session that rendered Google's page;
  opened later from the watch page or a mail they fail. `durableLink` in
  `travel/offer-links.ts` replaces them: the target the redirect carries,
  the hotel website for the hotel's own offer, a search with hotel, dates
  and party on Booking.com, Expedia or Hotels.com, otherwise the hotel's
  Google Hotels page from the property token. Applied before storing and,
  for checks stored before, when reading.

## Double rooms

Google Hotels has no parameter for the number of rooms: a search for four
adults only lists rates for one room that holds four. A watch with
`split_rooms` (only adults, an even number, at least four; `splitRoomCount`
in `travel/hotel-offers.ts`) makes a second search per check for two adults
with the hotel's token and books each rate `adults / 2` times (`asRooms`):
room "2 × Doppelzimmer", `per_night` and `total` for all rooms together,
`rooms = 2` on the offer. Both lists are merged, so the limit, the tiles
and the report compare the cheaper way to house the party. The
double-room search only adds offers: when it fails or the month's budget
has no search left, the check stands with the rooms for everyone. Google
shows the price of one room; whether that many are free is only seen at
the provider. A watch with it costs about 60 searches a month instead of
30.

## Area watches (stage 4)

A watch names a place instead of a hotel (`kind = 'area'`), optionally
narrowed by minimum stars (`min_stars`, 2–5) and Google's guest rating
(`min_rating`: 3.5, 4.0 or 4.5 on Google's 1–5 scale; Booking.com's "8+"
is about Google's 4.0+). A check costs up to three searches: Google's
result list for the place with `hotel_class`, `rating`, `free_cancellation`
and `sort_by` = lowest price, then the details of the `AREA_DETAILS` (2)
cheapest hits that meet the filter again on our side (the list carries
rentals and ads, and only the details name cancellation and breakfast).
Their rates count together; each offer and the check's matching price name
their hotel (`hotel`, `matching_hotel`), and so does the report. There is
no radius in kilometres: the area is what Google reads from the query.
Double rooms stay a feature of the single-hotel watch. Rules in
`travel/hotel-area.ts`.

## Flexible dates

With `flexible`, `check_in` and `check_out` are the earliest arrival and
the latest departure (at most 120 days apart) and a stay lasts
`min_nights` to `max_nights`. The watch ends before the last possible
arrival (latest departure minus the shortest stay); its end date must lie
before that day.

- **One hotel:** Google's price calendar
  (`engine=google_hotels_price_calendar`) gives the best one-night price
  for every arrival day in one search. A stay is estimated as the mean of
  its nights (`travel/hotel-calendar.ts`), the cheapest one is then read
  for real; a check costs two searches. The five cheapest estimates stay
  on the check (`stays`) and the page lists them as "Günstigste
  Zeiträume". If the calendar fails or has no prices, the stays take turns
  as for an area.
- **Area:** one stay per check, in turn (`rotationPick` over
  `stayCombinations` in `travel/flexible-dates.ts`, shared with the flight
  watch; `flex_rotation` keeps the index). All stays have their turn after
  as many days as there are stays.

Each check stores the stay it priced (`check_in`/`check_out` on the
check); the history shows it and a report names it.

## Data model (migrations 0296–0298, 0313)

- `travel_hotel_watch`: owner, query, matched hotel name and token,
  check-in/out, adults, children's ages, currency, limit per night,
  `free_cancellation_only`, `breakfast_required`, `split_rooms`, `end_date`, `paused`,
  `notify_push`, `notify_email`, `notified_per_night`/`notified_at`,
  last check and error; `kind`, `min_stars`, `min_rating`, `flexible`,
  `min_nights`, `max_nights`, `flex_rotation` (0313).
- `travel_hotel_check`: one row per check — searches used, number of
  rates, cheapest rate, cheapest cancellable, cancellable with breakfast,
  the cheapest that meets the watch's conditions and its provider,
  `below_limit`, error; the stay it priced, the hotel of the matching
  offer and the calendar's cheapest stays (0313).
- `travel_hotel_offer`: every rate a check saw, with its booking link;
  `free_cancellation` null when Google names no terms; `rooms` > 1 for a
  double room booked several times, prices for all rooms; `hotel` for an
  area watch (0313).

## Code

- `travel/hotel-offers.ts` — reading SerpApi's answer (pure).
- `travel/hotel-area.ts`, `travel/hotel-calendar.ts`,
  `travel/flexible-dates.ts` — area filter, price calendar, stays of a
  flexible period (pure).
- `travel/offer-links.ts` — links that still open later (pure).
- `travel/serpapi-client.ts` — the client, `setHotelSearchClient` for tests.
- `travel/hotel-watch.service.ts` — criteria, CRUD, one check, the job.
- `travel/hotel-alerts.ts` — when to report, the words, push and mail
  (`setAlertSender` for tests); mail text in `user/mail.ts`
  (`sendHotelPriceAlertEmail`).
- `travel/hotel-watch.ts` — endpoints under `/travel/…` and the schedule.
- Web: Reise › Hotelpreise (`TravelHotelWatchesView.vue`, dialog
  `components/travel/HotelWatchDialog.vue`), laid out like the history on
  the KI-Benchmark page.
- Role "Reise User" with `module.travel`, `travel.view`, `travel.manage`.

## Stages

1. **Watch one hotel, write the history** — done.
2. **Notify** — done. See "Reports" below.
3. **From the itinerary:** "watch this stay's hotel" on a stay of the
   trip planner, dates and guests taken over.
4. **Area watches** — done, with flexible dates for both kinds. See
   "Area watches" and "Flexible dates" above. Open: a radius around a
   point (the hits carry coordinates).
5. **Price chart** on the page and a tool for the assistant.
