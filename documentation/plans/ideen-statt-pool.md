# Ideas instead of a pool: an empty list, your own picks, one day band

Status: in progress. Decided with Anton on 2026-11-08. Stage 1 built.

## The problem

A stay's candidate list is filled by the app. `planLeg`
(`trip-planner/plans.ts`) searches the region around the anchor twice
(nearest, then prominent, `search-reach.ts`), scores what it finds
(`candidates.ts`), lets the local model order it
(`curation-job.ts`) and plans the first days out of it (`solver.ts`).
What is left over is the pool. For a city that is 150 candidates and
more, and the person planning has to find the ten that matter to them
in a list the app chose.

That is the wrong way round. When someone asks a search engine or an AI
"what to see in Musterstadt", they get the ten highlights and pick from
those. Nobody wants to thin a list of 150; everybody wants to build a
list of ten. The planner must stop guessing what interests the user and
start helping them order what they put in themselves.

Three more things follow from how the planner is used in practice
(Anton, 2026-11-08):

- **The day is planned closely.** Who plans a day wants to know how much
  time the day has and how much of it is already spoken for, including
  the ways between stops, and wants to see that as a picture, not as a
  number per block.
- **Fixed points come first.** A ticket for 14:00, opening hours, the
  light at a photo stop: these decide where a stop goes. Everything
  else is arranged around them.
- **No morning, midday, afternoon.** The four blocks of §4.1
  (`documentation/ios-urlaubsplanung.md`) sort stops into drawers the
  day does not have. A café, lunch or a snack is picked on the spot out
  of a pool of good suggestions, not planned into a "Mittag" drawer.

The group vote (§6.1, candidate ranking stage 5) has not been used: the
household plans together in front of one screen. It is not removed, it
is switched off until someone asks for it.

## What stays as it is

- **The trip, its stays and journeys** (`reiseverlauf.md`), fixpoints
  (§4.4, `fixpoints.ts`, booked visits in `frame-spots.ts`), day trips,
  day ends at a station (`day-ends.ts`), the ship's "Alle an Bord"
  (`aboard.ts`), splits, re-planning when the day runs differently.
- **How a place enters a trip.** `POST /plans/:planId/finds`
  (`add-find.ts`) chooses the stay by location, merges duplicates within
  120 m, matches an OpenStreetMap entry or keeps a `manual:` reference.
  The share extension (`ios/F4milShare/`, `share.ts`, `map-link.ts`)
  already reads Apple Maps and Google Maps links, short links included,
  and offers trips and idea collections. The idea pool
  (`ideenvorrat.md`) stays the collection without a trip; "Aus den Ideen
  übernehmen" stays its way into a trip.
- **What the candidate ranking built** (`kandidaten-ranking.md`):
  prominence from open data, the picture, the description. They move
  from ordering a list the app made to describing a hit in a list the
  user reads. Nothing of it is thrown away.
- **Light as a first-class input** (§7.3): `photo_stop`, `sun.ts`,
  `light-order.ts`. It becomes one of the three constraints the ordering
  honours.

## What changes in the concept

Guiding decision 1 of §2, "coarse time blocks instead of clock times",
is softened. A day keeps no fixed drawers; it is one window from the
day's start to its end, cut only by fixpoints. The order of the stops
within the window gets **estimated clock times**, shown as "ca. 10:40",
derived from dwell and the ways between stops the same way
`TripDayTimeline` already derives "where would we be at this hour". The
lower bound of precision stays where §4.1 set it: better an estimate
that says so than a timetable that does not hold. The block model in the
data (`trip_plan_blocks`, `day-shape.ts`) stays, with one spots block
per day as the default; a day shape with several blocks is still
allowed for the cases §4.1 named (arrival days, a train binding), but it
is no longer the way to say "lunch".

§5 "the pool with an order" stays true of what the user put in; it is no
longer true of what the region search found. The region search becomes
a **search with a hit list**, and the model's ordering (`curation-job.ts`)
becomes the order of that hit list, computed when the user asks for
"Highlights", not in the background for a pool nobody reads.

## The rule

