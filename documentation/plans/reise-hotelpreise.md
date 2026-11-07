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

## Data model (migrations 0296, 0297)

- `travel_hotel_watch`: owner, query, matched hotel name and token,
  check-in/out, adults, children's ages, currency, limit per night,
  `free_cancellation_only`, `breakfast_required`, `end_date`, `paused`,
  `notify_push`, `notify_email`, `notified_per_night`/`notified_at`,
  last check and error.
- `travel_hotel_check`: one row per check — searches used, number of
  rates, cheapest rate, cheapest cancellable, cancellable with breakfast,
  the cheapest that meets the watch's conditions and its provider,
  `below_limit`, error.
- `travel_hotel_offer`: every rate a check saw, with its booking link;
  `free_cancellation` null when Google names no terms.

## Code

- `travel/hotel-offers.ts` — reading SerpApi's answer (pure).
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
4. **Area watches:** any hotel in an area with minimum stars and rating,
   optional radius around a point; one search covers all hotels of the
   area, so several watched hotels of one city could share it.
5. **Price chart** on the page and a tool for the assistant.