1. **A stay starts with an empty list.** `planLeg` fills nothing. The
   days have their frame (start, end, fixpoints, the ship's hours) and
   no stops. Existing trips keep their pool; nothing is deleted.
2. **A place becomes an idea of the trip only by a deliberate act:**
   "Zur Reise" on a search hit, a shared link, an article's place, a
   place taken from the idea collection, or the place the user is
   standing at. The pool table is where ideas of a trip live
   (`trip_plan_pool`, `origin = manual`); the word in the app is
   **Ideen** for the trip's own list, and **Treffer** for what a search
   returned and nobody has taken yet.
3. **Every idea has a priority:** Muss (must), Will (want, the default),
   Wenn Zeit ist (if time allows). It replaces the vote in the score.
4. **Three constraints outrank priority:** a ticket time (the booked
   visit of §4.4), opening hours (new, from OpenStreetMap), and light at
   a photo stop (§7.3). A ticket is absolute, opening hours are a window
   the stop must fall into, light is a window the stop should fall into.
5. **The app orders, it does not choose.** "Reihenfolge vorschlagen" takes
   the ideas the user placed on a day and returns the best order under
   the constraints and the ways between them. It drops nothing. If the
   day does not hold them, it says by how much and which "Wenn Zeit
   ist" ideas would make it fit; the user removes them.
6. **The day shows its time.** Available minutes, planned minutes with
   the ways, free minutes, as one band from the day's start to its end.
7. **Food is a pool of its own and is never ordered into the day.**
   Restaurants and cafés among the ideas are listed under "Essen &
   Trinken". A day may carry a **break** ("Mittag", "Kaffee") with a
   duration and no venue; on the spot, "Essen in der Nähe" (`food.ts`)
   lists the food ideas within walking distance first, then the rest.

### Where an idea belongs (the question of 2026-11-08)

A trip has several stays; an idea taken from a shared link does not
say which stay it is for. Today `add-find.ts` chooses the stay by
location (the nearest anchor within 150 km, `finds.ts`), and that rule
stays: **ideas belong to the stay their place lies in.** The app shows
the trip's ideas as one list grouped by stay, so there is one place to
look, and the stay's day planning offers only the ideas of that stay.
An idea whose place is more than 150 km from every stay is refused
with the distance named, as today.

## Data model

Migration 0301 or later; every new column has a default so that
existing trips read as before.

- `trip_plan_pool.priority` text `must | want | maybe`, default `want`.
  The score of an idea becomes priority plus the manual bonus
  (`MANUAL_SCORE`); `search_score`, `curated_score` and
  `curated_reason` stay for existing pools and for the hit list.
- `trip_plan_pool.opening_hours` text, the raw OpenStreetMap string, as
  the search already returns it (`search.ts`, `SearchedPlace`).
- `trip_plan_stops.kind` text `stop | break`, default `stop`; a break
  has a label, a dwell and no `osm_ref`.
- `trip_plan_stops.eta_minutes` integer, nullable: the estimated start
  within the day the ordering computed, for display and for "where are
  we now".
- `trip_plans.constraints.voting` boolean, default `false`: the vote ring,
  fairness and "Damit neu planen" appear only when it is on.
- Default day shape: one block `Tag` of kind `spots`, budget = the day's
  window. `DEFAULT_DAY` in `blocks.ts` changes to this; a stored shape
  stays as it is.

## Stages

Each stage is one pull request, mergeable on its own, with tests. The
test data is synthetic (Musterstadt, Beispielplatz); no real trip of
the household appears in tests or stories.

### Stage 1: the empty list

Built (2026-11-08). As built:

- A trip is a trip of ideas when `constraints.ideas` is true
  (`trip-planner/ideas-mode.ts`). `createTripPlan` sets it unless the
  request says `startEmpty: false`; trips from before carry no flag and
  keep their searched pool and solved days. The test suite builds most
  trips the earlier way (`TRIP_START_EMPTY=0` in `vitest.config.ts`),
  because those trips still exist; `ideas-start.test.ts` covers the new
  one.
- On a trip of ideas `planLeg` searches nothing, and every day is a
  detailed frame with no stops (not `detailed=false`): a day takes
  stops from the start, so placing an idea needs no "plan this day"
  first. `POST …/days/detail` only opens a day that is not open yet
  (a buffer day) and puts nothing in it.
- A re-plan (a setting, a fixpoint, a change in the itinerary) frames
  the days again and puts every planned stop back on the day with the
  same index, in the block with the same id where there is one
  (`carry-stops.ts`); a stop whose day no longer exists goes back to
  the stay's ideas as a manual entry. `mergedConstraints` keeps every
  stored key, so changing the pace does not turn a trip of ideas back
  into a searched one.
- The day-trip suggestion is off on a trip of ideas (its days are empty
  because nobody has added anything yet). The curation is only marked
  due when a re-plan writes search rows.
- iOS: on a trip of ideas the stay sheet says "Ideen (n)" and the list
  is titled "Ideen", with an empty state that names the ways in.

- `planLeg` no longer calls the region search for the pool and no
  longer solves days. It writes the frame of every day (today's
  `detailed=false` shape) and an empty pool. `POST /plans/:planId/days/detail`
  orders what is on the day instead of filling it (stage 3 makes that
  real; until then it is a no-op that returns the day).
- `thin-pool.ts` and the day-trip suggestion that depends on an empty
  pool are disabled for stays without a search-filled pool; a stay with
  an existing pool keeps them.
- The curation cron (`trip-planner-curation`) stops marking new pools
  due (there are none); `curation.ts` stays for stage 2.
- iOS: the stay sheet's "Vorrat" becomes "Ideen (n)", with an empty
  state that names the ways in: Suchen, Highlights, Teilen aus Karten,
  Aus den Ideen übernehmen.
- Tests: `plans-*.test.ts` that assert auto-filled days are rewritten to
  assert frames only; a trip created in a test has no stops until a
  find is added.

### Stage 2: search with a hit list

- `POST /plans/:planId/highlights` with `legId`: the two searches of
  `search-reach.ts` over the stay's disc, scored by prominence
  (`prominence.ts`), ordered by the local model through
  `buildCurationPrompt`/`gateCuration` when the model is available and
  by prominence alone when it is not, the first 15 returned with picture
  and description from `trip_spot_fame`, the curated reason as the one
  line under the name, `inPool`/`planned` flags as in `search.ts`.
  "Mehr" pages on. Nothing is written.
- `POST /plans/:planId/search` keeps the name search; it gains a
  `category` filter (museum, viewpoint, church, park, market, …) over
  the same disc, so "alle Aussichtspunkte" is one tap.
- Every hit has "Zur Reise" which calls `POST /plans/:planId/finds`
  with the priority chosen in the same sheet (default Will).
- iOS: `TripPlaceSearchView` gets three segments: Highlights, Suche,
  Kategorien. A hit shows picture, name, category, one line of reason or
  description, distance to the lodging, and "Zur Reise" or "In der
  Reise" when already taken. The share extension's review
  (`TripShareReviewView`) offers the same priority choice.
- Tests: highlights endpoint with a fake fame client and a fake curation
  asker (the fixtures of `curation-job.test.ts`), category search,
  `inPool` flags.

### Stage 3: priority and constraints

- `priority` on `POST /finds`, `PATCH` on the pool row (`idea-edit.ts`
  pattern), shown as a chip on the idea row and switchable from the
  row's menu and the detail view (one source of actions,
  `candidateActions`).
- Opening hours: a parser for the common OpenStreetMap `opening_hours`
  forms (weekday ranges, hour ranges, `off`, `PH`, `24/7`) into windows
  per date, in `trip-planner/opening-hours.ts`. Forms it does not
  understand yield no window and a hint "Öffnungszeiten unklar", never a
  guess. The string is stored on the pool row when the place is taken
  and refreshed when the region database is re-read.
- A ticket stays a fixpoint with `spotRef` (`frame-spots.ts`); the idea
  row shows it as "Ticket 14:00".
- Light stays `photo_stop` with the windows of `sun.ts`; the idea row
  shows "Licht 17:10–18:40" on a dated trip.
- Tests: parser table (string → windows for a given date, including
  "closed on Mondays" and a holiday), priority in the score, chips in
  the pool read.

### Stage 4: ordering, and the day as one window

- `DEFAULT_DAY` becomes one spots block over the day's window;
  `scheduleDay` (`fixpoints.ts`) keeps cutting it around fixpoints.
- `POST /plans/:planId/days/:dayIndex/order` ("Reihenfolge vorschlagen"):
  input is the stops already on the day (placed from the ideas via
  `placeFromPool`, breaks included), output is their order with
  `eta_minutes`. Hard: fixpoints, booked visits, opening windows; soft:
  light windows, then total way. Exact for up to 9 stops (the
  `bestRoute` of `solver.ts` extended with time windows), a heuristic
  above. Nothing is dropped; the response carries `overrunMinutes` and
  `toDrop`: the "Wenn Zeit ist" ideas, then the "Will" ideas, whose
  removal would make the day fit, smallest set first.
- `placeFromPool` loses the block choice when the day has one block; a
  break is added with `POST …/days/:dayIndex/breaks` (label, minutes).
- `redistribute.ts` (the day runs late) re-orders the rest with the same
  endpoint from "now".
- `GET /plans/:planId` gives every day `window`, `plannedMinutes`
  (dwell plus ways plus breaks), `freeMinutes`, and each stop its
  `eta_minutes`.
- iOS: `TripPlanDayView` shows the stops of the day as one list with
  the estimated time at each, the way between them, and "Reihenfolge
  vorschlagen" at the top; over budget shows the overrun in the
  summary and marks the `toDrop` ideas with "zurück zu den Ideen?".
- Tests: `solver.test.ts` cases for windows (a ticket in the middle, a
  museum closed in the morning, a photo stop in the evening), overrun
  reporting, breaks staying where they were put.

### Stage 5: the day band

- A new view `TripDayBand` (iOS) draws the day as one horizontal band
  from the day's start to its end: fixpoints as pins with their time,
  stops as filled segments with the picture of the place, the ways as
  thin connectors, breaks as hatched segments, free time as empty band,
  the light windows of photo stops as a soft tint, and a cursor "jetzt"
  on the running day (`running-day.ts`). Below it the sentence "4 h 30
  von 9 h verplant, 1 h 10 unterwegs". Tapping a segment selects the
  stop in the list; dragging a stop in the list re-orders and updates
  the band without asking the server; "Reihenfolge vorschlagen" is the
  only server call.
- The band is the day's header on `TripPlanDayView` and the day's card
  on the stay's overview, so the stay shows at a glance which days are
  full and which are empty.
- A Storybook equivalent does not exist for iOS; the band gets an
  `#Preview` with the synthetic day of the tests and a screenshot test
  in `TripPoolMapTests`' fashion for the arithmetic (segment widths add
  up to the window).

### Stage 6: food as its own pool

- Ideas whose category is a restaurant or café (`MEAL_CATEGORIES` in
  `move.ts`) are listed under "Essen & Trinken" on the ideas screen and
  are never offered to "Reihenfolge vorschlagen"; they can still be
  placed on a day by hand (a reserved table is a ticket, see stage 3).
- `POST /trip-planner/food` takes `planId` and returns the trip's food
  ideas within the radius first, marked "eure Idee", then the
  OpenStreetMap list sorted by distance as today.
- The break of stage 4 gets "Jetzt aussuchen" which opens that list from
  the current location; choosing an entry does not move it onto the
  day, it opens the map app (§10.3: the planner does not pick a
  restaurant).
- Tests: food ideas excluded from ordering, food endpoint merges and
  marks ideas.

### Stage 7: the vote behind a switch

- `constraints.voting` (default off). When off: no vote ring, no
  fairness, no "Damit neu planen", no voter names, `applyVotes` is not
  called. When on: as built in candidate ranking stage 5. Tables and
  endpoints stay.
- Trip settings get the switch under "Planen mit".
- Documentation: §6.1 and §25.3 of `ios-urlaubsplanung.md` get a note;
  `kandidaten-ranking.md` gets a "Superseded" note at stage 3 (the
  background curation) and stage 5 (the vote is optional); §2 guiding
  decision 1 and §4.1 get the softening of this plan; the handbook's
  trip chapter is rewritten for Ideen, Treffer, Reihenfolge, Band.

## What is deliberately not built

- **No automatic day.** The app never fills a day on its own, not even
  when the list has ten "Muss" ideas and three days. Suggesting which
  day an idea fits (nearest to the others, most free time) is a later
  idea; it must still be the user who places it.
- **No rating service, no web search.** As in `kandidaten-ranking.md`:
  the hit list orders by open data and the local model's reading of it.
- **No minute timetable.** Estimated times come from dwell and the ways;
  a public-transit ride is estimated as §4.1 says. A GTFS feed, where
  there is one, refines, never conditions.
- **No parsing of exotic opening hours.** What the parser does not
  understand is shown as unclear; a window the app invented would be
  worse than none.
