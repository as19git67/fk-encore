# Vacation Planning ("Spots & Blocks") – Concept

As of: 2026-09-09 · Status: collection of ideas / rough draft (guiding decisions
set in §2, everything else open) — steps 1–9 are fully or partly built; what
is listed under "Implemented" in §13 exists in the code, everything else is a draft.

## 0. Glossary: the app's words

One term per thing, the same in every label. The "replaces" column names what
used to stand in the same place; the code names (`pool`, `leg`, `fixpoint`,
`anchor`) stay, the UI does not.

| Thing | Word in the app | replaces |
|---|---|---|
| The photo mode that collects pictures into an album | **Trip** (trip), Trip-Album | Reise-Album |
| The planned travel object | **Reise** (trip) | Urlaub, Plan |
| The trip-independent collection of saved places | **Ideen** (ideas) | Ideenvorrat, Vorrat, Mein Vorrat |
| The places the planner picks from for a city | **Kandidaten** (candidates) | Vorrat |
| A place, not yet scheduled anywhere | **Ort** (place) | Idee, Fund, Spot, Kandidat, Pin |
| A place in a block of a day | **Stopp** (stop) | Spot; "Fotostopp" remains as a property |
| A place whose way is the goal (`extent`, §4.7) | **Strecke** (route) | Aktivität, Tour, Route |
| A city or station of the trip (`leg`) | **Stadt** (city) | Etappe |
| A hard time of day (`fixpoint`) | **Feste Zeit** (fixed time) | Fixpunkt |
| Where each day begins and ends (`leg.anchor`) | **Unterkunft** (accommodation) | Start & Ziel, Anker |
| The destination of a day trip (`day.anchor`) | **Ausflugsziel** (excursion destination) | Ausflug |
| The group splits up for a block | **Gruppe trennen** / **wieder zusammen** (split group / back together) | Zweig, Split, Trennen |
| Who may co-plan the trip | **Planen mit** (plan with) | Wer plant mit |
| Who is travelling along (age, pace) | **Reisegruppe** (travel party) | Wer fährt mit?, Mitreisende |
| Confirm | **Sichern** (secure/save) | Speichern, Hinzufügen, Trennen |
| Discard | **Abbrechen** (cancel) | Lassen |

## 1. The idea in one sentence

The user says in natural language what they have planned — *"ich bin vier Tage in
Lissabon"* (I'm in Lisbon for four days), *"wir fahren von München nach Bozen und
haben zwei Tage Zeit"* (we're driving from Munich to Bolzano and have two days) —
and in return gets, per day, **coarse time blocks with two to four spots each**
(sight, museum, café, viewpoint) in a sensible order:
*"Morning: A → B → C, afternoon: D → E"*. If the day goes differently than
expected, the rest is redistributed in seconds.

## 2. Four guiding decisions

These four shape everything else and are therefore stated up front:

1. **Coarse time blocks instead of clock times.** The plan says "morning: A, B, C",
   not "9:47 from stop X". Everything else follows from this — in particular,
   the need for exact timetable data goes away.
2. **Re-planning is the normal case, not the exception.** A plan is not a
   script to be worked through, but a pool with an order. The system must be
   able at any time to handle "we're still at B and it's already 2 pm" without
   the user having to re-plan.
3. **One's own photo history is a nice extra, not a pillar.** Having been at the
   same place before is the exception. Where it happens to apply, it is a nice
   note ("you were here in 2019") — but it must neither carry the ranking nor
   be a prerequisite for a usable plan. For the first visit, i.e. the normal
   case, the system must work completely without any history.
4. **Location, weather and light are first-class inputs.** The app knows the
   location and uses it actively. Precipitation controls *what* is planned;
   sun position and cloud cover control *when* — because fk-encore plans not
   just visits, but good photos (§7).

## 3. Why this does not become a Google Maps clone

Google Maps is unbeatable on **live data** (traffic, real-time public transit,
current opening hours, ratings, interior photos). Rebuilding that layer would be
pointless. The difference lies elsewhere: **Google Maps optimizes a route that
has already been chosen. It does not answer the question of what fits into an
afternoon at all — and certainly not what drops out when you fall behind.**
That is exactly the gap.

### 3.1 The core: what fits into half a day?
The actual planning question is not "how do I get from A to B", but
"I have twelve candidates and one afternoon — which four of them work out
without it becoming stressful?". Google Maps cannot answer that; it can only
lay an already made selection into a route. This fitting to a time budget is
the core of the feature.

### 3.2 Re-planning without re-planning from scratch
The museum visit takes twice as long, it rains, the child is tired, the
restaurant is closed. A button **"wir sind hier, es ist jetzt"** (we are here, it
is now) recalculates the rest of the day: what no longer fits does not go into
the trash, but into the pool for tomorrow. Google Maps has no concept for
this — there you delete waypoints by hand.

### 3.3 The right spot at the right time of day
Because fk-encore is a photo app, the Trip Planner plans not just visits but
good photos: sun position, facade orientation and cloud cover yield a light
window per spot, which determines the order within the block and can suggest
an evening appointment (§7.3). Google Maps knows opening hours — but not
that the viewing terrace is only worth it from half past seven.

### 3.4 Documents as fixpoints
The documents service already has OCR, classification and semantic search.
Hotel confirmation, train ticket, rental car contract, museum/city pass are
therefore **already in the house and machine-readable**. The plan is built
around real fixpoints: hotel address as day start and end, check-in time,
return date of the rental car, booked time slot for the Sagrada Família. Google
structurally cannot do that without you opening your mailbox.

**Implemented:** `GET`/`POST /trip-planner/plans/:planId/documents`,
`GET …/documents/suggestions`, `POST …/documents/remove` and the "Dokumente"
(documents) screen in the trip menu. Four decisions are baked into it:

- **Suggested, never adopted.** §8.2 is unambiguous: "Nothing is silently
  assumed." A document is offered, together with the reason it is offered
  for — it mentions one of the travel dates, it mentions one of the places, or
  its own date falls within the travel period. It must always be a travel
  paper: a mobile phone bill from the vacation week mentions the date too, and
  whoever has seen it in the list once stops reading the list.
- **A reading is not a fixpoint.** `doc-hints.ts` reads hard times from the
  OCR text ("Check-in ab 15:00", "Abfahrt 17:45") and returns them with **the
  line they come from**. Nothing is created from them: OCR confuses a 7 with a
  1 often enough, and a machine-written departure would be exactly the error
  that, according to §8.6, only becomes apparent on the platform. A human still
  sets the fixpoint via `POST …/fixpoints` (§4.4).
- **The trip is shared, the papers are not.** An attached document stays under
  the visibility of the documents service. Whoever may not see it sees in the
  trip only *that* one is attached and who attached it — never title, sender
  or file.
- **Any fellow traveller may attach.** Contributing your own ticket is a
  contribution, not a change to the framework; §6.2 withholds only the
  framework, guest list and casting vote.

The role (`lodging` | `transport` | `rental` | `ticket`) is what the paper does
**for the trip** — a different question from the document type of the taxonomy,
and therefore a column of its own rather than a derivation.

### 3.5 Who is travelling
People recognition knows the travel party. "We" is not generic: two children
under ten → shorter blocks, breaks, no three museums in a row; grandparents
along → walking distance and slope as a hard constraint instead of an
asterisk note. This acts directly on the time budget of a block.

**Implemented:** `GET`/`POST /trip-planner/plans/:planId/travellers`,
`POST …/travellers/update`, `POST …/travellers/remove` and the "Reisegruppe"
(travel party) screen.

The effect existed from the start — `blocks.ts` shrinks the budget of each block
for `withChildren` and once more for `limitedMobility`, and the packing list reads
the same two flags. What was missing was their **origin**: they came from a
sentence that someone typed once. That is right for the first trip and wrong for
the next — a child who was eight when it was described is eleven two years later,
and nobody noticed.

Now the **people** are in the trip, and the flags are a conclusion drawn from
them, freshly derived for the date on which the trip begins. The travel party
has two parts and one rule: **Whoever co-plans, travels along.** Every account
on the trip (organiser and everyone under "Planen mit") is thereby part of the
group, comes with the invitation and leaves with it — on the travel party screen
an account cannot be removed. Whoever has no account — a child, a grandma from
out of town — is entered by hand, with a name and an optional date of birth.
The date of birth of an account comes from its **own** household
(`user_subject_persons`, the `self` entry); otherwise it can be added on the
trip.

Three decisions:

- **Age is derived, "plan more time" never is.** How long a small child holds
  out is a fact about small children, and that is what dates of birth are for.
  "Needs more time", on the other hand, is a statement about a person and
  belongs to the one it concerns — a seventy-year-old who walks fifteen
  kilometres would rightly be offended if the app quietly halved her day. So
  the field is set, not inferred; §3.5's "grandparents along" is a reason to
  ask, not a licence to assume.

  **Changed (2026-09-18): the switch says what it does.** It was called "Kürzere
  Wege" (shorter ways) and thereby promised something it never did: it changes
  no path length and no stage boundary, it gives every block **30 % less
  programme** (`blocks.ts`, factor 0.7) — more time per place, more breaks. The
  explanatory sentence even claimed that walking distance and slope counted as
  a "hard limit"; nothing ever read that. Now it is "Mehr Zeit einplanen"
  (plan more time), with the sentence below it saying exactly that. And an
  ordinary switch instead of the outlined button whose state was only a tint —
  the HIG has a switch for "on or off", for good reason. Whoever really needs
  shorter paths has the stage limit for that (`maxWalkMinutes`); an effect of
  the switch on paths or accessibility (`wheelchair` tag) remains open.
- **How someone gets around is a second question** (2026-09-19). "Mehr Zeit
  einplanen" and "travelling by wheelchair" sound related and are not: one
  makes the day thinner, the other excludes a kind of destination. A route
  with 600 metres of ascent is not a slower outing for someone in a wheelchair,
  but none at all (§4.7) — and that is not a factor, but an exclusion. That is
  why each person now additionally carries a **mode of locomotion**: `foot`,
  `wheelchair` or `pram`.

  The brevity is deliberate. A word earns its place by what the planner
  *does* with it, and the planner distinguishes "on foot" from "on wheels" and
  nothing finer. Wheelchair and pram stand apart only so that a family with a
  pram does not have to tick "wheelchair"; that the plan treats both the same
  is stated by the screen. This too is set by a human, never inferred from an
  age — the same rule as with the time switch.

  Two things follow from this, and they are deliberately kept apart:

  - **`onWheels`** on the trip, as soon as someone travels on wheels. It
    changes **no** block budget; it is what a route has to hear.
  - **A walking pace** (`groupPaceFactor` in `blocks.ts`): The hiking time
    formula behind the route duration calculates with an adult hiker — 4 km/h,
    300 m/h of ascent. A group with a small child or with "plan more time" set
    does not walk that, so factor 1.4 (≈ 3 km/h). **Not a product**, unlike the
    budget factor: two reasons for being slower do not make a group slower
    still — the pace is that of the slowest person, and there is only one of
    them. The budget, by contrast, shrinks twice, because it is about
    programme density and not about speed.
- **Calculation is based on the trip start, not on today.** A trip planned in
  January for August is a trip with the child who has already had a birthday
  by August.
- **Accounts instead of household (2026-09-18).** The group was initially drawn
  from three lists: accounts, the organiser's household from the documents
  module, and manual entries. Accounts and household describe the same adults
  twice — "Erika" as an account, "Erika Beispiel (Ehefrau)" in the household —
  and the only key between the two was a name. Every attempt to reconcile that
  (`self` entry, full name from the own household, date of birth) remained a
  detour around a link that does not exist in the database. Now it is as simple
  as the album sharing: accounts are chosen under "Planen mit" from the account
  list and are thereby in the group; the household is no longer offered. What is
  lost is adopting a child from the household with one tap — children are
  entered once per trip.

A change to the group re-plans the trip — the blocks afterwards have different
budgets, and a day whose budgets have shifted but whose spots have not no
longer adds up. For the same reason it is the organiser's business (§6.2,
"Tempo und Begleitung" — pace and company). And it is **not** the guest list:
`trip_plan_shares` are those who may *plan*, `trip_plan_travellers` those who
*travel along* — a four-year-old has no access and yet decides how long the
afternoon may be.

**Travel party and voting.** An account is on the trip as a fellow traveller
and votes under its own account; a vote "by proxy" (`forTravellerId`) exists
only for manual entries, and the question "who has not voted yet" counts an
account once.

On the screen, removing a manual entry sits as a **swipe gesture** on the row,
no longer as a minus button next to the switch, where the thumb hit one when
it meant the other. The confirmation prompt remains.

### 3.6 Family voting with existing mechanics
Album voting (users **and** AI vote on photos) is transferable one to one to
spot candidates: everyone swipes through the suggestions before the trip,
the planner optimizes against the aggregated votes — where "aggregated"
precisely does not mean mean (§6.1). This pays off above all when
re-planning — when something has to drop out, what drops out first is what
mattered least to the group. Google Maps has lists, but no group decision
that then flows into a selection.

### 3.7 The circle closes with Trip Mode
`documentation/ios-trip-mode.md` automatically brings photos of the day into
the trip album. A plan plus this album yields, at no additional effort, a
**travel diary**: planned blocks against what was actually visited, per stop
the photos taken there, and at the end a recap (`documentation/recaps.md`),
which already exists.

### 3.8 Explainable, negotiable, ad-free
Every suggestion carries a justification ("20 min on foot from the hotel, fits
into the morning, you like viewpoints"), every weighting is adjustable. No
paid ranking, no sponsored entries — in a self-hosted system not a marketing
claim, but a property of the architecture.

### 3.9 Offline and without roaming
The OSM region databases are in the house anyway. A finished plan can be loaded
completely onto the iPhone and works abroad without a data connection. Because
planning is coarse, the offline plan is also fully fledged — no minute
details are missing that never existed anyway. Google Maps offline maps can
navigate, but not plan.

**Implemented:** `GET /trip-planner/plans/:planId/bundle` delivers the whole
plan in **one** response — stages, days, blocks, stops, pool and the light
windows of every fully planned, dated day. One request and not twelve, because
a bundle assembled from twelve calls can be half loaded, and a half-loaded
plan is exactly the failure this is built against. On the device it lies as a
file per trip in Application Support (not in Caches: a plan that disappears
because the phone needed space disappears exactly when the phone is full of
vacation photos).

**Two things are deliberately missing.** The weather forecast (§7.2) is the only
part of the plan that is worthless when stale — a three-day-old "dry" on the
rainy morning is worse than no statement at all, and the screen distinguishes
"no forecast" from "dry" anyway. And the map (§14): vector tiles from the
PBFs are a building block of their own; offline there are the block list,
spots and directions. Light, on the other hand, belongs in — it is arithmetic
on rows the plan already carries, it does not age, and it is calculated once
instead of twice differently.

**The bundle is fetched, not secretly created** ("Unterwegs ohne Netz" — on the
road without network — in the trip menu). The reason is the same as for any
silent caching: a plan that loads itself is also a plan that displays itself —
and then nobody can tell any more whether Tuesday or today is on the screen. It
is therefore read only when the server was *unreachable* (no network, roaming
off, timeout, 502/503/504); an answer from the server — 404, 401 — remains an
answer and is not covered up. When it is read, the day plan says so with its
age: "Offline — Stand von heute, 09:14" (offline — as of today, 09:14), plus
the note that map and weather are missing and changes need a connection.
Whoever has loaded the bundle once gets it quietly refreshed after every
successful load — otherwise the plan from breakfast would be in the pocket
while the day has long been rearranged.

### 3.10 Secondary: one's own photo history
Where the family happens to have been already, the POI matcher
(`poi-matcher.ts`, DINOv2 + OSM + Wikidata) already knows. That yields a nice
display on a repeat visit and a small ranking bonus or malus, which the user
sets themselves ("schon Gesehenes lieber wieder / lieber nicht" — rather see
things already seen again / rather not). Nothing more — see guiding
decision 3.

How this relates to the AI trip planners on the market — of which there are
now many — is described in §19.

**Conclusion:** Not "better than Google Maps", but **a different layer**: Google
navigates, fk-encore divides up the day. For turn-by-turn, handing over via
deep link to Apple/Google Maps is deliberate.

## 4. Planning granularity: stage, day, block

### 4.1 The time block

A day consists of **blocks**, not of a timeline:

| Block | Default budget | typical filling |
|---|---|---|
| Vormittag (morning) | approx. 3.5 h | 2–3 spots |
| Mittag (midday) | approx. 1.5 h | meal (free choice on site) |
| Nachmittag (afternoon) | approx. 3.5 h | 2–3 spots |
| Abend (evening) | optional | 1 spot / meal |

**This four-part division is the default, not a constraint** (decided, §15.2):
Every day is created with these four blocks, but each one can be renamed,
split, merged or deleted. The normal case thus remains predictable and
configuration-free, while arrival days, train bindings (§4.4) and splits
(§6.5) get the structure they need. For the data model this means: the block
type is a **label with a default budget**, not a fixed enumeration — a day
holds an ordered list of blocks, not four fields.

The budgets scale with the pace ("relaxed" shrinks them, "see a lot"
stretches them) and with the travel party. Within a block there is an
**order, but no clock times**: "Morning: cathedral → market hall → viewing
terrace, together approx. 3 h incl. paths".

**Travel times are only classified, not calculated:** "short walk"
(< 10 min), "longer walk" (10–25), "one ride" (public transit/car, roughly
estimated). For the block only the sum against the budget counts.

**That removes the need for timetable data.** A public-transit ride is first
estimated heuristically (straight-line distance ÷ typical network speed +
surcharge for waiting and changing); in the inner city that is accurate enough
for a block division. If a GTFS timetable is available for a region, it refines
the estimate — but it is **no longer a prerequisite**, merely a bonus. That
makes the feature immediately usable outside Germany too, where GTFS feeds are
laborious to obtain.

**Opening hours likewise coarse:** all that matters is whether a spot is "open
in the morning" or "closed on Mondays" — that can be obtained more reliably
from OSM than a minute-exact statement, and fits the block division exactly.

The lower bound of precision is chosen deliberately: **better a statement that
is true than a clock time that does not hold.**

**Implemented:** `GET`/`PATCH /trip-planner/plans/:planId/blocks` and the
"Tagesablauf" (daily schedule) screen (from the settings). The block list is
replaced as a whole — a day *is* the ordered list, and a sequence of individual
saves would leave states in between in which the day makes no sense. The server
checks what a day needs at minimum: at least one block, at most eight, unique
IDs, non-empty names (≤ 60 characters), 15–600 minutes per block and at least
one block that takes spots — a day consisting only of breaks is not a day. A
new block gets its ID from the name, so that a rename does not silently detach
everything that pointed to the old ID. Saving re-plans the days (only that;
stages, anchors, dates and the pool remain).

In doing so a bug surfaced that could not have been noticed without this
screen: both re-planning paths built the day from `DEFAULT_DAY` instead of from
the stored shape — a custom daily schedule would have silently become the
four-part division again at the first settings change. The shape is now read
from the constraints (`dayShapeOf`), `null` still means "default".

### 4.2 Stages: the layer above the days

A trip is rarely one place. "20 days Tokyo, Osaka and Hakata" needs a third
layer between trip and day, the **stage**:

- its own period (Tokyo 3–11 Sept., Osaka 11–18 Sept., Hakata 18–22 Sept.),
- its own **anchor** — the hotel of this stage, start and end point of every
  day. If nothing is booked yet, an **anchor zone** is sufficient instead of an
  address ("at most five metro stations from Wenceslas Square"): the planner
  calculates with its centroid and can at the same time output it as a search
  aid for the hotel choice,
- its own **mode of transport.** The mode belongs to the stage, not to the
  trip: arriving by car does not mean driving a car in the inner city. If the
  mode changes at the start of a stage, the change itself becomes a fixpoint —
  park & ride at the city edge, rental car return, luggage to the hotel,
- its own **region database** (Kanto, Kansai, Kyushu) and thereby its own
  candidate pool,
- **transfer days:** The journey between two stages is a fixpoint that eats up
  half a day. An arrival day has no full morning block, and the first block
  afterwards begins at the new anchor.

If hotel bookings are available as documents, the stage boundaries follow from
them by themselves; otherwise the planner suggests a division that the user
shifts. Redistribution always happens only **within** a stage — what drops out
in Tokyo does not slide over to Osaka.

**The transfer itself can be a planning object.** "See something on the way
without a big detour" is no longer a radius search, but a **corridor search
with a detour budget**: sought are spots that extend the journey by at most *n*
minutes. Cheaply solvable even without a router — the points for which
`distance(start, P) + distance(P, destination) ≤ distance(start, destination) + budget`
holds form an **ellipse with start and destination as foci**. That is a single
condition in PostGIS, filters a narrow band out of a whole country, and only
the few survivors get (later, with a router) a real detour calculation. How
much time is available at all follows from the fixpoints of the stage — an
arrival with check-in only from 3 pm *makes* the intermediate stop possible
instead of preventing it.

**Done (2026-09-16): the lake as a boundary — which region database a stage
gets.** The router picks the database by the rectangle around the region, and a
rectangle says "maybe", never "yes": Geofabrik cuts along administrative
boundaries, and the rectangle around Nord-Ovest extends past Pisa. For Pisa an
empty plan once came back; the answer to that was a data probe — "does this
database hold any POI within 25 km?" — which catches Pisa, a hundred kilometres
past the boundary.

It does not catch Lake Garda. The lake **is** the boundary: Lombardy on the
west shore, Veneto and Trentino on the east and north shores, five to ten
kilometres of water in between. From Malcesine the probe found the POIs of the
west shore well within 25 km, said "covered", and the planner filled four days
from a database that has nothing east of the water — over a hundred spots, each
on the wrong side. From Riva and Rovereto the same database was chosen, and
because nothing lies within walking distance there, an empty plan came back —
**without requesting the region it would have needed**, because from the
router's point of view it had one.

The question now goes to the authority that cut the extracts: Geofabrik
publishes the polygon for every extract, and the index lies on disk anyway for
the region suggestion. "Which extracts contain this point" is a
point-in-polygon test over that index, exact to the administrative boundary — a
rectangle candidate whose extract does not contain the point is eliminated,
whatever the probe says. The probe remains behind that for the one thing it
can do: an extract that contains the point but whose import came back empty. If
the index cannot be had at all — no cache, no network —, the polygon abstains
and the probe alone decides, as before: A router that rejects every region
because of a third-party outage turns one outage into a hundred import
requests.

Belonging to this: "Jetzt nachsehen" (check now) on a waiting plan **requests
the region**, instead of merely reporting that it is missing. A plan that came
into being while the router still took the neighbour for this shore never
requested the right region — waiting for an import that nobody has started
would be waiting without end. The answer now names region and status
("europe/italy/nord-est: wartet auf Freigabe" — waiting for approval).

### 4.3 Two resolutions: coarse for the trip, fine for tomorrow

Twenty days are around sixty blocks. Nobody wants to go through those in
advance, and it would also be wasted effort: the weather is unknown, and after
three days one knows better anyway what suits one. That is why the system
plans in two resolutions:

- **Trip resolution** (the whole time, immediately): per stage a rated pool
  ("Tokyo: 34 candidates, of which 12 clear favourites") plus everything that
  is bound to a date — booked time slots, day trips, transfer days. This is
  what the family votes on in advance.
- **Day resolution** (one to two days ahead): concrete blocks with order,
  paths and light windows, usually on the evening before.

The pool from §5 is thereby not only a reserve for re-planning, but from the
start **the actual planning result** — the day blocks are only its next
concretisation. For a weekend trip both resolutions coincide, for three weeks
they do not.

### 4.4 Hard clock times: the framework, not the content

Guiding decision 1 avoids clock times — but some are unavoidable: the last
train back, the booked time slot, check-in from 3 pm, the ferry departure. The
resolution is a division of labour:

- **Fixpoints are absolute** and carry a real clock time. They span the frame
  of a day.
- **Blocks are relative** and fill the space in between. They keep their
  coarse nature.

**Implemented:** `POST …/fixpoints` and `POST …/fixpoints/remove`. Fixed times
could previously only be supplied when creating a trip — the last train on the
last day thus only if someone had it in their head months beforehand, and until
then the afternoon promised hours that the group spends on the platform. Both
calls re-plan the trip afterwards: A fixpoint changes how many minutes the
blocks of the day have, and a day whose frame has moved but whose spots have
not no longer adds up. This is reserved for the organiser (§6.2) — "the last
train leaves at 17:45" is the framework in its purest form. In the app the
band of fixed times now always stands above the day, even when it is empty: A
band that only appears once one is already there is found by nobody.

**A fixpoint can additionally carry a place — and then it moves the route, not
just the budget.** Two days of every trip are not ordinary ones, and they are
the two that everybody remembers: on the first you arrive with luggage at the
station, on the last the train departs from there. Both were planned from the
anchor, i.e. from the accommodation — which put a path into the plan that
nobody walks, and left out the one everybody walks. The rule is in
`trip-planner/day-ends.ts` and is deliberately restricted to the two ends:

- A **located appointment that ends before the first block** (the arrival)
  becomes the **start** of the day — the first block departs from there.
- A **located departure** becomes the **destination** of the day — the last
  block ends at the platform instead of at an accommodation one has checked
  out of. With two departures the earlier wins: the second is someone
  correcting themselves.
- A located appointment **in the middle of the day** moves nothing. It would
  have to split a block to change the route, and a block that is secretly two
  blocks is worse than a path that is slightly too long. It costs its time as
  before.

Without a place everything stays as before: The day begins and ends at the
accommodation. The place is an addition, never a condition.

**The path is then paid for only once.** The backward buffer otherwise
subtracts `travelMinutes` from the budget of the last block — the very same
path that the route now pays for as a stage to the station. Where the route
pays for it, the guard no longer subtracts it (`travelPaidByRoute`): The
coordinate is the better information anyway, because it measures from the
actually last stop instead of from whatever someone imagined when entering it.
Exception: If behind the last spots block there is still another block (a
dinner, say), the deduction stays — then it is the only thing between a long
meal and a missed train. The safety buffer remains in every case.

A fixpoint at the end of the day is calculated **backwards**: From the last
train, the path to the station and a safety buffer are deducted, the rest is
the budget of the last block. The closer the day gets to this edge, the harder
the budget bites — and the sooner the redistribution (§5) suggests dropping
something. The buffer is negotiable, but never zero: Missing a train is more
expensive than a skipped spot.

### 4.5 Home base with day trips

The stage from §4.2 presupposes that the anchor moves with the accommodation:
Tokyo, then Osaka, then Hakata — new hotel, new stage, new pool. One of the
most common forms of vacation looks different, however:

> Four days Airbnb in San Gimignano. One day trip to Pisa, one to Florence,
> one to Lucca. The free time in San Gimignano.

That is **one** stage — the accommodation never changes, there is no transfer
day, the luggage stays put —, but three of its four days take place fifty to
eighty kilometres away. Today this cannot be expressed: The anchor belongs to
the stage, every day inherits it, and the pool comes from 2.5 kilometres around
San Gimignano. Florence does not appear in it.

Modelling this as three stages would be wrong and not just impractical: A
stage promises its own accommodation, transfer days and its own pool into which
nothing slides. Whoever drives back in the evening has none of that — and "what
dropped out in Florence does not slide over to Pisa" would be a rule that says
exactly the opposite of what was meant.

**Implemented: the day anchor** (migration 0195, `trip-planner/day-anchor.ts`).
A day may optionally carry its own place and radius. If it is absent — the
normal case and the free days in San Gimignano —, the anchor of the stage
applies, and nothing in the previous calculation changes. When creating via
`dayAnchors` per stage, afterwards via `POST …/plans/:planId/days/anchor`
(without a coordinate: the day comes home again). Four things hang on it, and
all four were already built, just attached somewhere else:

- **The pool of the day** comes from the surroundings of the day anchor. The
  region selection decides by coordinate anyway (`region-router.ts`), so an
  excursion across a region boundary is no special case.
- **There and back cost time**, and indeed out of the blocks of that day — the
  same calculation as for the arrival day in §4.2 ("no full morning block").
  One hour to Florence and one back means: The day has six hours, not eight.
  That is the reason why the day anchor is a *planning input* and not a
  display. The outbound journey shifts the start of the day, the return journey
  is deducted from the last block that carries places — a meal block is not
  shortened, otherwise one would be shifting a dinner instead of a journey. If
  too little remains, the block is dropped and says why. Deliberately **not**
  left to the solver as an ordinary stage: Planned from the accommodation, the
  journey would be a single hop of two and a half hours — above any leg length,
  and rightly so, because *within* Pisa such a hop would be an error.
- **Weather, climate and light** apply at the day anchor, not at the
  accommodation. At eighty kilometres that is occasionally a different day.
- **The return journey is a fixpoint candidate** (§4.4): Whoever has to be back
  on the last train from Florence has the afternoon calculated backwards.

**Done: stated times beat the estimate** (#1209, migration 0196).
The excursion may now carry a **departure** and a **return trip**, both
optional. With a departure the day begins at the stated hour plus travel time
instead of at the usual start time plus travel time; with a return trip nothing
more is planned behind it — the same rule as for the departure fixpoint
(§4.4) —, and the journey home beyond that costs the day nothing, because it
takes place afterwards. Without a statement everything stays as before:
estimated there, estimated back. The reason is §12: Without a router the travel
time is straight-line distance times a factor, and whoever knows the route
knows better than any arithmetic. The remaining estimate — the arrival — is
therefore displayed and not hidden in a shorter afternoon.

**Done: two speeds instead of one** (#1209, `travel.ts`). The reported
observation: 8 h 32 min for San Gimignano–Pisa and back, in reality around
1 h 30 each way. The cause was a single speed per means of transport — for the
car 20 km/h for traffic lights and one-way streets —, with which the sixty
kilometres across country were also calculated. Now the first three kilometres
count as passage through town and the rest as country road (car 72 km/h, public
transit 60 km/h); on foot and by bike it stays at one speed, because a body
does not get faster because the road gets straighter. City paths do not change
as a result, excursions by a factor of three.

What the day trip does not use up goes into the pool of the stage — "what
dropped out in Florence slides over to Pisa" is exactly the rule that §4.5
rejects. And because two days in Florence are two days in the same city, a
search is made once per destination, not per day.

**Done: the search radius knows the means of transport** (#1202,
`search-reach.ts`) — on foot 3 km, bike 8, public transit 18, car 25, an
explicitly set radius still overrides it. The original description of the
problem: `DEFAULT_SEARCH_RADIUS_M` is 2,500 metres, whether on foot or by car.
The car today changes only *how much* from the same circle fits into a block
(faster per hop, but six minutes of fixed cost for fetching and parking) — not
*how far* the circle reaches. The day trip from the ideas pool already does it
differently and gives the reason: 25 km default radius, 90 instead of 40
minutes per stage for car and public transit, because "half an hour in the car
is the way to the lake, not a detour" (§20.2). What applies there applies to a
car trip just as well. Proposed: **the default radius follows the mode** — on
foot 2.5 km, bike ~6 km, public transit and car ~15 km —, an explicitly set
radius still overrides it, and the honest side effect is more load on the
region search and a corridor filter that still calculates on straight lines.

**And the third one, which lies between the two:** In free text the means of
transport does not arrive at all. `NlConstraints` has no field for it — "wir
sind mit dem Auto unterwegs" (we are travelling by car) is dropped, and that is
right today, because an invented field would be worse than a missing one
(§13). With the mode as a constraint the sentence would get the effect the
speaker means — and then also the radius that hangs on it.

Order, if it gets built: first the mode radius (one line of logic, immediately
noticeable), then the day anchor (one column on `trip_plan_days`, one field in
the day frame, the travel time from the blocks), last the mode in free text.

**Done (2026-09-13): the lake in the way.**
The estimate was straight-line distance × detour factor (car 1.4), and the
factor is an average over a road network that leads roughly where you want to
go. A lake is not an average: from the east shore of Lake Garda to Lake Idro it
is twenty kilometres as the crow flies, so twenty-eight according to the
planner — and seventy by road, because it leads around the northern end.

Worse than a wrong number on a map: `legLimitFor` decides what is allowed into
a day at all. An underestimate admits places that nobody reaches.

A router is the right answer and a big piece of work (§14). This is the cheap
half, and it is possible because the data is already there: named bodies of
water are imported as POIs **with their geometry** (`shape`, for closed ways as
for multipolygon relations). `POST /water` in the geo service answers whether a
straight line crosses one, how much of it, and how large the thing is overall;
`detourAroundWater` adds half of its extent.

Three decisions that matter here:

- **Below 400 m of crossing nothing happens.** Rivers are crossed all the time,
  have bridges and are mostly lines rather than polygons anyway. Calculating a
  detour for each would be far more wrong than for none.
- **The error is deliberately one-sided.** A crossing near the end of the lake
  costs hardly anything, we still calculate half the extent. Overestimating
  leaves out something reachable that a human can bring back by hand;
  underestimating plans an afternoon around a place on the other side, which
  you notice in the car.
- **Stored, not fetched anew on every load** (migration 0197). The read path
  serves every plan retrieval and must not make an HTTP request per day — and
  the plan was built *under this assumption*; recalculating it later would let
  the map drift away from the day it describes.

The map says it: "Hin und zurück 2 h 30 (geschätzt) — um den Gardasee herum"
(there and back 2 h 30 (estimated) — around Lake Garda). Without this half
sentence a two-hour drive for twenty kilometres is simply a planner that nobody
believes.

**Done (2026-09-13): an excursion is a place, not a driving range.**
The search radius of a stage follows the means of transport (§4.2,
`search-reach.ts`): in the car 25 km, because "a day from here" reaches that far
with a car. A day trip inherited this radius — and thereby answered the wrong
question. Four days' accommodation at the lake, a day trip to a city an hour
away, and what was suggested was an amusement park and a wildlife park twenty
kilometres outside this city. The prominence side of the search (§4.2) pulls
them in reliably: they are better known than half the centre.

For the excursion, however, the journey is already paid for. Whoever drives to
Verona walks there — so an excursion is planned at the size of the place:
`DAY_TRIP_REACH_M` (8 km), big enough for a city with its fringe, small enough
that "we're driving to Verona" still means Verona. A stage that reaches less
far anyway keeps its number — travelling there on foot and then being offered
eight kilometres would be the same error mirror-inverted. And an explicit
`radiusM` at the day anchor still wins: "we stay in the old town" and "we drive
the valley" are both answers that no table can give.

The test for this measures the search radius, not the pins: that the distant
spots do not end up on the day may also have been the scoring's doing. What
does not even get into the pool can no longer be rescued by any filter — and
what gets in can be suggested.

**Done (2026-09-13): and the app now asks for it.**
`radiusM` has existed on the day anchor since there have been day anchors —
but nothing ever offered it. So the only answer a human could give was the
preset one. The excursion sheet now has three choices:
**Ortskern** (town centre, 2 km), **Ort** (place, default) and **Gegend**
(area, 25 km).

Three buttons instead of a field in metres, because nobody plans a day in
metres. And **"Ort" sends nothing** instead of sending 8,000: the default
belongs to the server, and writing today's number into every day planned today
would mean fixing it there forever.

`TripOutingReach.of(radiusM:)` handles the way back — a stored radius opens the
sheet on the choice that wrote it, and a radius that this sheet never wrote
(from the API, from a later version) on the nearest one. The sheet that always
opens on the default would, at the next save, silently widen a day that
someone deliberately made narrow — the same kind of error as the empty form on
editing (§15.3).

**Done (2026-09-13): "not this one" also works from the map.**
Hiding (§5) existed in the day plan and in the pool — that is, everywhere a
spot is a row. On the map it is a dot, and that is exactly where it becomes
apparent that one does not fit: it lies visibly outside, on the wrong side of
the river, far from all the others. Up to now that meant: close the map, find
the spot in the list, hide it, open the map again.

The info sheet behind a pin now has the same button with the same sentence
below it — it is the same "no", it applies to the whole trip, and it can be
undone in the pool under "Ausgeblendet" (hidden).

Two small things that belong to it: `TripPinDetail` now carries the `osmRef`,
because that is the handle that hiding refers to — a sheet that shows the point
but cannot name it would have a button that fails when pressed. And the map
gets the action as a closure instead of the view model: it remains a pure
function of its inputs, and the only thing it cannot calculate itself — what
happens to the trip — comes from the screen that owns the trip. Without the
closure the sheet is simply readable.

What it does not see: unnamed bodies of water (the import demands a name) and
rivers as `waterway` lines. And it does not know *where* the path leads around
— only that it has to.

**Done (2026-09-16): the day is walked around the same place everywhere.**
`solveDay` has long known that a day need not be a loop around the
accommodation: it takes `anchor`, `start` and `end`, and the planner fills all
three — the excursion destination on a day trip, the station on the arrival
day, the platform on the departure day (§4.4).

Everything that touches the day **afterwards** knew only the one anchor.
`recomputeDay` — the follow-up after moving, hiding, back-to-pool and the
weather swap — received a single coordinate and used it as both ends. On the
ordinary day that is right, and that is why it was never noticed. On the days
where it is wrong, it is doubly wrong:

- **Day trip.** The day was planned around Verona; a move recalculated it from
  the accommodation — the first stage was the hour of driving, and the last
  block paid for it once more. Afterwards the map said the morning was
  overfull because someone had moved a spot within it.
- **Arrival and departure.** The day planned from the station was recalculated
  from a hotel that nobody has reached yet; the day that ends at the platform
  got the way back to a hotel one has checked out of.

The question "where does this day begin and where must it end" now has **one**
answer in **one** place (`day-walk.ts`), and the solver like every follow-up
asks the same function. The order of precedence: a fixpoint with a place beats
the day anchor, which beats the stage anchor — and both ends are decided
separately, because an arrival says something about the morning and nothing
about the evening.

Two consequences that belong to it:

- **A move between two days recalculates each day around its own place.**
  Before, source and target day got the same anchor.
- **The weather swap refuses days at different places** (`different-places`).
  A rained-out excursion day cannot swap its spots with a dry day at the
  accommodation: afterwards they would lie an hour's drive from the day that
  received them. Rejected rather than half done, like every other
  incompatibility there — which of the two days moves is decided by the human.

**In the app** the day map showed the same misunderstanding: the house always
stood at the accommodation, even on a day whose route was calculated around
Verona. `TripMapAnchor` now decides point, label and symbol — excursion
destination with its own symbol instead of a house that is none there, and an
unnamed excursion is called "Ausflugsziel" instead of "Unterkunft" (§15.3).

### 4.6 The excursion nobody asked for

§4.5 makes the day trip *expressible*. The actual wish goes further:

> I only say "four days in San Gimignano" — and Florence, Pisa and Lucca
> should appear in the plan anyway.

That is justified, and can be argued from the pool itself: A place with seven
thousand inhabitants does not carry four days. Whoever stays four days goes
away — every person you ask says "you're an hour from Florence". A planner that
keeps quiet about that is not restrained, but useless.

And yet one of the hardest rules of this concept stands against it: **The
planner does not invent appointments** (§7.1). Sixty kilometres are not a side
effect of a place search, but a decision about the day. The resolution is the
same as with the evening light (§7.3) and with the excursion suggestion from
the ideas pool (§20.2): **suggest, not plan.** The suggestion writes nothing;
it is accepted by a tap, and then it sets the day anchor from §4.5.

**The trigger is measured, not guessed.** "Small place" is not a quantity that
exists in the system — the thinness of the pool, however, does: After the stage
pool is built, it states how many worthwhile spots (§10.5 `purpose: visit`,
with a prominence signal) there are for how many days. If that is not enough to
fill the days without stretching them with the ordinary, the stage is
**under-supplied** — and that is exactly the moment in which a human would
start looking beyond the horizon. The case is already visible today: The solver
leaves blocks empty, and the redistribution reports that nothing is left.

**Where the candidates come from, without re-import.** There is no place
database — `place` nodes are not imported. Two sources are already in every
region database, though:

- `osm_admin` — named administrative areas including level. A municipality in
  which forty prominent spots lie is a day destination; one with two is not.
- The **density of prominent spots** itself, counted over a coarse grid. Does
  without administrative boundaries and also finds the destination that is not
  a municipality of its own.

Both count the same thing: **what a day would carry there**, measured against
what the pool rates anyway. Against that stands the travel time in the mode of
this stage — and that is today a straight-line estimate (§12), so an hour can
be ninety minutes.

**How the suggestion sounds, and what it names:**

> „Vor Ort tragen die Vorschläge zwei eurer vier Tage. In einer Stunde Fahrt
> liegt Florenz — genug für einen ganzen Tag. Einen Tag dorthin einplanen?"
>
> (On site, the suggestions carry two of your four days. An hour's drive away
> lies Florence — enough for a whole day. Plan a day there?)

Three things are deliberately in it: **why** it asks at all (the pool does not
carry the days), **what it costs** (the travel time, there and back, from the
blocks of this day), and **one** suggestion instead of a list of five — an
evening carries one excursion, and five suggestions are a decision instead of a
hint (§20.2). A "no" is remembered and not repeated (§6.4, §7.1).

**What must not happen in the process:**

- **No silent day anchor.** A plan that takes place in Florence without
  anyone's doing is a different vacation from the one ordered.
- **No travel-agency ranking.** The suggestion justifies itself from the own
  pool, not from popularity that nobody can recalculate (§10.7).
- **No excursion as a gap filler.** Under-supplied means "the days do not
  carry", not "a block is short". A tight afternoon is no reason to put
  somebody in the car.

The prerequisite is §4.5: Without a day anchor there is nothing an accepted
suggestion could land in. In the order there it stands behind the day anchor —
and it is the part that turns "four days in San Gimignano" into what the
traveller actually meant.

**Stage 1 implemented: measured and suggested.**

The trigger is now a calculation instead of an estimate
(`trip-planner/thin-pool.ts`). The question is not "is the place small", but:
**Would a whole day of this stage stay empty even if everything still in the
pool were scheduled?** Both sides are minutes that the plan knows anyway —
unscheduled block budget against the dwell time of the remaining pool — and
it is precisely this comparison that separates the case from the tight
afternoon: Whoever has twenty spots left has their empty blocks for another
reason, and no excursion answers that. A day-trip day (§4.5) and the buffer day
(§7.2) count on neither side; a stage of one day is never asked, because there
is nothing one would drive *instead of*.

The candidates come, as described, without re-import from the region
(`geo/src/day-targets.ts`): prominent spots in a **ring** around the anchor —
inside it the stage's own search reach, so that nothing is suggested where one
already is — grouped by the most local named administrative area (`osm_admin`,
level 7–9, because "Firenze" is a destination and "Toscana" is not) and, for
everything that lies in none, by a coarse grid. Both ways count the same: what
a day would carry there. The region counts, it does not decide.

`GET …/plans/:planId/day-trip` writes nothing. It checks three things in this
order — do the days carry, is there something within reach, would a day remain
of it — and answers with **one** destination or none, together with the
sentence from §4.6: why it is asked, what is there, what it costs. The travel
time is the straight-line estimate in the mode of the stage (§12); two hours
each way is the limit, below that at least four hours must remain on site, and
three spots are never a day.

**Stage 2 implemented: accept, decline, display.**

`POST …/plans/:planId/day-trip` accepts the suggestion — namely by calling
`setTripDayAnchor`: the same organiser rule, the same check, the same
re-planning as with the day anchor by hand (§4.5). The destination is
**looked up again** in the process instead of being read from the request, for
the same reason as with the route adoption (§4.7): Where a day takes place
decides from which pool it is built and how many minutes its blocks have. A
suggestion that no longer applies is rejected instead of applied to what the
client last saw.

`POST …/day-trip/dismiss` remembers the "no" (§6.4, §7.1) — on the **stage**,
not on the trip, because a trip can be under-supplied in one place and full in
the next; the stage row survives a re-planning, and so does the answer.
A place is declined, not the question: The next suggestion comes immediately,
and a destination without an administrative boundary is remembered via its
rounded position, because it has no reference.

In the app: "Tagesausflug" (day trip) in the menu of the stage, a screen in the
form of the evening light (§7.3) — one destination, what is there, what it
costs, two buttons. Plus the calculation in plain words ("nicht verplant" —
unscheduled, "noch im Vorrat" — still in the pool, "bliebe trotzdem leer" —
would stay empty anyway), because "we recommend" is nothing one can disagree
with, and three numbers are. The most common case — this stage carries its
days — is a state of its own and not an empty list.

### 4.7 Routes: the journey is the destination

A spot is a point: go there, stay, go on from there. The Ponale road above Lake
Garda is not one. It begins in Riva, ends at Lake Ledro, takes as long as it
takes — and the next path of the day begins at its **end**, not at its
beginning. The same applies to the high-level trail, the panoramic road, the
ferry as an excursion instead of as a transfer, the cable car with a hike at
the top. The question was: special case, or really just a spot for which
"the journey is the destination" additionally counts?

**The answer: a spot with an extent, not a second entity.** Everything a spot
can do — lie in the pool, be rated, hidden, voted on, moved, stand on the
map — a route can do too, and it should, without a second path being built
anywhere. What distinguishes it from the point is exactly three things, in
this order of importance:

1. **Start and end are different.** The day route goes accommodation →
   stop 1 → stop n → accommodation (§4.5). With a route, the next path
   lies not at the spot, but at its end. A point cannot express that; a day
   that is continued from the start of a 10 km route burdens the afternoon with
   a path that nobody walks — or admits one that nobody manages.
2. **The duration is a property of the thing, not of the category.** A museum
   is 90 minutes, a viewpoint 20 (§4.1). Ten kilometres with 600 metres of
   ascent are four hours on foot and one and a half by bike. No category knows
   that; the route has to say it itself.
3. **It contains spots.** The viewpoints and tunnels along the Ponale are
   separate points in OSM. The planner would schedule them additionally,
   although they are passed on the way anyway.

In addition come conditions that a point does not have: the means of transport
(bike available or rental), the weather (rain cancels the route, a museum not
— §7.2), the daylight (the route must be over before dark), and the photo
light not at one place, but along an orientation.

**The data model:** A spot optionally carries an `extent` — the end point and,
where known, length and ascent in metres. If it is absent, it is the point it
always was; if only the end point is missing, it is a circular route and needs
no `extent`. The duration is that of the spot (`dwellMinutes`), set on creation
or overridden by note (§9.2) — never inferred from the category. The category
is called `route`, outdoors (§7.2).

**What the planner does with it (stage 1, implemented):**

- **The day continues at the end.** In the solver, when moving, when
  redistributing, in the weather and light rebuild: every place that asks "where
  do we stand after this stop" gets an answer (`leaveFrom`). The way back to
  the accommodation — or to the excursion destination, to the platform
  (§4.4, §4.5) — is measured from the end. Thereby the block budget is right,
  and the viewpoint 300 m behind the end is a short walk instead of a
  two-hour march that no block allows.
- **A route comes as a find** (§9.2): `POST …/finds` takes `end`,
  `lengthM`, `ascentM` and additionally requires `dwellMinutes`. The OSM entry
  at the starting point is deliberately *not* assigned — it is the viewpoint
  from which the route starts, not the path itself — and a route is never
  mixed into the point where it begins, not even under the same name. Two
  ends more than 80 km apart are rejected: that is a transfer (§4.2), not a
  route within a block.

**Longer than a block (stage 3, implemented):**

A four-hour hike fits into no morning. The open question was whether the solver
then merges two blocks — it would be the first case in which a candidate
changes the day's shape instead of filling it.

**The answer is no.** The budget of a block is not a wall, but the point at
which it should end. A stop may run beyond it; what follows then begins later,
and the plan says so. The shape of the day remains what the traveller drew: The
morning remains the morning, lunch remains lunch — it just begins at half past
one. That is exactly what happens when you walk the Ponale, and it is a
sentence that can be checked on the day.

Who may do this is the core of the decision:

- **The planner not.** `solveDay` fills every block within its budget as
  before. The machine keeps to the frame it was given; a spot that fits
  nowhere stays in the pool.
- **A human yes.** Scheduling and moving have never refused an overfull block
  (§5: "a red block says more than a rejected gesture"). Only the minutes used
  to vanish — the afternoon was calculated as if the morning had ended on
  time. Now they are passed on (`spill.ts`): Every block knows how much later
  it begins, an empty block swallows the overflow (that is why a day has a lunch
  break), and what lands behind the last block is time the day does not have.

In the app: The block that overruns says "zieht ca. 30 min über — der nächste
Block beginnt später" (runs about 30 min over — the next block begins later);
the one that receives it says "beginnt ca. 30 min später" (begins about 30 min
later). The budget bar turns red when a block **including its delayed start**
overruns — not only when its own content is too much. And in the candidate list
a route that fits into no block says why it stays lying there, instead of
looking overlooked.

Thereby merging blocks remains what it was: a matter for the traveller via the
"Tagesablauf" screen (§4.1), not for the planner.

**What is taken along on the way (stage 4, implemented):**

The viewpoints and tunnels along the Ponale are separate points in OSM. The
planner saw them as candidates of their own and gave them a block of their own
— although one passes all of them when walking the route. Whoever schedules
them additionally schedules the same hour twice.

A spot that lies on a route of the day is therefore considered **passed, not
planned** (`on-the-way.ts`): It costs no budget, occupies no place in the
block, and the route says that it is coming ("unterwegs: Belvedere Beispiel
und 2 weitere" — on the way: Belvedere Beispiel and 2 more). Nothing is hidden
and nothing finally decided — the spot stays in the pool, and a day without
this route offers it again like any other. This applies to the whole day, not
just the block: One passes by once, and an afternoon that schedules what the
morning has walked through is the same error one block later.

**Not the ellipse of the corridor search.** `corridor.ts` asks what a stop adds
to a journey in metres, and takes everything below a budget. That is the right
question for a transfer, where the road is unknown and a few kilometres of
detour are the point. Here it is wrong, because the ellipse gets wider with
length: 400 m of detour allow more than a kilometre beside the line over an
8 km route. Because this rule takes something out of the day unasked, it is the
narrower and plainer one — 250 m beside the line between the two ends.

**What it cannot do yet:** The line between the ends is not the path. The
Ponale climbs in switchbacks that a chord cuts straight through — a viewpoint
in the third hairpin is not recognised. That is the safe direction of the
error: A spot not recognised is simply planned as before. It is also the reason
why importing the real geometry is the next step; the same width along the real
line takes in what the chord has to let through.

**Routes from the import (stage 5, implemented):**

OSM knows signposted trails as relations (`route=hiking`, `foot`,
`bicycle`, `mtb`) — with name, course, length and often ascent. The importer
now takes them along (`osm_routes`), and the planner offers them:
"Strecken in der Nähe" (routes nearby) in the day menu lists what passes the
city, and a tap adopts them into the candidates — via the same find path as any
other place (§9.2), only with ends, length, ascent and course in the luggage.

Three things are read from the geometry in the process instead of being frozen
at import, because only the geometry stays honest:

- **The length** is the real length of the path, not the `distance` tag (a
  rounded value that is often missing).
- **The two ends** come from `ST_LineMerge`. If the parts of a relation fit
  together, it has an end; if they do not — gaps, branches, signposted variants
  —, then it has none that could be named, and that is said instead of
  declaring a loose end the destination (§15.3). A **circular route ends where
  it begins**: That is its end, and thus length and course are retained, which
  a mere point would throw away.
- **The course**, simplified to at most 64 points so that a plan can take it
  offline. It is what lets the corridor from stage 4 follow the real line
  instead of the chord — the viewpoint in the third hairpin is now recognised.

**The duration is calculated by the path itself** (`route-duration.ts`). §4.7
says: "No category knows that; the route has to say it itself" — and it says it
in the two numbers from which hours follow. The hiking time formula (DIN 33466)
is used: horizontal time and vertical time, of which the larger counts in full
and the smaller by half. Ten kilometres with 600 metres of ascent thus give
3.5 hours on foot and 1 hour 50 by bike — exactly the example above. It is a
starting number, not a judgement: Whoever adopts the route can change it, and
then theirs applies.

**Operationally:** The routes table is created at import. Existing regions do
not have it, and that is not an error, but an older import — the search says so
(`imported: false`) and offers the re-import, instead of showing an empty list
that looks like "there is nothing here".

**What is deliberately not built yet:**

- **The duration by travel party — implemented (2026-09-19).** "Mehr Zeit
  einplanen" (§3.5) scales block budgets; for a route it now scales the
  duration itself, and whoever travels on wheels does not even get it
  suggested.

  - **The pace** (`routeMinutes(…, paceFactor)`): The whole is scaled, not just
    the flat part — a group that walks three kilometres an hour also climbs
    more slowly, and a separate correction would claim a precision that nobody
    has measured.
  - **The exclusion** (`rollable()` in `routes.ts`): decided by the words of the
    map instead of by a judgement about people. `hiking` and `mtb` are
    signposted over ground chosen for boots and tyres; in addition everything
    with a known ascent is dropped. A lakeside promenade as `foot` without
    ascent stays — with the honest limit that OSM promises no surface, which is
    why the app speaks of a filtered list and not of a guarantee.
  - **It is always said** (`omittedForWheels` plus sentence): A list that has
    quietly become shorter reads like an area without routes, and one that is
    empty after filtering like an area without routes *for us* — two different
    sentences (§15.3).
  - **Adopting does not filter.** Whoever explicitly fetches a route is not
    overruled: The list is a suggestion, not a gate (§7.1).

**In the app (stage 2, implemented):** "Strecke anlegen" (create route) in the
menu of the day — name, start and end via the device's place search, duration,
optionally length and ascent. Candidate list, day plan, pin sheet and detail
show "Strecke · 10 km · 600 Hm" (route · 10 km · 600 m ascent).

**The course on the map (stage 6, implemented):**

The course had been in the database since stage 5 and never arrived on a
screen: The search response did not carry it, the Swift model had no field for
it, and both maps kept drawing the dashed straight line from stage 2 — although
the app knew where the path really runs.

Now both responses carry it, and **which line one sees tells how much is
known**: Where OSM has the course, it is drawn solid, because that is the path.
Where not — a relation with gaps, a plan from before this stage —, the dashed
chord with destination flag remains, because the app has no router and does not
conceal that (§9.5). The same distinction as with `imported: false`: two
different answers, two different pictures.

In addition, every row in "Strecken in der Nähe" leads to a screen of its own
with the map. A list of names is not a decision — two ten-kilometre hikes from
the same city are not the same hike, and only the course says which one stays at
the lake and which one goes over the ridge.

**Pictures along the route (stage 11, implemented — in field testing):**

Komoot shows, for every tour, the photos of those who have walked it.
OpenStreetMap has no photos, and Komoot's are not available openly. What is
openly available is Wikimedia Commons: millions of photos with a capture
location, freely licensed, queryable without a key — and Wikidata, which for
many summits and castles knows *one* selected picture (P18).

The detail view of a route therefore has a picture strip, filled in two steps:

1. `geo` names the things along the path that have a Wikidata entry — the same
   categories and the same 150 m as the rating from stage 10 —, and a few
   points distributed over the stretch nearby (`POST /routes/along`,
   `geo/src/route-along.ts`).
2. The trip-planner first fetches the selected pictures of these things (the
   best picture of a summit is the best picture of this part of the hike, with
   the name as caption), then, by geosearch, photos taken up to 300 m from the
   points — in turn across the points, so that the strip walks along the path
   instead of showing four pictures of the first car park
   (`trip-planner/route-photos.ts`, `commons-client.ts`).

Only JPEG and WebP of 800 px width or more: PNG and SVG are far more often
maps, coats of arms and diagrams than photos on Commons. Author and licence are
shown under each picture and in the large view, with a link to the Commons
page — free licences are free on the condition that one says whose picture it
is. The response is kept for one day per route and segment; Wikimedia asks not
to ask twice. What leaves the house are coordinates along a public path and IDs
of public places; the phone loads the pictures directly from Wikimedia.

Honest about the limit: The pictures show the places along the path rather than
the path itself. A well-known route gets a full strip, a nameless forest track
often none — and then the app shows **no section**, no apology (§15.3). No
re-import necessary.

*If this does not prove itself in field testing*, the alternative is the
"out-and-in" pattern that the planner already uses with map apps: open Komoot
(or Outdooractive, AllTrails) from the app at the coordinate of the stage,
search for tours with photos and ratings there, and bring a chosen tour back
into the planner as GPX — via the share dialog that the Share Extension already
serves (§9.3). For that the planner would need a GPX import as a candidate (a
track instead of a relation), no connection to the portals.

**Which ones are worthwhile (stage 10, implemented):**

After stage 9 there were enough routes, but the list said only where they lie,
not which ones one should walk. The tour portals know that — ratings, photos,
highlights —, but do not release it (Komoot and Outdooractive only via partner
APIs, AllTrails and Strava not at all). OpenStreetMap does not rate, but knows
two things that vouch well enough for it:

- **What the route passes.** Summits, viewpoints, lakes, castles, ruins, an
  inn — up to 150 m beside the line. That is most of what a portal calls
  "highlights", and it is in the import already as POIs; the search only has to
  look along the line. Counted **only on the stretch within the surroundings of
  the stage** (`ST_ClipByBox2D`): a thousand-kilometre long-distance cycle path
  passes everything somewhere, what matters is what it passes *here*.
- **How much it means to its network.** European long-distance trail before
  national before regional before local (`iwn`/`nwn`/`rwn`/`lwn`, the same
  letters with `c` for cycling), and a Wikipedia article as the same signal
  from outside.

From this `geo/src/route-worth.ts` forms a sort key. The caps per category
count for more than the weights: without them a cycle path through a lakeside
town with thirty cafés wins, and a chain of ponds beats the path to the summit.
Churches and wayside crosses do not count — every village has one, and a path
through five villages is not five times as good —, nor does a nameless tower
(often a radio mast); a nameless viewpoint does.

So that the order is of any use, **not only the first page is re-sorted**: geo
weighs the 200 nearest routes in the band and returns the 40 most worthwhile.
Otherwise one would only have reshuffled the list one already found boring.

The app shows **no score**, but the things: "Gipfel · 2 Aussichtspunkte ·
Einkehr" (summit · 2 viewpoints · inn) in the row, in the detail with names,
plus the network in words ("Fernwanderweg" — long-distance trail, "regional"
instead of "RWN") and the Wikipedia article as a link. A number would want to
be believed; the things one can weigh for oneself — whoever travels with
children wants the lake, someone else the summit. The order is selectable
("Lohnendste zuerst" — most worthwhile first / "Nächste zuerst" — nearest
first) and is set to "worthwhile": whoever opens this list is choosing, and
the nearest is merely the most convenient. No re-import necessary — everything
that is counted has already been imported.

**A band instead of an upper limit, kinds to deselect, and a map
(stage 9, implemented):**

Stage 8 made the radius adjustable, and in use it turned out that adjusting
achieves nothing: The response is sorted by distance and capped at 40, so a
larger circle delivers the same near routes once more and adds that there would
be more. Whoever has grazed off the near ones needs them **gone**, not
surplus.

That is why the selector is now a **band**: up to 20 km / 20–35 km / 35–50 km.
Each band has its own 40 places, and "I know the near ones, show me the next
ring" really works. The near bands are the narrow ones, because routes around a
city lie dense and thin out toward the outside — equally sized thirds would let
the first overflow and the last stay empty.

In `geo` this is one condition: `ST_DWithin(…max) AND NOT ST_DWithin(…min)`, the
same pattern as the ring of the day destinations (§4.6), and as a negated
containment check instead of a distance comparison, so that the index applies.
Two rules to go with it, and they stand in different places on purpose: **geo
rejects a band that can hold nothing** (40 to 40), because an empty list would
read like an area without routes; **the trip-planner silently caps it to the
full circle**, because there it comes from a selector, and two numbers that no
longer fit together are an error of the app and not of the traveller.

An empty response now also says *why* it is empty: "In diesem
Entfernungsbereich ist keine Strecke erfasst — näher dran vielleicht schon"
(no route is recorded in this distance range — perhaps closer by) is a
different piece of information from "in der Nähe gibt es keine" (there are none
nearby), and only one of them is a reason to change the filter (§15.3).

**The kinds can be deselected.** The endpoint has had `kinds` since stage 5,
only there was no button: hiking, walking, cycling, mountain biking, each on
and off. Whoever deselects all gets all — the same that the endpoint reads from
a missing list, instead of an empty list for a reason nobody would guess. The
button names the chosen kinds instead of counting them; "2 of 4" does not say
which ones are missing.

**And there is the map** (`TripRoutesMapView`). Forty rows of names do not show
that three of them follow the same valley and the fourth is the only one that
leads out — the shapes show it at a glance. What is tapped is a **pin, not the
line**: SwiftUI's `Map` draws a `MapPolyline`, but only lets an `Annotation`
accept a gesture. The same division of labour as on the day map, where the line
belongs to the pin and not the other way round. The colour tells the kind —
green on foot, blue by bike —, two colours for four kinds, because on a map
what counts is what one would do, and `hiking` versus `foot` is a question for
the row.

**How far to search (stage 8, implemented):**

The radius was 15 km and not adjustable — the endpoint could do more since
stage 5 (up to 50 km), only the app never sent a value. Now above the list
there is a selector with **15 / 25 / 50 km**.

Three steps instead of a slider, because nobody has an opinion on the number:
Whether 23 or 27 kilometres is not a decision, "around the city", "short
approach" and "day trip by car" are. 50 is the end of the scale because it is
the limit of the server (`MAX_RADIUS_M`, and geo rejects more) — a fourth step
would be an option that comes back as an error.

Two sentences stand there that otherwise nobody can guess:

- **Measurement is from the starting point of the stage to the nearest point of
  the route**, not to its beginning. A 60 km long-distance hike that passes the
  city at eight kilometres is in the list, even if its start lies a hundred
  kilometres away.
- **If there is more than the 40 of the response**, the list says so at the end
  instead of silently truncating (§15.3). With 50 km that happens quickly, and a
  list that stops at forty would otherwise read like an area with forty routes.

The choice is remembered by the device (`trip.routes.radiusKm`): How far
someone is willing to travel is a habit and not a decision about a city. It
changes no plan and no list other than its own.

**Taking the route along (stage 7, implemented):**

The planner decides *which* path is worth a day; it is walked with something
else. Komoot, Organic Maps, Outdooractive and a Garmin can do that, and all
read GPX — so on the route screen there is "Als GPX exportieren" (export as
GPX), and the share menu hands the file to the app that is to have it. This is
no softening of the boundary from §9.5, but exactly it: hand over instead of
navigating oneself (§9.1).

Three decisions are in it, and each is one where the obvious would be wrong:

- **The geometry is fetched once more, unsimplified**
  (`geo/src/route-geometry.ts`). The course in the plan is simplified to 50 m
  and thinned to 64 points — right for a map, wrong for a file that someone
  follows: 64 points over twenty kilometres cut off every switchback, and whoever
  follows the result leaves the path. That is why it is a query of its own and
  not a mode of the search — so that nobody accidentally exports the map line.
- **A `<trk>`, never a `<rte>`.** A `<rte>` is a list of points *between which*
  the reading app routes itself — for a signposted path that means: it suggests
  a different one. A `<trk>` is the course itself.
- **Gaps stay gaps.** A relation whose parts do not close becomes several
  `<trkseg>` in one `<trk>`. A solid stroke across the hole would be a line that
  nobody can walk, issued as a signposted path (§15.3). It is also stated in
  the description of the file, because whoever opens it in six weeks will not
  remember.

No elevation values: The relation carries *one* number for the whole path, and
the geometry has no z. An `<ele>` per point would be an invented profile. The
total is in the description, where it cannot be mistaken for a measurement.

The way to the file leads **through the plan** (`GET /trip-planner/routes/gpx`
with `planId`, `legIndex`, `osmRef`): a plan that the caller may see, a stage
that exists, a region that covers the place. Nobody names a region database and
a relation ID and has it read out. Every "no" that can be reached on the way
has a sentence of its own: no plan, no stage, no imported region, a relation
that a re-import has dropped, and one without a usable course.

**What it is still not meant to become:** a tour planner with elevation profile
and its own navigation. The app says "this morning the Ponale, from Riva,
approx. 3 h, ending at Lake Ledro", shows where it goes, and hands over to the
outside for the path itself (§9.1).

## 5. Replanning as a Core Mechanic

A plan consists of three layers:

- **Fixed points** — taken from documents or pinned by the user (hotel check-in,
  booked time slot, train departure, change of mode). They are never moved
  automatically and are the only elements with a real clock time (§4.4).
- **Scheduled spots** — per block, in order.
- **Pool** — rated candidates of the region that are not (yet) scheduled.
  The pool is the reason replanning is fast: the candidates have already been
  searched, rated and given rough travel times.

**Triggers for a redistribution:**

- The user taps “we are here, it is now”.
- **The app notices on its own** from the location: the group is lagging behind
  the block (§7.1). It *offers* the redistribution; it does not carry it out
  unasked.
- **The weather forecast changes** — a dry afternoon turns into a wet one
  (§7.2).
- A spot is marked as done, skipped, or “took longer”.
- A condition changes via chat: *“it's raining — something indoors”*, *“too much
  walking”*, *“we don't feel like museums any more”*.

**What happens then:** Only the **rest from now on** is redistributed; the past
stays untouched (it is the beginning of the travel journal). What no longer
fits is not deleted but moves back into the pool — with increased priority for
the following days, if there are any left. What gets ejected first is whatever
has the lowest group votes — heart wishes and the fairness account (§6.1)
protect individual picks from being the first to fall.

**Visible to the user** is always only the consequence, not the calculation:
*“The afternoon is getting tight — E drops out and moves to tomorrow morning.”*
With an undo button.

### 5.1 “Not this one — and not next time either”

The rule above — nothing is deleted, everything moves into the pool — is right
for the case it was written for: *The afternoon is full, this spot waits for
tomorrow.* For the second case it is wrong, and that one came out of
field testing: The search suggests a place nobody wants — a parking lot
recorded as a sightseeing spot, the fourth church. Put back into the pool, it
turns up again at the next replanning, and the one after that.

**The row itself cannot be deleted**: It belongs to the region database and
comes back with every search. Only the **answer** can be kept — exactly the
mechanic that §20.5 sketches for the idea pool (“remembers a ‘no’ instead of
deleting it”). Three decisions:

- **Per trip, not per stage.** A place the family did not want in Lisbon is not
  wanted on the second Lisbon day either; the trip is the unit in which people
  think.
- **Reversible and visible.** Hidden spots are listed by name and come back
  with a single tap. A “no” that cannot be taken back is a deletion with a
  friendlier word.
- **It applies to the planner, not to the map.** Searching for a name and
  “what is nearby” still find the place: they answer “what is there”, hiding
  answers “what should be suggested”.

**A spot added by hand does not need this.** It exists because someone entered
it — removing it from the pool removes it for good, and a remembered “no” for a
place the search will never suggest would be a note without an addressee. The
app therefore shows two different gestures: *Remove* on one's own find,
*Hide* on the machine's find.

**Implemented:** `trip_hidden_spots` (migration 0177), `POST …/spots/hide`,
`POST …/spots/unhide`, `GET …/hidden`. Hiding removes the spot from every pool
and every day of the trip, and the days that get a gap as a result are
recalculated — the route to the left and right of the gap has changed (§8.4).
Unhiding deliberately triggers **no** replanning: putting a spot back in the
running is not the same as placing it on a day, and rebuilding other people's
days as a side effect of a correction would be the bigger surprise (§7.1).

### 5.2 The Pool on the Map

The pool is a list, sorted by score. For “what did the planner find?” that is
enough; for the question one actually asks in front of this list, it is not:
**where is all of this?** A hundred and fifty candidates with name and category
do not tell you that twenty of them lie in the same alley and three at the
other end of town — and that is exactly what decides what fits into half a day
(§3.1). The day map (§8.3) answers the question for the scheduled spots; for
the unscheduled ones it is missing.

Two things should be added, and one of them half exists already:

**The search exists** — as a search field above the list, which iOS only shows
when you pull down. Anyone who does not know it is there will not find it, and
“search the pool” is no side issue in a pool of a hundred and fifty entries.
It should be permanently visible (`.navigationBarDrawer(displayMode:
.always)`) and filter the same result for list and map: What disappears from
the list also disappears as a pin.

**The map is new**, as a second presentation of the same pool — a list/map
toggle, not a separate screen. It shows the accommodation as a house, the
candidates as pins, and tapping a pin opens the same info sheet that the day
map has had since §5.1: name, type, note, links, “Open in Maps” — and the
actions of the pool: **Put into a block** and **Hide** (or *Remove* on one's
own find). The pins carry no numbers, because the pool has no order; instead
the color can say what the list says in words today — own find, photo stop,
already on a day.

**Reuse, and where it ends.** `TripDayMapView` is built around the day: pins
numbered in walking order, color by status, below it the slider over the hours.
A pool has none of that. What both need is smaller and worth extracting: the
map with house and pins, tap-opens-sheet, and the sheet itself. For that,
`TripPinDetail` splits into the part that applies to every place (name, sign
name, type, note, links, coordinate, `osmRef`) and the part that belongs only
to a scheduled stop (number, block, way there, status) — the latter optional,
and the sheet shows what is there. As today, the actions come as closures from
the screen that owns the trip: The day map passes through *Hide*, the pool map
*Place* and *Hide*. The map itself remains a pure function of its inputs.

What is **not** reused: the slider. It is the answer to “where would I be at 3
pm”, and the pool has no clock time. A map that shows it and then does nothing
with it would be a control that does not control anything.

Additionally useful, but not part of this step: The map as a place where one
*finds* a candidate, not just looks at it — the search from §9.2 case 4 with
pins instead of rows. That is the same map with a different source and belongs
to Discover (§9.2), not to the pool.

**Implemented:** The search sits permanently above list and map
(`.navigationBarDrawer(displayMode: .always)`) and filters both through the
same pure filter — what disappears from the list also disappears as a pin. The
list/map toggle sits in the pool's title bar and remembers the choice. The map
itself (`TripSpotMapView`: house, pins, tapping) and the info sheet
(`TripPinDetailSheet` with actions as closures of the screen that owns the
trip) were extracted; `TripPinDetail` now separates the part that applies to
every place from the optional part that belongs only to a scheduled stop
(number, block, way there, status) — the sheet shows what is there. The pool
pins carry no numbers; their color says what the list says in words
(candidate, own find, photo stop, already scheduled), explained by a legend
below the map. The slider stays with the day.

## 6. Traveling in a Group: Contributions, Roles, Splits

Up to here the concept reads as if one person were planning. In fact several
family members use the app, contribute spots, weight them differently, and at
times drift apart on the road. That is not a boundary condition but shapes the
data model and the mechanics.

### 6.1 The Pool Is Shared, the Rating Is Personal

All participants feed **the same pool** (§5): via the automatic candidate
search, via their own finds from map apps, articles and screenshots (§9.2), or
via the search in the app. It stays visible who contributed what — that costs
nothing and is socially important.

Rating, on the other hand, is **per person**: swiping through with *want it* /
*don't care* / *rather not*. Someone without their own account (small children)
gets a vote that is kept on their behalf.

**The mean is the wrong aggregation here** — and that is the most important
point of this chapter. An average picks what everyone finds *mediocre* and
strikes what means *a lot* to one person and nothing to the others. The result
is a plan nobody loved. Hence two correctives:

- **Heart wishes with a quota.** Each person has a small fixed number of picks
  per stage (about two per three days). A spot marked this way makes it into the
  plan as long as it is physically possible — regardless of the majority. That
  protects exactly the preferences that an average grinds up.
- **A fairness account.** For everything else the sum of votes counts, but the
  planner remembers whose wishes have already been fulfilled, and in a tie
  favors the person who last had to back down. A counter, not a procedure — and
  explainable: *“today it's X's turn again.”*

A *rather not* is a strong minus, but not a veto. Real exclusions (“no
high-altitude trails”) are not votes but constraints of the person (§3.5) and
act on the solver, not on the ranking.

**Implemented:** `GET`/`POST /trip-planner/plans/:planId/votes`,
`POST …/votes/apply`, `GET …/fairness` (migration 0182) and the screen
“Wünsche” (wishes). The aggregation lives in `votes.ts` and is pure: votes in,
bonuses and sentences out.

- **Sum instead of mean.** Two “want it” beat one, and three shrugs do not
  dilute one enthusiasm. A “rather not” weighs more than a “want it” (−3
  against +2) — on a shared day, reluctance costs more than mild approval —,
  but remains outvotable.
- **Heart wish with a quota**, about two per three days and at least one. It
  weighs so much that no plausible sum of ordinary votes tips it, but it is
  finite: “as long as it is physically possible” means the solver must still be
  able to fit it in.
- **The fairness account is derived, not booked.** Whose wishes ended up on a
  day is already in the plan; a second counter next to it would be a copy that
  eventually diverges. Whoever is furthest behind gets a small bonus in a tie —
  small enough that it only decides ties — and the sentence for it reads
  “heute ist mal wieder X dran” (today it's X's turn again).
- **Two kinds of vote.** An account or a vote kept on someone's behalf (§6.1,
  small children) — technically the co-travelers from §3.5. Who cast it is
  recorded; it is counted as the child's.

**The screen is called “Wünsche”, not “Abstimmen”** (wishes, not voting).
“Abstimmen” promises a result that deliberately does not come out here: nothing
is decided and nothing is replanned by itself, it is said what one wants. And
it promised that result precisely to the person who plans alone — for one
person a vote is a menu item one does not tap. “Wünsche” fits in both cases:
alone they are mine, with five they are everyone's, and the sentence “noch
nichts gesagt haben: …” (haven't said anything yet: …) beneath it reads just as
right. The word is also already on the screen — the heart wish is its strongest
vote. Internally everything keeps its name: the mechanic *is* a vote
(`votes.ts`, `TripBallotView`), it is just that nobody who uses it needs to
know.

Two things that deliberately do *not* happen here: Voting does **not** replan
(thirty swipes would otherwise be thirty different trips — the screen has a
button for that), and a spot nobody has talked about is not devalued: Silence
is not rejection.

**Search instead of scrolling.** A pool of thirty or forty spots makes the list
right on the first pass and unusable on the second: “how did I vote on the
museum again?” otherwise means scrolling past everything else. The screen
therefore has the same search as the idea collection (§20.1) — always visible,
not hidden above the first row. It searches everything the row says anyway:
name and place name, the type of the place, day and block or distance, the note
— **and the names of the voters**, because “what does Alex actually want?” is a
question that only this screen can answer. What does not work, and
deliberately so: filtering by *votes*. A list that hides rows by their voting
result would be a ranking through the back door — exactly what this chapter
avoids. While searching, the sections about the stage as a whole (replan,
fairness, who is still silent) step back so that the row being searched for is
at the top.

**Noticed along the way and changed with it:** The solver filled a day up to the
budget limit with everything that still fit in — including a spot whose rating
had dropped below zero. But room in the day is no reason to go anywhere.
Candidates from the search always start positive, so the new rule excludes
exactly one case: the spot that the group has voted below zero. It is still not
a veto — enough “want it” lifts it back over the line.

### 6.2 Do We Need a Trip Leader?

**Yes — but as an organizer, not as a boss, and only for the preparation.**

Without a responsible person there is no defined state in case of conflicts. A
strong leadership role would be socially wrong, though: A vacation is not a
hierarchy, and an app that enforces one becomes a nuisance. The organizer
therefore gets exactly three special rights:

1. **Change the framework** — period, stages, anchors (§4.2).
2. **Invite and remove participants.**
3. **Casting vote** when the fairness account stays tied.

Everyone may do everything else: contribute spots, rate, suggest alternatives,
open splits, replan on the road. The organizer is initially whoever created the
trip; the role is transferable. Technically this fits into the existing sharing
mechanic (`albumShares`), to which the trip album is attached anyway.

**On the road there is no leader.** Whoever is on site may replan — a delay is a
fact, not a decision. If the group had to wait until the organizer pulls out
their phone, the mechanic from §5 would be worthless.

### 6.3 Concurrent Changes

Several devices, some offline, change the same plan — that is the most
expensive part of multi-user operation and deserves a clear decision: **The plan
is never overwritten as a whole.** What is written are fine-grained operations
(*delete stop*, *move stop*, *change constraint*, *contribute spot*), which the
server merges; operations created offline are buffered and applied on
connecting. Anyone who saves the whole plan as a document regularly loses the
others' changes.

It stays visible who changed what, with the ability to undo. Push for the group
already exists (`push`, `sharedalbum`) — it makes sense to use it sparingly: for
deletions, splits and moved meeting points, not for every re-sorting.

**Implemented:** `POST`/`GET /trip-planner/plans/:planId/ops`, `POST …/ops/undo`
(migration 0183). The endpoints were fine-grained from the start — each changes
exactly one thing. What was added is what a device without a connection needs:

- **A batch is submitted and applied in order**, each operation against the
  trip as it is *now*. Two people who hid different spots both find both hidden
  afterwards — exactly what gets lost when the plan is saved as a document.
- **Said twice is done once.** Each operation carries an id generated on the
  device; the connection dropped in the middle of a request is the case this is
  for. The second arrival is reported as a duplicate, not applied.
- **A failed operation does not topple the batch.** Throwing away nine good ones
  because the tenth referred to a spot that someone has meanwhile removed would
  be the worst of both worlds. A *formally* wrong batch, on the other hand, is
  rejected completely beforehand — aborting midway would leave a trip that is
  neither the old nor the new one.
- **The journal is what happened.** Undo writes a new entry, deletes none. The
  name of the spot is recorded when applying, because hiding takes it out of the
  pool — a journal that can afterwards only say `way:34` is a log.
- **Not everything has an inverse, and that is said.** Putting a stop back into
  the pool recalculates the day around the gap; planning something similar into
  roughly the same place would be a new decision in the guise of the word
  “undo”. The call refuses with that reason.

### 6.4 Detecting Automatically That a Spot Is Done

Three signals, two of which come at no extra cost:

1. **Dwell.** Geofence around the spot, radius according to object size (viewpoint
   ~50 m, park ~300 m), and what is decisive is the **dwell time**, not the
   entry: walking past a museum is not a visit. Threshold about ten minutes or
   a quarter of the planned duration; higher for spots that lie on the way
   between two others.
2. **Photos.** Trip Mode collects shots with place and time anyway, and the POI
   matcher assigns them to specific sights (`osm-admin/poi-matcher.ts`). If a
   photo hits the planned spot, that is the best conceivable evidence — and it
   costs nothing, because the machinery exists.
3. **Payment.** A receipt or a card payment within the time window (§10.6),
   especially for admission and food service.

**One signal yields a suggestion** (“were you here? ✓ / ✗”), **two signals set
the status silently** — mistakes are cheap to correct with a swipe gesture,
false alarms on the other hand are annoying.

More valuable than ticking off is the reverse: **also detect unplanned
stays.** *“13:40–14:20 you were here — adopt as a stop?”* That way the app
records the actual day instead of merely ticking off the planned one, and the
travel journal (§3.6) writes itself.

Done is **per person** here, not per group — otherwise the assignment falls apart
at the split (§6.5), and the history would later not know who saw the temple.
The visits are visible **to all trip participants** (decided, §15.4): After a
split it must be clear what the other branch has seen, and the shared journal
should be right. Only the event “X was at spot Y” is shared, never a live
location; it can be switched off per person (then the stop appears to the others
merely as done, without a name); and the visibility ends with the trip. A live
map with the family's dots is a different product.

**From field testing: the wishes on the map (implemented).** The list says in
words what and where; the map says it at a glance — three “want it” in the same
alley are a morning, the “rather not” on the other bank an afternoon nobody
wants. The ballot therefore has the same toggle at the top as the pool (§5.2):
list or map. The map is the pool map with one's own answer as the color (open,
want it, heart wish, don't care, rather not), the search applies to both, and a
tap on a pin opens the same row as in the list — three answers, the heart and
the details behind the info button —, freshly read from the ballot so that the
vote just cast also shows on the map (`TripBallotMap`).

### 6.5 Splits: Traveling Apart, Planning Together

The case is more common than one would think: One goes to the technology
museum, the others to the market; one parent stays at the hotel with the
sleeping child; different return journeys.

**A split is a block attribute, not a second trip.** Instead of a sequence of
stops, a block gets two or more **branches**, each with its own set of
participants, its own sequence and its own budget. All branches start at the
split point and end at the **meeting point** — and that is a real fixed point
with a clock time in the sense of §4.4. Backwards from the meeting point the
budget of each branch follows, and the existing solver simply runs *n* times.
No more mechanics are needed.

**The planner should actively suggest splits.** If the votes on two spots
diverge widely, the usual compromise — both halved, or one dropped — is worse
than the separation:

> *“These two spots split the group. You could separate in the morning
> and meet again at the market at 1 pm.”*

This is the point where the vote data from §6.1 shows its real benefit: **The
split is conflict resolution instead of compromise** — the cheapest way to
fulfill everyone's wish. It therefore also consumes no heart-wish quotas. Who
belongs in which branch is suggested by the planner based on the votes; it is
decided by hand.

Further:

- **Replanning** happens per branch. If one is delayed, the meeting point shifts
  for everyone — exactly here a push makes sense (“Branch B needs 20 minutes
  longer”).
- **Done** applies only within one's own branch (§6.4).
- **Limit:** Splits run within one block, at most across one day. Anyone who
  separates for three days plans two trips — that needs no special logic.

**Implemented:** `GET /trip-planner/plans/:planId/splits/suggestion`,
`POST …/splits`, `POST …/splits/remove` (migration 0184: `trip_plan_branches`,
`trip_plan_branch_members`, `trip_plan_stops.branch_id`).

The mechanic is exactly the one described above: All branches start at the
split point, end at the meeting point, whose clock time is a fixed point in the
sense of §4.4, and the existing solver runs *n* times — with the meeting point
as the return point, so that each branch gets its budget backwards from the
meeting point and the two branches have different amounts of time if they go in
different directions. The wish the split was about goes into the solver with a
head start; the solver fills the rest as it does any other block.

Three things that the service additionally fixes:

- **Suggested from the votes, decided by hand** (§6.1 pays in here). Only the
  pair that divides the group *disjointly* is suggested — if someone wants both,
  it is a ranking problem and not a split, and separating would be mechanics for
  their own sake. If everyone agrees, the planner says nothing: the difference
  between a suggestion and nagging.
- **Nobody is in two branches**, and a split has at least two of them.
- **Under half an hour, separating is not worth it** — then the call says so,
  instead of planning a branch in which nothing fits.

A split consumes no heart-wish quotas (§6.1) and may be opened by anyone who is
traveling along (§6.2).

### 6.6 What This Changes in the Data Model

In addition to §12: `trip_members` (person, role, whether kept on someone's
behalf) · `plan_votes` (person, candidate, rating, heart-wish flag) ·
`member_fairness` (fulfilled and deferred wishes per person and stage) ·
`plan_branches` (block, set of participants, meeting point and time) ·
`plan_stops.branch_id` · `stop_visits` (person, spot, from–to, source:
geofence / photo / payment / manual) — the latter is at the same time the
foundation of the travel journal.

## 7. Location, Weather and Light

Three environmental signals that shape the plan. All three are coarse enough to
fit the block division, and none of them forces a clock time.

### 7.1 Location

The app knows the location and uses it for four things:

- **Replanning without tapping.** Instead of pressing “we are here, it is now”
  by hand, the app notices on its own that the group is still at the second of
  four spots while the block is half over, and **offers** a redistribution.
  Offered, not carried out — rearranging unasked would be overbearing.
- **Done detection.** Dwell time at the spot sets the status by itself and feeds
  the travel journal — the signals, thresholds and pitfalls are in §6.4.
- **“What is nearby?”** — spontaneous, without a plan, from the same pool.
- **Route estimation from the real location** instead of from the planned point.

**Technically battery-friendly:** no continuous GPS, but region monitoring
(geofences around the day's open stops) plus *significant location change*. iOS
wakes the app when needed; in between it costs practically nothing. Trip Mode
already fetches a `CLLocation` at start anyway.

*Added after field testing:* Originally the fences lay only around the next one
or two stops — “a fence you are not near is a wake-up that achieves nothing”.
The first travel day showed which day counts: The family strolled through town
without a plan, passed stop five, and nothing asked because only one and two
had a fence. Region monitoring costs the same for nineteen fences as for two —
the radio wakes up on cell changes anyway —, so they now lie around **all open
stops of the day**, up to the platform's limit (twenty per app, one of them the
accommodation, §4.2).

**Privacy:** For planning, the location stays on the device — the pool is
local, the redistribution computes locally (§12). It goes to one's own server
only when planning is shared; to the outside (weather) only rounded (§7.2).

### 7.2 Weather, Especially Precipitation

Per day and block: expected **precipitation amount** (mm), cloud cover,
temperature. For planning, three classes suffice — dry / some rain / wet — and
they work like this:

- Every spot gets an **indoor/outdoor attribute**, mostly derivable directly
  from the OSM tags (`tourism=museum|gallery`, `building=church` → indoors;
  `tourism=viewpoint`, `leisure=park`, `natural=*` → outdoors; market, castle
  ruin, cloister → partly).
- A rain block pulls indoor spots forward and pushes outdoor spots into the
  pool — exactly the mechanic from §5, just triggered automatically.
- The **block budget shrinks** when it is wet: with an umbrella and wet
  children one is slower.
- A rainy day moves as a whole: what would be wet today is swapped with a dry
  following day, as long as days are left.

**Heat counts just like rain.** 33 °C at high humidity shortens a day's walking
distance as effectively as a downpour. Temperature and humidity therefore also
enter into the block budget and push outdoor spots into the marginal times of
the day — which coincides naturally with the light window from §7.3.

**Beyond the forecast horizon, climate counts, not forecast.** Forecasts reach
about two weeks; for a trip that starts in eight months there are none. In the
trip resolution (§4.3) the planner therefore works with **climate normals** for
region and month — “September in Japan: hot, humid, typhoon season”. No daily
plans follow from this, but precautions: enough indoor candidates in the pool
and one unscheduled buffer day per stage. Only in the last two weeks does the
real forecast kick in day by day.

**Source:** [Open-Meteo](https://open-meteo.com) — hourly values for
`precipitation`, `cloud_cover` and `sunshine_duration`, without an API key and
without registration, worldwide — the same interface also delivers the climate
normals. For Germany alternatively Bright Sky (DWD). `open-meteo.com` must go
into the environment's network policy.

**What leaves the house:** exclusively a coordinate **rounded** to about 5 km
plus a date. That suffices for a city forecast and is no use as a movement
profile. The response is cached per place and day; one request per day is
enough.

**Implemented (step 9):** All four effects above are built.
The forecast itself (`weather-client.ts`, `weather.ts`, cache in
migration 0172) and the indoor/outdoor attribute (`shelter.ts`, migration
0173) supply the numbers; `POST …/weather` only says them. The re-sorting
and the budget cut are done by `weather-shuffle.ts`, the swap of whole
rainy days by `swapRainyDay` together with `weather-day-swap.ts` — both
**on request**: a `…/proposal` each, which calculates and saves nothing, and
an `…/apply`, which executes after asking and recalculates in the process
instead of replaying the proposal (§7.1: “rearranging unasked would be
overbearing”).

Both are *swaps*, not replannings, and both deliberately leave something
alone:

- Within a day the rest of the day stays as it was; done, skipped and pinned
  stops are never touched.
- In the day swap, **the framework stays with its date**: The last train
  leaves on Thursdays at 17:45, no matter what the sky does (§4.4). Only the
  spots move, block for block of the same name, and the routes are
  recalculated. If the two days are not cut the same way, the swap refuses
  instead of letting a spot drop out — that is a decision for the travelers,
  not a side effect of the weather.
- A day **without** a forecast does not take part in the swap, neither as the
  wet one nor as the target. “We don't know” is not “it will be dry” (§15.3).

**Climate normals** beyond the forecast horizon are answered by
`POST /trip-planner/climate-normal` from `climate-api.open-meteo.com` —
mean temperature, monthly precipitation and rainy days for region and month.
An honest caveat remains: For 1991–2020 the source delivers a **model
hindcast**, not a measurement series (an observation series would come from
`archive-api.open-meteo.com` and would need another host in the network
policy).

**Implemented: the consequences** (`climate-plan.ts`, `climate-precautions.ts`,
`GET /trip-planner/plans/:planId/climate`, migration 0186). Both halves of the
sentence from §7.2 are **limits** here, not functions:

- **No daily plans.** A monthly mean cannot say what Tuesday will do. None of
  this moves a spot, cuts a budget or swaps a day — that is the forecast's
  business, and only in the two weeks in which there is one. Beyond the horizon
  climate applies, within it explicitly not.
- **One buffer day per stage, never two**, and only if the stage has three days
  or more — otherwise it would come out of the only day there is, and the call
  then says so. It lies in the **middle**: The first day is usually arrival, the
  last departure, and a buffer there is not free time but the day that was half
  gone anyway. What is stored is the **reason**, not a flag — an empty day
  otherwise looks like one the planner failed to fill, and only the sentence
  tells the two apart.
- **Enough indoor candidates** is measured and **reported**, not enforced: How
  much of the pool still works in rain (partly covered counts — a cloister is
  exactly what a shower makes the right idea), and how many spots are missing.
  A number one can do something with, instead of “too few”.
- **If the climate service fails, planning goes on anyway.** A thirty-year mean
  is a convenience; a trip is not.

A stage that has nothing to prepare says **nothing** — a screen that reports
“all in order” for every stage trains people to skip it, and then it is not
there when it counts (§8.6).

### 7.3 Light: When the Photos Turn Out Well

The part that only a photo app would build — and the reason an evening block
shows up in the plan at all.

**The position of the sun is pure calculation, no API.** From coordinate and
point in time, height and azimuth of the sun follow (standard formulas, as
implemented e.g. by SunCalc; accurate to fractions of a degree). This runs
deterministically on the server **and** offline on the device. From it:

- **Golden hour** — sun height roughly −4° to +6°: warm, low light.
- **Blue hour** — roughly −6° to −4°: lit buildings against a blue sky.
- **Harsh midday sun** — high position: steep shadows, usually the worst moment
  for facades, but good for courtyards and water.

**Linked to the specific spot**, this becomes a statement instead of a
generality:

- For buildings, the OSM geometry yields the **orientation of the main facade**
  (normal of the longest edge of the polygon). If the sun stands in this
  half-space, the facade is front-lit — a west facade, then, in the evening.
  **Note, this does not work yet today:** The import reduces areal POIs to their
  centroid (`geo/src/osm2pgsql.lua`, `as_polygon():centroid()`), the polygon is
  lost afterwards. The facade azimuth must therefore be **computed once at
  import** and carried along as a column on `osm_pois` — cheaper than storing
  the polygons permanently, and needed only once per object anyway.
- For viewpoints, OSM often carries `direction=*`; otherwise the **viewing
  direction from one's own photos** helps: the POI matcher already processes the
  EXIF compass heading (`GPSImgDirection`) (`osm-admin/poi-matcher.ts`).
  Whoever looks west has backlight in the evening — sunset or glare, depending
  on taste.
- **The terrain cuts off the window.** The calculation above assumes a free
  horizon — in a valley, behind a ridge, or in a city with a steep slope, the sun
  is gone long before the astronomical sunset. Without correction the planner
  promises golden light at 19:30 while the viewpoint has been in shadow since
  19:00 — an error in exactly the unpleasant direction. The remedy is a
  **precomputation like the facade azimuth**: determine once per spot, from a
  free elevation model (SRTM, Copernicus), the **horizon profile** — what
  terrain height lies in which compass direction — and cut off the light window
  where the sun height falls below it. At runtime that costs nothing, it is a
  comparison of two angles.
- **The cloud cover from §7.2 modulates the whole thing:** with a closed cloud
  deck the golden hour is worthless, but the diffuse light is ideal for
  courtyards, forest, details and facades without shadow edges. With a clear sky
  the reverse applies.

**How it flows into the plan — deliberately restrained:**

1. **Order within the block.** The viewpoint slides to the end of the
   afternoon, the shady alley into the midday hours. Costs nothing, does not
   change the selection.
2. **A small ranking bonus** when a spot competes in the pool anyway.
3. **A suggestion for an evening block**: *“The viewing terrace lies in the best
   light today from about 7:30 pm to 8:10 pm — schedule it as an evening
   appointment?”*
4. **A hint on the spot card**, nothing else.

**Implemented (all four ways):** The ranking bonus (2) and the hint on the spot
card (4) were already there; now the two remaining ones are added.

**The order within the block** (1) is calculated by `light-order.ts` — pure, and
with both halves of §7.3's sentence as rules: The **selection stays
untouched** (only the sequence may change; what the day contains is decided by
the ranking bonus in the pool), and it must be **free** — a new arrangement is
accepted only if the extra distance stays within a small budget and the block
still works out. Measured bluntly: by how many minutes the middle of the stay
misses the window. Up to six stops exactly over all permutations, above that by
neighbor swap — the same limit the solver draws for the route.

Two subtleties that turned up while building and both went in the unpleasant
direction: The window is chosen **per block**, not per day (a west facade also
glows at dawn, and the globally best window would have pulled an afternoon stop
toward five in the morning), and the sun is calculated in the **local time of
the destination**: Block times are the destination's clock (§4.4), and a
comparison against UTC would have sorted the viewpoint in Munich two hours too
early. If the caller names no offset, the longitude estimates it — fifteen
degrees per hour; imprecise at the zone edges and without daylight saving time,
but right on the question that matters here: whether the golden hour lies
before or after the afternoon.

**The evening block suggestion** (3) is `GET …/plans/:planId/light/evening` and
the screen “Abendlicht” (evening light): the best window **of this evening** —
not of the day — for a spot marked as a photo stop, and only if it lies after
the planned day and is within reach. The call **writes nothing**: It is accepted
by a tap, and that creates an ordinary fixed point (§4.4). An evening
appointment is not a new concept, and giving it its own mechanic would mean
being able to get the same rule wrong in two places. **One** is suggested: An
evening carries one outing, and a list of five would be a decision instead of
a hint.

**Changed (2026-09-17): the evening appointment is a block, not an appointment
next to it.** The paragraph above justified the ordinary fixed point by saying
an evening appointment is not a new concept. That argument kept the server
simple and gave the calculation to the traveler: The appointment stood as a row
in the “Feste Zeiten” (fixed times) band, the spot stayed in the pool or in an
afternoon block — **two places for one evening**. And the appointment did not
know it was a spot: no pin, no ticking off, no note, and the pool considered the
terrace unplanned, so that the next replanning could place it a second time, in
the wrong light. The app had, on top of that, never sent the coordinate along.

Now the fixed point **frames** the last block of the day (`block_id`,
`spot_ref`, migration 0202): `scheduleDay` puts this block onto the light window
— start with the way there, length of the window — and the planner places the
spot into it at every planning and replanning as a **pinned stop**
(`frame-spots.ts`). Three rules, all about the solver keeping out: The framed
block is filled only by its spot (the solver sees it without a budget), the spot
is reserved before the first day (otherwise Tuesday afternoon takes it first),
and the stop is pinned (a redistribution moves the solver's choice, not what
someone accepted at a clock time).

One place: The block “Abend · 20:10–21:00” (evening) with the terrace in it,
numbered on the map, tickable, with note and photo-stop mark. The band does not
show framed fixed points; the block carries its frame as a row with the one
button to take it off again. Hiding or putting back the spot takes the frame
with it and replans the day; moving out of the block is refused, with the hint
to take off the appointment first. The fixed point remains the element with the
clock time (§4.4) — it just sits at the block now instead of beside it.

That the light window is accurate to the minute while the plan stays coarse is
no contradiction to guiding decision 1: It is a **hint, not an appointment**. A
clock time one can miss only arises when the user accepts suggestion 3 — and
then they wanted it themselves. Switchable off with one toggle, because not
every trip should follow the position of the sun.

**Implemented (step 9):** Of the four ways above, two are built.

- **Way 4, the hint on the spot card** (`sun.ts`, `light.ts`,
  `POST …/light`, facade azimuth in migration 0171) — and the same
  hint at the time slider of the day map (§8.3), which says for every
  time of day which window is currently running. Without a date it says
  *nothing*, instead of claiming “no special light window”.
- **Way 2, the small ranking bonus** (`scoreForLight`) — and it applies
  **only to spots that someone has marked as “Fotostopp”** (photo stop). That is
  a correction to §7.3 from field testing: The route is planned by
  ways, period; light is the exception, and an exception that
  applies to everything is none. A bonus for every spot only lifts
  the whole field anyway and changes nothing but the arithmetic — a mark at
  *one* place, on the other hand, is a statement that someone really
  made.

  The toggle sits at the spot (pool as well as plan) and lies next to the
  note in `trip_spot_notes` (migration 0175) — for the same reason as
  the note: A stop row does not survive a replanning, “we go here
  because of the evening light” does. Two restrictions remain even
  at the marked spot: It needs a known **facade azimuth**, and
  only a **golden** window is rewarded, frontal (+0.75) or
  grazing (+0.4). A spot recorded as a node gets nothing, not even
  when marked — nothing can be said about the sun on an outline that nobody
  knows.

**Way 1 (order within the block) and way 3 (evening block suggestion)** are
meanwhile built — and with them the **generator of the horizon profile**,
which makes them defensible in the first place. `horizon.ts` lays a fan around
the place: 24 directions, eleven distances from 100 m to 22 km, and per
direction the largest angle that anything occupies is kept. The heights
come from the Copernicus elevation model via the elevation API of
Open-Meteo (`api.open-meteo.com`, the same host as the forecast —
the network policy needs nothing new, and 90 m per pixel is
coarse for a wall and right for a ridge).

Two corrections are not optional at these distances: The **earth
curves away** (flat ground 20 km away lies about 30 m below
the tangent plane — without that every plain would read as a ridge), and
the **air bends the light downward**, for which the usual approximation
is an earth enlarged by 7/6. A hole in the elevation model is
skipped and not read as sea level (§15.3); a direction
without any measurement is missing from the profile, and the reader
interpolates across it — guessed between two measurements instead of freely
invented.

Who computes when is a deliberate separation: The profile belongs to the
**place**, not to the trip, is determined once per 100-meter cell and has
no expiry date — the ground does not move. It is calculated at
**light retrieval** (day map, evening light), with a budget of 3 seconds and
a free horizon if it takes longer; **planning only reads**. A
family adjusting the pace of their trip should not wait for an
elevation model just so two stops swap places — and because the
day map is opened anyway, the profile is usually long there already.

## 8. How This Feels in the iOS App

### 8.1 Entry
In the existing **Trip** tab, a second area **“Planen”** (plan) is added next
to “Aufnehmen” (record; Trip Mode). Both are views of the same trip: first plan,
then adjust and photograph on the road, afterwards the review.

### 8.2 Input
A text field plus chips for what the LLM should not guess:

```
„4 Tage Lissabon, mit Oma, wir mögen Aussicht und gutes Essen,
 kein Auto, entspanntes Tempo"
```

→ translated by the LLM into a **strict JSON constraint object** and shown as
editable chips: `Ort: Lissabon` · `4 Tage` · `Modi: Fuß, ÖPNV` ·
`Tempo: entspannt` · `max. 4 km Gehstrecke/Tag` · `Interessen: Aussicht, Essen`.
Nothing is assumed silently. Detected documents are suggested:
*“I found a hotel booking for this period — use as the basis?”*

### 8.3 Result
Per day one **card per block** (morning / midday / afternoon / evening),
containing the spots as a compact row with reference image, estimated stay
duration and route symbol in between. Below, a utilization display: “approx. 3 h
of 3.5 h”. Map view with numbered pins per day. “Why here?” expandable per
spot.

In addition a **time slider over the day**: While sliding, the sun moves along —
and at the same time the marker for **where you would be at this hour according
to the plan**. This turns the light hint (“best time approx. 19:30”) into
something verifiable instead of a claim, and the day plan incidentally gets a
spatial preview. Both are calculated anyway — sun position (§7.3) and block
times (§4.1) —, the slider merely makes it visible and connects two chapters
that otherwise run side by side.

### 8.4 Negotiating
- Swipe a spot → **replace** (alternatives from the pool that fit into the same
  time budget) or **back into the pool**.

  **Implemented:** `POST …/stops/to-pool`. The spot leaves the day, the day is
  recalculated, and the spot comes into the pool with the same return bonus
  that §5 gives a displaced one. The gap is **not** filled — taking a spot out
  is not a request to rebuild the afternoon; that is the redistribution, and
  that one gets asked for. Together with §5.1 this puts two different sentences
  side by side: “not today” (back into the pool) and “not on this trip” (hide).
  What is already ticked off does not go back: Done is the beginning of the
  travel journal.

  **Noticed along the way and fixed with it:** The origin of a spot (“found by
  myself” vs. “suggested”, §9.2) lived only on the pool row, and that is deleted
  as soon as the spot lands in a day. Every redistribution rewrote the pool —
  and in doing so turned every own find into a search hit. Consequences: The
  next settings change deleted it (a replanning keeps exactly the rows whose
  origin is *not* “search”), the app offered “hide” instead of “remove”, and
  note and link of the find were gone. The origin now sits on the stop itself
  (migration 0178) and survives the way through the day.
- Pin (📌) → fixed point.
- Drag between blocks and days → budgets recalculate immediately, an overfull
  block turns red.
- Chat for everything that cannot be dragged.

**From field testing: ticking off from the map (implemented).** Whoever tapped a
pin on the day map saw everything about the stop and could not say just one
thing: that they had just seen it. The sheet behind the pin now offers the same
as the row's menu — Done, Skipped, and for a ticked-off stop “Doch wieder offen”
(open again after all) —, the same write, no replanning. The sheet closes, the
pin changes color: that is the confirmation.

**From field testing: every way to the spot can do the same (implemented).** The
map could tick off and hide, but not move; the list could move, pin and put
back, but not hide; the detail view behind the map could do nothing at all.
What was possible depended on the way one had come. Now the actions of a spot
arise in one place — one list for scheduled stops, one for candidates — and
menu, detail view, pin sheet and the detail view behind it show the same one.
Differences come only from the state (done things are not moved, only
candidates are scheduled). “Für später merken” (save for later) also exists
for scheduled stops as a result: a copy into the idea pool, the stop stays where
it is. The rule is in the project instructions for future changes.

**From field testing: the past is not a target (implemented).** On the second
day, “In anderen Block verschieben” (move to another block) still offered day 1.
The block picker now leaves out what is over — yesterday entirely, and today
the blocks the clock has passed —, as soon as the trip has a date
(`TripBlockTargets.all(…, now:)`). A trip without a date has no today and
therefore no yesterday either; there every block remains selectable. The same
applies to “Einplanen” (schedule) from the pool, because both use the same
picker (§8.4).

### 8.5 “Today” Mode
The most important screen on the road: current block, what is still in it, how
much budget is left. A big button **“umplanen”** (replan; see §5) and per spot
a swipe for “erledigt” (done) / “übersprungen” (skipped) — the latter often
already sets itself at the location. Above the block a slim band with rain risk
and, if something lies in good light today, the light hint. Navigation via
deep link to Apple Maps.

**Correction from field testing: “Today” is not a separate screen, but a
mode.** Built as a second screen next to the day plan (§8.3), the seam was in
the wrong place: One half of the actions worked only here, the other only
there, and whoever used the planner jumped back and forth for tasks of the same
afternoon. §8.3 and §8.5 describe **two modes of a day**, though, not two
screens with different capabilities.

Hence: **one day screen that knows whether one is standing in it.** If a trip
is running and the day on screen is today's, the running block is marked
(“jetzt”, now), carries “Ab hier umplanen” (replan from here) together with its
reason and the list of what went back into the pool, and every spot offers what
one reaches for on the road: done, skipped, and the way there. If no trip is
underway, the same screen looks as before — the route to the spot then becomes
“show on the map”, because directions from home to a café in three weeks is a
number nobody wants.

**And the app opens where you are:** If a trip is running — trip mode on or a
planned day whose date is today —, the app starts in the trip tab on the day
plan of the running day instead of the feed. Once at start, not later: A screen
that moves under the thumb is worse than one that starts wrong.

**From field testing: the day did not move (stage 12, implemented).**
Four days in Malcesine, arrival entered for 12 o'clock, actually at the hotel at
5 pm. The app asked nothing, replanned nothing, and the Live Activity showed
“Mittag bis 14:00 · unterwegs” (midday until 14:00 · on the way) the whole
afternoon. Four causes that together made a static day, although place and time
were changing the whole time:

1. **The Live Activity was only updated in the foreground** — a counter every
   60 seconds in `ContentView`. In the background no impulse came: no
   `staleDate`, no refresh on geofence or location events. Now every content
   carries the block end as `staleDate` (iOS then shows it as outdated instead
   of as truth, §15.3), and **every waking of the app updates it**: fence
   entered, fence left, significant movement.
2. **The replanning prompt from §7.1 was built and connected nowhere.**
   `TripArrivalHeuristic` — “what is left no longer fits into what is left” —
   had tests and no caller. `TripBehindCheck` now puts the question to it from
   the day and the minute; the answer is a card above the block (“The 2 open
   stops still need about 80 minutes, the block has 30 left. Replan?”) and, if
   the app is not in front, a notification with “Umplanen” (replan) and “Später”
   (later). Once per block, as the concept demands.
3. **The late arrival noticed nothing.** The planned arrival was the frame of
   day 1, but no rule compared it with the day as it ran. The location service
   that wakes the app in the background was started and never read. Now the
   lived day has a **fence around the accommodation** (150 m, or the radius of
   the zone), and `TripLateArrival` is the rule of arrival day: planned arrival
   more than half an hour past, nothing ticked off yet, the phone at the
   accommodation — “Arrived at 17:05 instead of 12:00. Replan the day from
   now?” Before the fence the app only asks the open question (“Seid ihr schon
   da?”, are you there yet?) and only as a card, never as a banner: a
   notification on the highway would be the nagging from §6.4. And as long as the
   accommodation has not been reached on arrival day, point 2 stays silent —
   “you're lagging behind at midday” is true on the highway and useless, and a
   redistribution from there would plan the afternoon around a rest stop.
4. **The day screen had no clock.** “jetzt” (now) on the block was computed at
   drawing time and never again. It now ticks every minute as long as the day on
   screen is today's — and asks the day whether it has something to say.

**“Replan from now” after a late arrival** is the same redistribution as the
button on the block, with an addition on the server (`arrivedLate`): The blocks
that the day has run past did not take place. Their planned stops go back to
the candidates — with the bonus of the displaced — instead of standing as a
morning that never was; ticked off or skipped stays. Only this day; the other
days of the stage stay as they were. (Changing the arrival time across the
stage would have re-solved all four days.)

Two things remain deliberately open. **The Live Activity in a museum**: Whoever
stands inside for two hours does not move and is not woken; the content is then
marked as outdated, but not renewed. *(Added later, implemented: see “The lock
screen while the phone sleeps” below.)* And **the fences now belong to the
trip, not to the screen**: Until now they fell as soon as one left the day plan
and stayed only as long as one looked at it — a fence that reports nothing in
the background because it never stood there.

**Added later: the lock screen while the phone sleeps (stage 12b,
implemented).** The open spot from stage 12. The app now requests the Live
Activity with a push token (`pushType: .token`) and gives the token together
with the time zone to the server (`POST …/plans/:planId/live-activity`). The
server calculates the same content as the app (`live-activity-content.ts`, line
by line `TripDayActivityContent` and `TripDayTimeline.position`) and sends it
every five minutes, **if it has changed** — at every block boundary with high
priority, at a change of stop within the block with low priority. After the
last block of the day it ends the activity and forgets the token; a token that
Apple no longer knows drops out as well, and none lives longer than 30 hours.

The app remains the more accurate source: A fence knows at which stop one
stands, the clock only guesses. The server therefore speaks only when *its*
answer changes, and does not interject to the phone every five minutes. The two
calculations must stay equal — whoever changes one changes the other; the tests
of both sides play through the same cases.

**Added from the review after field testing: the fences survive the app.** Three
errors that together can explain why not a single stop was detected on the
first day:

1. **After a quit, the app knew nothing of its fences.** iOS keeps the fences
   when it terminates the app in the background, and restarts it as soon as one
   is crossed. But nobody set up the location service at launch — only the day
   screen did that —, and even then plan, stop behind the fence and the arrival
   time of an open stay were missing; everything lay only in memory. Now the app
   launch sets up the service immediately (`TripLocationLaunch.resume()`), and
   the monitor writes its state away at every change (`TripVisitMonitorState`)
   and reads it back at launch. Likewise a wake without a screen asks for the
   running trip itself instead of waiting for the tab bar, and the Live Activity
   takes over that of the last run instead of overlooking it.
2. **The fences followed the screen, not the day.** Whoever looked at tomorrow's
   day at breakfast took the fences off today's stops. And the next morning they
   still stood around yesterday until someone opened the plan. Now they belong
   to the lived day: every wake sets them there (`TripVisitMonitor.follow`), the
   screen does not touch them on the road.
3. **On teardown, things were forgotten before being reported.** A stay that was
   still open when a fence was torn down should be reported — but the
   assignment had already been deleted, and the report fizzled out.

**From field testing, second day: nothing gets lost, and the app asks (stage 13,
implemented).** On the first day not a single stop was ticked off — the family
strolled through the town without a plan, as families do. The next morning the
stops still stood as “planned” on a day that was over, and the following days
had been planned without them: “the spots are lost”. And the question: would the
app have spoken up if one had happened to pass one of the spots?

Three gaps, all between concept and code:

1. **The rule from §5 applied only when replanning.** “Nothing is deleted,
   everything moves back into the pool, with increased priority for the
   following days” — only whoever pressed “replan” got that. Now there is
   `POST …/days/carry-over` (`carry-over.ts`): The open stops of a day go back
   with the bonus of the displaced into the stage's pool, done and skipped stay
   as a journal. The app offers it the morning after — a card on today's day, a
   banner at the first wake —: “From day 1, 5 spots were left over: A, B, C … —
   back to the candidates? Then they come first on the next days.” Offered, not
   done (§7.1). The next “Ab hier umplanen” and every day that gets fully
   planned then takes them first.
2. **“Wart ihr hier?” (were you here?) was written and never asked.** On a
   signal the server created the question as a journal line (`visits.ts`), the
   app sent the stay and threw away the answer. Now it reads the verdict: On
   “suggested” comes a banner with “Ja, waren wir” (yes, we were) / “Nein” (no)
   — at the moment one walks away from the place and still knows whether one was
   in it — and a card on the day screen. A no is remembered by the server
   (§6.4).
3. **“Two signals set the status silently” — the second half was missing.** A
   confirmed visit (two signals or a yes) now also ticks the stop off in the
   plan, instead of only standing in the journal.

What does not speak up, and why: **Walking past is not a visit.** Asking only
happens after a stay of ten minutes or a quarter of the planned time (§6.4).
Whoever strolls past the church is not asked; whoever stands in it for twenty
minutes is — at every open stop of the day, since the fences lie around all of
them and no longer only around the next two (§7.1, decided after the first
travel day).

**From field testing: ticked off means held (stage 14, implemented).**
A stop that was already ticked off could still be pushed into another block
when replanning — the day then told something that had not happened. And a stop
that the fence had ticked off in the morning still stood in the afternoon,
because the plan had it there. Two rules:

1. **Done does not move.** The redistribution, the weather swap and the
   carry-over already left done things standing; moving by hand
   (`POST …/stops/move`) now refuses it: “is already ticked off and stays where
   you saw it. Reopen first, then move.” The menu does not even offer “In einen
   anderen Block” (into another block) for a done stop.
2. **The time is remembered, and the fence puts the stop there.** Every stop
   now carries `doneAt` (migration 0212). A tap stamps the moment of the tap, a
   second tap leaves the first standing, “Doch wieder offen” deletes it. A visit
   that the device has confirmed — two signals or a yes to “Wart ihr hier?” —
   stamps the **arrival**, not the time of the report, and moves the stop into
   the block in whose time the arrival falls (`visit-place.ts`): behind what was
   ticked off before it, before what is still open. If the arrival falls in the
   lunch break or after the last block, the nearest spot block applies; if it
   falls on another day of the stage, the stop moves to that day. For this the
   app sends its offset from UTC along; an older app gets only the tick. A row
   shows the time next to the tick (“10:42 ✓”).

Only the observation of the device moves things. A tick by hand says “seen”, not
“seen now”: Whoever fills in the morning at dinner should not pull the morning
into the evening. Excepted are the stop around which an appointment has laid the
block (§7.3), and split blocks (§6.5).

Fixed along the way: Every saving of a day rewrites the stop rows, and the
reference of a journal entry to its stop was lost in the process. An open “Wart
ihr hier?” disappeared after a move within the same block, and a yes to it no
longer ticked anything off. The references are now re-set via the place.

### 8.6 The Evening Before: Travel Readiness and Packing List

Between “plan is set” and “first travel day” lies a moment in which the errors
are decided that would devalue the whole planner — and for which fk-encore
already has the parts. A **travel readiness check** goes through them on the
evening before:

- Are the **tickets and bookings** available as documents (§3.4)? If one is
  missing, now is the time to look for it, not on the platform.
- Is the **region database** of the first stage completely imported (§15.3)?
  Without it there is no pool on site — the worst conceivable failure.
- Is the **offline bundle** loaded (§14)?
- Have all participants **voted** (§6.1), or are you planning past someone?

None of this is new machinery; it is a list over existing states. Precisely
that is why it is worthwhile: The two errors that really spoil a trip — no map
material abroad, no ticket at hand — are both still cheap to fix on the evening
before.

**The packing list** falls out of the same knowledge almost incidentally, and as
the only one that is not generic: outdoor blocks plus rain forecast → rain
jacket; heat → sun hat and water bottle; a church with a dress code in the plan
→ long trousers; a light window in the evening → tripod; a child in the
fairness account → spare clothes. Not “ten things for Japan”, but derived from
**this** plan, this weather and this group. An extension, not core — but cheap,
because all inputs are already there.

**Implemented:** `GET /trip-planner/plans/:planId/readiness` and the screen
“Reisebereit?” (travel ready?) (in the trip menu). Both halves in one response,
because they come from the same rows and the same forecast.

Of the four questions, **three can be answered today** — whether the trip has a
date, whether the region databases of all stages are finished (plus, as a third:
whether the first day is already fully planned at all, §4.3), and whether
tickets and bookings are available as documents (§3.4). The ticket row has an
honest limit here: The app knows **which** papers are attached, not **which
would be needed** — a weekend by car needs none, and a list of what is
necessary exists nowhere. So: If something is attached, the row is green and
lists it; if nothing is attached although the suggestion finds candidates, it
is yellow (that is the cheap evening grab: it exists, only nobody attached it);
if the suggestion also finds nothing, it stays gray — then the app really does
not know. The fourth question remains open: Votes only come with multi-user
operation (§6.1). It is displayed anyway, as `unknown` together with the reason
— a check that quietly disappears is missed by nobody, and then nobody notices
that the app never looked. On the screen they are gray, not yellow: a question
the app cannot answer is not a warning, and presenting it as one trains people
to overlook warnings. The fifth row — **is the offline bundle on the device?**
(§3.9) — is not answered by the server at all but by the device: only it knows
what it has stored.

**The packing list** is a pure module (`packing.ts`): days with weather in,
items with reason out — no network, no clock, no database, so if necessary also
computable on the device. The rules are exactly those named above, plus “below
10 °C outside → warm jacket”, and each fires **once** and names the day that
triggered it (“Regenjacke — am 18.06. ist es draußen nass”, rain jacket — it's
wet outside on 18 June). More important than the rules is what the list refuses:
no rain jacket for a rainy museum day, no tripod for a golden hour in which
nobody wanted to stand (the photo-stop toggle decides, §7.3), and for a day that
no forecast reaches, nothing at all — a short list is better than an invented
one.

### 8.7 Afterwards
Planned versus actually visited, photos per spot from the trip album, handover
to the recap.

**Implemented (two thirds):** `GET /trip-planner/plans/:planId/review` and the
screen “Danach” (afterwards) in the trip menu.

The tick list is the light half. The screen is built around the other one:
**unplanned stays are at the top, above the plan**, not below it — the travel
journal records them because, according to §6.4, they are the more valuable
half, and a pure tick list would throw away exactly them. Likewise kept apart
are two things that would easily collapse: *having been there* (journal) and
*ticked off* (day plan). A stop where someone stood without ticking it off says
both.

**Photos per spot** are a join, not a new pipeline: `photo_poi_matches` has long
bound a photo to an OSM reference, and the stop carries the same reference. Two
restrictions belong to it, otherwise the number counts the wrong thing — only
one's own photos, and only those from the travel period. Without the time
window every earlier visit to the same church would land in this trip's account.

**Added later: the handover to the recap.** Recaps arise from GPS clusters over
one's own media library (`documentation/recaps.md`) and derived their title from
the photos — city name, period, at best a sentence from the language model.
That is the right method as long as nothing else is known. Often, though,
something is known: A trip planned here has a name that someone chose, dates
that someone set, and named stages. If a photo cluster falls into such a trip,
its name wins — and the language model is not even asked in this case: A typed
name beats an invented one.

Deliberately narrow: **The plan supplies title, subtitle and a back-link,
nothing else.** Which photos belong to the recap is still decided by the photos
— they are the honest evidence of where someone really was, whereas a plan is a
declaration of intent, and exactly this difference is what §8.7 is about. The
time window is generous by one day on both sides: The journey there and the
morning after the return get photographed too.

The back-link is stored as `trip_plan_id` in the `seed` of the recap;
“Danach” reads it and shows the recap as soon as there is one. Before that there
is no deficiency displayed but a sentence: A recap consists of photos, and they
come before it.

The tone is deliberately not a reproach: “Ausgelassen” (skipped) is shown gray
and with a minus, not red with a cross. A day that went differently is the
normal case on which §5 builds in the first place.

## 9. Handoffs outward and inward

The division of labor from §3 becomes concrete here: **fk-encore plans, Apple
and Google navigate and rate.** That is not a stopgap but intentional: real-time
data and public opinion cannot be rebuilt (§10), day planning can.

### 9.1 Outward: what the app hands off

- **Navigation to the next stop** in the block's mode (on foot, public
  transit, car), **optionally with Apple Maps or Google Maps**; see the
  target-app choice below.
- **A whole block as a sequence.** Apple's `openMaps` takes an array of
  destinations, and the Google Maps URL knows waypoints, so not just the next
  point but the whole morning moves over in one go.
- **Look up a public transit connection**, exactly where our estimate is
  weakest (§4.1). The maps app has the real-time timetable, we do not.
- **Look up a spot in Maps**: ratings, interior photos, current opening hours.
  The deliberate compensation for what open data does not provide (§10).
- **Parking / park and ride** at the mode change of a car stage (§4.2).
- Related, without a maps app: `tel:` and `website` are available as OSM tags
  (reserve a table, ask about opening hours), and the fixed points of a day can
  be exported to the calendar via EventKit.

**The target app is a user choice, not a given.** Many people habitually
navigate with Google Maps, especially abroad, where its public transit data is
often better. Hence:

- A setting **"Navigation öffnen mit"** (open navigation with) with the values
  *Apple Maps*, *Google Maps* and *ask every time*; the default is Apple Maps
  because it is always present.
- Google Maps appears as an option only if it is installed, checked via
  `canOpenURL` on `comgooglemaps://`, which requires an entry in
  `LSApplicationQueriesSchemes` of the `Info.plist`. If the entry is missing,
  the check silently reports "not present" and the option disappears for no
  apparent reason, a classic stumbling block.
- The universal `https://www.google.com/maps/dir/` URL works as a fallback:
  it opens the app if it is there, otherwise the browser. That way the choice
  also works when the scheme check fails.
- **The mode has to carry over.** What is internally called "on foot / public
  transit / car" is translated per target app (Apple:
  `MKLaunchOptionsDirectionsModeKey`; Google: `directionsmode` or
  `travelmode`). A block planned on foot must not open as a car route, or the
  arrival time the plan calculates with will be wrong.
- The choice applies to **all** handoffs in this chapter, not only navigation:
  lookup, public transit connection and parking search follow the same
  setting.

### 9.2 Inward: bringing your own finds into the pool

The planner proposes candidates itself (§5), but your own research on the web
is the second, at least equally important source. It must not be a break in the
flow: whatever you find belongs in the pool with **one** gesture, where it
competes as a candidate with all the others.

**Four ways in**, in order of reliability:

1. **A place from a maps app.** The clearest case: there is a coordinate.
2. **An article or blog post.** The most common case in real research
   ("the ten best cafés in Lisbon"), and the hardest, because a page provides
   *no* coordinate but often names several places at once. Here the language
   model reads the page and pulls out the **place names**; the flow for that is
   in §9.3.
3. **A screenshot.** From an app that does not share, or of a map in a travel
   guide. Almost free, because the share extension accepts images anyway and
   the documents service already brings OCR (Tesseract); the text from it goes
   the same way as case 2.
4. **Search in the app.** Without a detour through other apps: search by name
   and put it straight into the pool. The simplest way, and it has to exist
   independently of everything else.

**The share extension** (`ios/F4milShare`, `Info.plist` under
`ios/App/ShareExtension`) initially accepted only images
(`NSExtensionActivationSupportsImageWithMaxCount`) and has been extended for
cases 1 to 3 with URLs, text selection and the page as read; the switch decides
based on what the share contains, so that sharing photos stays as fast as it
was. To be honest about it: extracting the coordinate from a shared maps link is
fragile, because the formats change without notice. The fallback is therefore
not an error dialog but a map with a request to confirm the place; after that, a
radius search with reverse geocoding (`geo/src/reverse.ts`) assigns an OSM POI,
or the point is taken over as a free point.

**What happens to a find afterwards**: five rules that keep the pool from
going to seed:

- **It lands in the right stage**, automatically by location: a café in Osaka
  goes into the Osaka stage even if you are currently in Tokyo. If it lies in
  none, you are asked.
- **It is a suggestion, not an appointment.** The find competes in the pool like
  any other candidate. Whoever definitely wants to go makes it a heart's desire
  (§6.1); that is exactly the purpose of that quota.
- **Duplicates are merged.** If someone suggests something that is already in
  the pool, no second entry is created: note, source and vote move to the
  existing one.
- **Origin and link are kept.** *Why* a spot was saved ("best pastéis according
  to a blog") matters more than the name when planning, and who contributed it
  visibly belongs with it (§6.1).
- **Missing data is named, not guessed.** If no OSM entry could be assigned,
  opening hours, category and duration of stay are missing. The planner then
  asks once for the estimated duration and marks the opening hours as unknown,
  instead of calculating with invented values.

**Added later: you can take notes afterwards, too.** Note and link initially
existed only as the origin of a find: whoever contributed a spot could say why
in that one moment, and afterwards nobody could say a word. But the sentences
that actually decide a morning ("entrance around the corner", "buy tickets
beforehand", "bring maps") are learned afterwards: from a blog, from the
family, because you stood in front of it once. Every spot therefore accepts
three fields that anyone can change during the trip (§6.2):

- **Title**: what *you* call the place ("the museum with the roof garden").
  This does not correct OpenStreetMap: the map name stays underneath, because
  that is the one that counts at the ticket counter.
- **Note**: why it matters, in your words.
- **Link**: the official page, the booking, the blog entry.

Writing happens against **stage and OSM reference**, not against the planned
stop row. Every replan deletes the stops of a day and writes them anew; a note
on the row would last exactly until the next settings change. The pair (stage,
place) is what a person means, and it holds whether the spot is currently in the
pool, on a day or nowhere.

**Done (2026-09-13): the fifth way, looking for yourself.**
The four ways above all assume that the research has already taken place: the
link is found, the article read, the name known. The question before that,
*what is there here at all?*, the region databases have been able to answer
since the first import, and only the solver asked it. A human got to the same
data exclusively via a name filter.

`POST /trip-planner/explore` turns that into a way for humans: a coordinate, a
radius, optionally a few interests from §8.1, and what comes out is what the
area has to offer, sorted by prominence instead of distance (the cathedral beats
the chapel next door). The name filter stays, but is no longer the only door.

Two properties make the difference:

- **No trip needed.** The search used to hang off `plans/:planId/search` and
  took center and radius from the stage. That was never a data requirement: a
  region is imported in region management, not when creating a trip. Center and
  radius now come from the phone or from a place someone picked in Apple's
  geocoder, and the find goes into the idea pool (§20), which has never needed a
  trip. This makes the pool fillable from the inside for the first time; until
  now only what someone had allocated into it came in.
- **Empty is not the same as empty.** A region not imported, a filter that is
  too narrow and an area without sights are three different answers, and the
  server says which of them applies. Nothing is imported automatically: an
  import is a background job of minutes to hours (§13.0), and a tap that
  silently triggers one answers a question with a wait nobody agreed to.

The interests are filtered **in the app layer**, not in the geo query: "castles
and palaces" is a set of OSM tags without a category of its own, and a query
narrowed by categories would lose exactly the castle that carries none.

**Done (2026-09-13): questions instead of filters.**
The interest chips answer "what kind of thing", which is what a category is
for. What someone actually asks while standing in the rain, they do not answer,
and that is exactly where the planner has something a maps app does not: it
derives from category and OSM tag whether a spot is afraid of rain (§7.2), and
it knows the duration of stay.

Three questions, each answerable from existing data: **in rain**, **in good
weather**, **just briefly** (≤ 30 minutes). "Partly covered" stays in and is
labeled instead of filtered away: a market hall or a cloister *is* half an
answer, and whoever is standing in the rain decides better for themselves
whether half is enough. Within the answer, the fully covered comes before the
half.

Deliberately **not** included:

- *"What is open on Monday?"* would need a parser for OSM's `opening_hours`
  grammar. The string is shown, not interpreted; half-understood is the road to
  a screen that promises a closed museum (§15.3).
- *"At golden hour"* needs a date and the time zone **of the place**;
  `lightWindows` says so itself. A planned day has both, an area search does
  not (§7.3).
- *"What still fits into Wednesday afternoon?"* needs a block with a budget, so
  it belongs to the search within a trip, not to a search that deliberately has
  none.

**Done (2026-09-13): the article can be read in the app.**
Case 2 is the most common in real research and was the one with the most
detours: open Safari, share, pick a trip. The pipeline behind it has been
complete since the share extension (§9.3): fetch the page, boil it down to text,
the model names the places, each name is resolved against the region. And it
hung off a trip.

What the trip contributed was **where the names are looked up**. A coordinate
can do that too: the area you are currently browsing (§9.2 case 4), and the
region beneath it. `POST /trip-planner/explore/article` is exactly this wiring
and nothing else; `articleProposals` now takes search areas instead of a plan,
and the trip supplies its stages as such.

The screen shows what the share shows, too: every place with **the sentence from
the article that put it on the list**. A suggestion nobody can check is one
nobody should accept. Three kinds, three consequences: resolved → a tip;
ambiguous → pick first; not found by the region → stays a note, is **not**
adopted, because an entry without a coordinate cannot be found again. The
duration is asked only where no OSM entry is behind it; otherwise the category
supplies it, and a default value would turn every museum into three quarters of
an hour.

**Addendum (2026-09-13): the missing region can be requested.**
"This area is not imported yet" was a dead end, although there has always been
a way out: when a trip is created, the planner requests the region itself
(`requestRegionFor`), with the same approval policy as region management: small
loads immediately, large waits for an admin. The search can now do that too,
via `POST /trip-planner/explore/region`, but **only on a tap**: the search
itself requests nothing, because an import takes minutes to hours and a tap
should not order a wait nobody agreed to. The screen says what became of it:
already there, currently loading, or waiting for approval.


**Addendum (2026-10-07): short links from the Google Maps app.** A
`maps.app.goo.gl/…?g_st=ic` link does not lead directly to a pin, but first to
`maps.google.com/?q=Name, Adresse&ftid=…`: name and address in words, an
identifier only Google can read, and no coordinate. The server followed exactly
one hop, found no coordinate and reported the link as unresolved; the share
extension then also discarded the name and did not offer "Meine Ideen" (my
ideas). Now the server follows up to four hops (also through Google's consent
page, whose `continue` carries the actual target) and returns name and full
search term (`query`). The extension then looks the place up in Apple Maps and
shows what it found ("Gefunden: Name · Adresse", found: name · address) before
saving; when sharing into a trip, the server resolves the name in the trip's
regions as with an article (§9.3).

### 9.3 Reading a web page

The path from a travel blog to candidates in the pool, in four steps. It is the
most laborious of the four ways and therefore deserves a description of its own.

**Step 1: Getting at the text, from the device, not from the server.** The
obvious approach would be to share only the URL and let the server load the
page. The better way runs through the device, however: a share extension can use
`NSExtensionJavaScriptPreprocessingFile` to run a small script **in the already
opened page** and hand over its visible text. That settles four problems at a
stroke on which a server fetch fails: JavaScript-rendered pages, cookie banners,
login or paywall, and bot blocks against data-center IPs. The user's browser has
already solved the hard part.

The server fetch remains as a fallback for cases where only a URL arrives (from
a message, say). The usual precautions then apply, which are named explicitly
here because a service that fetches **arbitrary user-supplied URLs** is a new
attack surface: `https` only, no private or link-local address ranges (not even
after a redirect, or someone points at the geo container or a metadata
service), time and size limits. The pattern for this already exists in the repo
(`osm-admin/wikidata-client.ts` with `AbortController` and timeout).

**Step 2: Exposing the article.** Navigation, ads, comments and related blocks
bloat the text and confuse the extraction. So isolate the article body
(readability technique) and cap the length. For the local model this is not
cosmetic: context is the scarcest resource, and background noise displaces the
content.

**Step 3: Extract, with evidence.** The model gets exactly one task and a strict
schema: a list of *name*, optional *location hint*, optional *category* and a
**verbatim quote** from the page. The quote is the trick: it can be checked
mechanically against the source text. If it is not literally there, the entry
is dropped; an invented recommendation does not survive this check. Extracting
is the friendlier task anyway compared to recommending: the answer is in the
text presented, which is why even a small local model is usable here.

**Step 4: Resolve names.** Each extracted name is resolved against the stage's
region database: normalized name comparison in the matching area, narrowed by
the location hint from the article. Three outcomes: **unambiguous** → candidate
with all OSM data; **ambiguous** → follow-up question with a map; **no match** →
note with link and quote, which stays in the pool until someone resolves it by
hand. Nothing is invented (§10.4).

This resolution is **the same task as merchant name → POI** from §10.6. Both
should share one building block: *name plus rough place → POI in this region*,
with the outcomes unambiguous / ambiguous / none. It is the only place in the
concept where two distant features have exactly the same problem.

**By the way, on model choice:** An article is public text. That makes this task
the **least problematic candidate for the API track** from §11, unlike the
curation, which sends preferences and group composition along. Only the result
is stored anyway, along with a short quote and the link, never the whole page.

### 9.4 The map in the app

The embedded map is MapKit, i.e. **Apple's map material**, whereas the factual
data (candidates, categories, opening) comes from our own OSM regions. Two
layers with a clear separation: Apple draws, fk-encore knows.

Useful and little known: **Look Around** can be embedded directly in the app via
`MKLookAroundViewController` since iOS 16. "Is this viewpoint worth it at all?"
can thereby be answered without switching apps, where Apple has data; otherwise
the button silently disappears.

### 9.5 The limit

No deep link returns anything. The app never learns whether you actually set off
or what you read on Google. Everything that happens after the handoff comes back
exclusively via location (§7.1), which is why returning to the app must
deliberately be cheap: a swipe gesture for "done", not a form.

## 10. Food, cafés and other everyday spots

The question of the data basis is the most uncomfortable here, hence a chapter
of its own.

### 10.1 The finding: open data knows existence, not opinion

OSM lists gastronomy reliably as **existence with properties**:
`amenity=restaurant|cafe|fast_food|bar|pub|ice_cream|bakery`, plus `cuisine`,
`diet:vegetarian` / `diet:vegan`, `outdoor_seating`, `wheelchair`, `takeaway`,
`opening_hours`, `phone`, `website`, address.

What is missing is everything evaluative: **quality, popularity, price level**,
and currency. Gastronomy has the highest turnover of all POI classes; an entry
from the year before last may long since be closed. Even the newer open
datasets (Overture Places, Foursquare Open Source Places) change nothing about
this: they deliver more existence and better categories, but no ratings. Public
opinion is effectively nowhere available as open data.

**The division of labor with §9 follows from this**, not as an excuse but as the
only honest solution: we provide structure, proximity and time, Google provides
the opinion, a finger tap connects both.

### 10.2 Today's import knows no gastronomy

Concretely, the data basis is still entirely missing. From `amenity`, the Lua
filter takes only `place_of_worship` and `theatre` (`geo/src/osm2pgsql.lua`); it
was built for **photo POI matching**, not for planning. Not a single café is in
`osm_pois`.

The extension is the third and largest of the import changes from §12 and
deserves two remarks:

- **It noticeably enlarges the region databases.** Gastronomy and everyday
  infrastructure are orders of magnitude more numerous than sights. Measure
  before the re-import.
- **It does not endanger photo matching.** The tag filters sit in the `WHERE`
  clause of `findPoiCandidates` and thus take effect **before** the `LIMIT`
  (`geo/src/pois.ts`): the matcher sends along its narrow defaults and never
  sees cafés, even if they are in the table. This order is the reason no second
  table is needed; it must not be lost in the rework.

### 10.3 Three levels of what the planner does with it

1. **In planning, only the frame.** The lunch block is time plus area ("lunch
   somewhere around B"), not a restaurant. That is the only statement that is
   certainly true, and the most useful, because it holds the afternoon together.
2. **On site, a filtered list, not a ranking.** Radius around the current
   location, filtered by what OSM reliably knows (cuisine, vegetarian, outdoor
   seating, accessible, roughly open), **sorted by distance**, not by a quality
   we do not know. Each entry with a button "in Karten ansehen" (view in Maps)
   (§9.1) and, where tagged, `tel:`.
3. **Own signals, where available.** Group votes; photos you took there; on
   request receipts and card payments (§10.6). Strong on repeat visits, usually
   empty; guiding decision 3 applies here too.

**Addendum (2026-10-05): A desired restaurant belongs in the meal block.**
The planner still does not pick a restaurant. But a restaurant that someone
brought in via "Ort suchen" (search place) and marked with heart's desire or
"will ich" (want it) is not the planner's choice; when replanning, it lands in
the meal block (one per meal, the best rated one whose route fits the walking
limit; over budget is shown, not prevented). On a day with a meal block,
restaurants no longer go into any sightseeing block, while cafés may still be an
afternoon stop. The same rule applies to manual placement: the block picker
offers a restaurant the meal blocks, a café both kinds, a sight only the
sightseeing blocks; the server (`move.ts`, `MEAL_CATEGORIES`) rejects anything
else. Before, "In diesen Block setzen" (put into this block) from "Essen in der
Nähe" (food nearby) silently failed on exactly this barrier.

The lunch block shows its stop like any other block and has two ways in: "Essen
in der Nähe" (the search on site) and "Aus den Kandidaten" (from the
candidates), as soon as a restaurant or café is in the pool. The candidate list,
opened for a block, shows only what is allowed into it: restaurants and cafés
for a meal, no restaurant for a sightseeing block.

### 10.4 The hard rule for the LLM

**The model may formulate exclusively from the candidate pool, never recommend
from its world knowledge.** A local model otherwise readily names venues that
never existed or have been closed for years: fluent, convincing and without a
source. A single invented restaurant damages trust in the entire planner, even
where it is right. In practice this means: every name in the generated text is
validated against the pool; whatever is not there is dropped.

**Added later: readable does not mean nameless.** Spots are now named the way
the travelers can read them: in Tokyo, "Nationalmuseum Beispielstadt" comes back
instead of 東京国立博物館, decided by script and never invented. That is the
right name for planning and the wrong one for standing in front of the
building: **the local name is shown alongside**, where it is a different one. In
Europe the field is empty, because the same line twice is no gain.

**Added later: the Wikipedia article.** The `wikipedia` tag has been read since
day one and so far counted only toward prominence: a place had an article or it
did not, and the article itself was thrown away. It is now carried along as a
finished URL (built once, so that pool, day and search do not each assemble
their own) and linked in the detail view. Without a language prefix in the tag
there is no link: guessing "de" for a place in Kyoto leads to an article that
does not exist (§15.3).

**Added later: the German name, where there is one.** The script rule above
only applies when the local name is *unreadable*; in Rome, `Colosseo` thus
remained, although `name:de=Kolosseum` is in the tag and nobody says anything
else in German. Now the German name wins even when both are written in Latin
script, and the local one moves alongside: "Kolosseum (Colosseo)", "Prag
(Praha)". In rows that have only one line (day plan, pool) it appears in
parentheses behind; where there is room for two, it stays at "Vor Ort" (on
site).

The rule is deliberately narrow: it applies only to places with a `wikidata` or
`wikipedia` tag. An exonym has something the world has written about; without
one of these tags, a `name:de` is usually the well-meant word-for-word
translation of a village church ("Kirche des heiligen Nikolaus" for
`Église Saint-Nicolas`) that appears on no sign and on no map the travelers
carry. Comparison is folded (`name-fold.ts`), so that "Cafe central" does not
pass as a different name from `Café Central`. English never gets this promotion:
`name:en` is often just a label for tourists. And `name:de` is not a translation
by us; it is what the mappers themselves entered (§15.3).

**Added later: the article in German.** The `wikipedia` tag names the article in
the **national language**; in Rome, the link thus leads to Italian. OSM has the
convention `wikipedia:de` for this (same place, the German article), and that is
now preferred. Where it does not exist, the local article stays and **the app
says beforehand which language it is in** ("der Artikel ist auf Italienisch",
the article is in Italian); the language is read from the address, not stored a
second time. We translate nothing: iOS offers "Übersetzen" (translate) when
reading. Guessing a German title from an Italian one would be an invented link,
and a link into nothing is worse than one in the wrong language (§15.3).

For existing trips nothing changes retroactively: names and article URL are on
the planned spot as they applied at the time of the search. Newly searched spots
carry the new rule.

### 10.5 Where the same data basis shines

Pharmacy, supermarket, bakery, public toilet, drinking fountain, playground,
bank, luggage storage: here **existence** is enough, nobody needs ratings, and
that is exactly what OSM does excellently. For trips with children or with
limited walking ability (§3.5) this is immediately useful and usable without any
reservation.

The data basis is thus strong exactly where **function** counts, and weak
exactly where **taste** counts. The planner should behave accordingly:
confident when finding a pharmacy, reserved with dinner.

**A separation follows from this that was missing at first** (reported:
pharmacies, discounters, savings banks and insignificant churches in the
proposed plan). Each category has a `purpose`: `visit`, where you go because you
want to see it, or `service`, where the trip depends on it but does not admire
it. A search without a category now returns only `visit`; whoever looks for a
pharmacy names `essentials` explicitly. Before, "no category" simply meant
*all*, and so ATMs and supermarkets were in the candidate pool of a morning.

Second: **a name is not a sign of significance.** Every savings bank has one. As
long as "has a name" went into the prominence, an ordinary village church scored
exactly like a bank branch, and both moved up once the worthwhile spots were
allocated. Now only Wikidata, Wikipedia and the explicit recording as a sight
(`tourism=*`) count as prominence; the latter is the judgment of a person who
stood in front of it. Whoever has none of these does not even get into the pool
from which a day is built: **a shorter morning is the better answer than a
filled one nobody wanted.** For "what is nearby" this does not apply; there the
ordinary is the right answer.

Third, `sight` was too broad: `historic` without a value list hits every
wayside cross, every boundary stone and every memorial plaque, thousands in a
German city. Now there is a list there.

### 10.6 Receipts and payments: what is realistic

Receipts and card payments as a signal are **thinly sown**, and the naive
implementation ("airline booking → flight → trip → place") is rightly
off-putting. But it is not necessary either: the path breaks down into two much
simpler questions, and the difficult direction is the wrong one.

**Flights: the document is the source, not the transaction.** A bank
transaction from an airline names merchant and amount, nothing more. No
destination, no flight times, and its date is the **booking date**, which is
months before the flight. Deriving a trip from that is hopeless. The booking
confirmation as a PDF, on the other hand, is already OCR-processed and
classified in the documents service and contains everything: flight number,
date, times, airports. It is the supplier of fixed points (§3.4); the
transaction is not.

**Conversely, the link is easy.** Once the document with amount, date and
airline is settled, the matching transaction is found with high certainty, and
the data model already provides for the connection (`receipt_document_id` in
`finance/transactions.ts`). Document → transaction, never transaction → trip.

**For meal suggestions, no trip assignment is needed at all.** All that is asked
is "have we paid here before?", for which merchant name and date suffice. The
difficult part is a different one: **merchant name → POI**. What is on the bank
statement is abbreviated, in capitals, often the payment service provider
instead of the venue and sometimes the corporate name instead of the shop sign.
An automatic match is the exception.

Hence two steps, and the first needs no assignment:

1. **In the travel journal** (§3.6), receipts and payments simply appear on the
   respective travel day. This needs only the period the trip knows anyway, is
   immediately useful and cannot assign anything wrongly. This also yields the
   **cost overview of the trip**, decided: the trip reports its costs itself
   instead of making them visible only in the finance area. It needs no
   bookkeeping of its own for that, only the sum over its period, broken down by
   days and, where confirmed (step 2), by places.
2. **As a planning signal only after confirmation.** If the user taps in the
   journal "that was the café at the market", the assignment is saved and
   applies automatically in future. This is the same pattern as naming faces and
   as duplicate review: suggestion, confirmation, learned rule. Without
   confirmation nothing is assigned.

That keeps the effort small and proportional to the benefit, which arises only
on repeat visits anyway. A sensible late step, not a building block for the
start.

### 10.7 Examined and rejected: ratings via API

An obvious question, hence the examination and its result here, so that it is
not reopened later.

**Technically it exists.** The **Google Places API (New)** delivers for a place
`rating`, `userRatingCount`, a few review texts, price level, current opening
hours and photos; search by text, radius or place ID. It needs an API key and a
billing account, has a monthly free quota and costs per query beyond that. For
a family system the volume would be no cost problem.

**Three reasons argue against it nonetheless:**

1. **The terms of use forbid exactly what we would need.** Places API content
   (with the exception of place IDs) may not be stored permanently, and display
   together with a **non-Google map** is prohibited. Our planner, however, lives
   on a **pre-rated pool** (§4.3) and draws on a MapKit map (§9.4). Both
   together are not possible. A ranking that has to be bought anew on every
   opening and does not exist offline is not a pool.
2. **It contradicts the core of the product.** Every query sends place, time and
   intent to Google, exactly what §3 identifies as the difference from Google
   Maps. A planner that asks Google in the background is a Google front end with
   extra steps.
3. **It makes the system dependent on someone else's key.** Pricing model,
   quotas and terms change; a self-hosted system should not fail because a
   billing account expires.

**The alternatives are no better.** Apple's MapKit search delivers places but
**no ratings**. Yelp has a usable API, but thin coverage outside North America,
of little help for Prague or Osaka. The TripAdvisor Content API covers tourist
matters decently, but demands a logo and a link at every display point and
restricts storage as well. Foursquare has ratings only in the commercial
service, not in the open dataset (§10.1).

**Result: no rating backend, but the finger tap.** The handoff from §9.1
delivers the same result without a key, without cost, without storage
restriction and without fk-encore itself becoming a data supplier to Google: you
tap "in Karten ansehen", see ratings, photos and current opening hours there,
and come back. This question confirms the division of labor from §9 rather than
opening a new path.

*Should that change*, for instance because a source with friendlier terms
appears, the most compatible form would be a **single, user-triggered query**
for one spot ("Bewertung laden", load rating), for display only, without
storage and without influence on the ranking. As a mass enrichment of the pool,
however, never.

## 11. When a frontier model is available

All decisions so far were made under one constraint: the only available language
model runs locally (§11.0). If the Claude API with **Opus 5** (`claude-opus-5`,
1M context, $5 / $25 per million input/output tokens) were available instead,
some things would change, but fewer than one might first suspect, and in a
different place than expected.

### 11.0 Which local model

The llm-service is **model-agnostic**: the active model is chosen at runtime and
persisted (`load_active` / `save_active` in `llm-service/main.py`), not fixed in
code. The local track is thus already interchangeable today, which makes the
decision from §15.3 (build two tracks) cheaper than it sounds.

**Currently loaded is `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL`** (as of 2026-09-02),
an instruction-tuned model with 26 billion parameters in total and around 4
billion active per token, trained quantization-aware and shipped in a dynamic
4-bit quantization. It replaced the Qwen2.5-7B documented here earlier.

**What this means for this chapter:** The assessments further down ("brittle for
a local model", "frontier model clearly superior") date from the 7B era and have
**not been re-measured**. A model of this size class should be considerably
closer to the API track than the table in §11.1 assumes for understanding
requests, structured output and reading web pages (§9.3). Before any decision
for the paid track, **the local one therefore has to be measured first**,
otherwise you buy quality you already have. Two quantities are to be checked
concretely: the usable context window (it decides whether a whole stage pool
fits in for curation) and the response time on the existing hardware (it decides
whether the model is bearable at all in the negotiation chat).

**For request understanding the measurement now exists**:
`trip-planner/llm-bench/` puts both tracks, with the **same** prompt and the
same validation (`normalizeConstraints`), in front of ten invented sentences and
counts four things separately: correct, missed, wrong and **invented**. The
fourth column deliberately goes into no overall grade: §13's rule "a missing
field is better than an invented one" means that a track that reads more and
invents more has not won. The sentences test not only the straight case but also
restraint ("Wir wollen nach Passau." (We want to go to Passau.), where anything
further would be invented) and traps (a year that is not a day count; a start
location that is not the destination). The cloud track is called by nothing
else: `claude-client.ts` is attached to no endpoint.

**The result (run of 2026-09-10, `gemma-4-26B-A4B-it-qat` against
`claude-opus-5`):**

| | correct | invented | median |
| --- | --- | --- | --- |
| local | **96 %** (26/27) | **0** | **1005 ms** |
| Claude API | 93 % (25/27) | 1 | 2173 ms |

**The track that costs nothing won**, and §11.1's assessment "brittle" is thereby
refuted for this task. Both tracks read the indirect cases cleanly
("Kinderwagen" (stroller) → child, "schlecht zu Fuß" (poor on foot) → limited
mobility, "eine Woche" (a week) → seven days), neither fell for the start
location trap, and both held back at "Wir wollen nach Passau." instead of
inventing a pace.

The two deviations both count against the cloud track, and both are instructive:
for "im Umkreis von zwei Kilometern um die Altstadt" (within a two-kilometer
radius of the old town) it wrote `placeHint: "Ulm Altstadt"` instead of
`"Ulm"`, meant helpfully, but the `placeHint` is an echo for the confirmation,
not a search term, and for "viel zu Fuß, aber keine Gewaltmärsche" (a lot on
foot, but no forced marches) it fixed a walking distance of 30 minutes that
nobody had said. Exactly the kind of well-meant addition that §13's rule stands
against.

Three caveats, so that the number does not carry more than it can: **27 scored
fields in one run**, so a difference of one field is noise, not ranking; the one
trap on which both failed ("keine Gewaltmärsche" → `relaxed`) is perhaps more a
disputed expectation than a model error; and the cloud track was measured at low
effort and without structured outputs, i.e. not at its upper limit.

**The consequence for §11:** Nothing is bought for request understanding. The
local model is on par, twice as fast and free, and the privacy calculation from
§11.5 does not even need to be opened for it.

**The second measurement: curation** (`run-curation.ts`, three requests over a
pool of 34 places, three tracks, because here the incumbent is not a model but
the weighted sum from `candidates.ts`):

| | misses | targets | median |
| --- | --- | --- | --- |
| weighted sum | 2 | **13/24** | 1 ms |
| local | **0** | 7/24 | 5.3 s |
| Claude API | **0** | 10/24 | 7.4 s |

**A word on the number itself before it is interpreted:** The second run exposed
an error *in the measurement*. The rule "nothing for the child" applied
unconditionally, even in the case "two people, no children", where vineyard and
theater are exactly right. It thereby penalized both models for a correct
selection and inverted the result (local stood at 3 misses instead of 0). Fixed:
the rule applies only when a child is traveling. The table above is the
recalculated version of the same raw data; what a measurement is worth is
decided by whether it finds its own errors.

Three things are in it, and only the first is a number.

**First: the incumbent is no rating at all in its lower half.** With ten places
sought, **18 candidates are tied** at 3.0: the score consists of a handful of
half-point signals, and everything with a Wikidata entry and an article lands on
the same number. Where the cut falls into such a tie, the order in which the
region search answered decides. Measured: with the pool order reversed, 8 of 10
places stay the same and the misses go from 1 to 3. Independent of any model,
that is a finding about our own code.

**Second: across all three requests, neither model makes a single miss.**
Neither invented a reference, neither took a savings bank, neither packed the
day with village churches, neither chose anything the request excludes for the
child. The weighted sum took the art association onto the children's trip, and
delivered **zero food** on the art weekend, although the sentence says "abends
gern gut essen" (likes to eat well in the evening). That is the difference in
its purest form: the interest bonus knows museums and theaters, but food is not
an interest but a need, and so it falls through every grid that knows only
topics.

**Third, and this is not a measured number but a judgment:** The two models do
not differ in misses but in **how much of the place they leave standing**. Over
three requests the cloud track found 10 of the 24 obvious targets, the local one
7, and the pattern is the same in every case: the local track picks what fits
and leaves the significant lying. On the art weekend it took vineyard, inn and
café and left out the collegiate church; on the quiet day, exactly one of eight
targets remained. In the same cases the cloud track served both: art *and*
dinner, quiet *and* the weekly market, and on the children's trip history (4
places) alongside outdoors (8) and child (5).

Whether that is better is a matter of taste and remains one: a quiet day of
botanical garden, park, sculpture trail and beer garden is an honest answer to
"nothing strenuous", even without landmarks. It is just not the same trip.

And one more difference that has nothing to do with the selection: the
justifications of the weighted sum read "listed in Wikidata, has a Wikipedia
article" ten times. That is not a reason, that is a database state. §8.3 wants a
"why" one can argue about, and both models deliver that.

**The consequence for §11:** For curation a model is worthwhile, and clearly:
the weighted sum overlooks what is not an interest, and its justifications are
the same database state ten times. Between the two models the miss count does
**not** decide: both are clean. Whoever prefers the cloud track does not buy
freedom from errors but the willingness to leave the significant standing
alongside the fitting, and that is a matter of taste, not a quality measurement.
For a system whose backbone promise is "everything stays in the house" (§3),
that is not worth the price unless somebody misses the three missing landmarks.

**The third measurement: the negotiation chat** (`run-chat.ts`, ten sentences
against a plan, eight tools plus "ask back" and "do nothing"):

| | hit | overreaching | median |
| --- | --- | --- | --- |
| local | **10/10** | **0** | 1.2 s |
| Claude API | 9/10 | **0** | 2.8 s |

**The most important result is the zero in the middle.** No model did anything
that the sentence did not ask for: nobody deleted spots because someone said
"too much walking", nobody replanned anything because someone said thanks. Just
that is what §7.1 feared, and in twenty answers it did not occur. Both tracks
also asked back instead of guessing when the sentence was "the day is too full"
and three days were in the plan.

The one difference is a difference in temperament: the cloud track **asks where
the local one acts.** To "das ist mir zu viel Laufen" (that's too much walking
for me) it answered with a follow-up question instead of the default; careful,
but §11.3 names exactly this sentence as the example from which a tool call
should be made. For the three museums, on the other hand, its follow-up question
was the *better* answer: the sentence says "one is enough", but not which.

**And again the run found an error in the measurement.** The "three museums"
case at first rewarded only guessing: the local track arbitrarily chose the
clock museum and got a hit for it, the cloud track's follow-up question counted
as a miss. Fixed: both readings count. Second, the tool catalog did not say that
`constraint_setzen` and `spot_verbergen` **replan themselves** (as
`updateSettings` and `hideTripSpot` do), so the "ungefragt dazu" (added
unprompted) column counted redundancy that the catalog had not excluded. Also
fixed; this column needs a new run before it means anything.

With that, the fourth row is answered like the first two: **no reason to buy.**
The local track hits everything, overreaches nowhere and is three times faster.
The documents row is decided (§11.3), the other three are measured, so §11 is
answered, with evidence instead of an attitude.

### 11.1 The dividing line is already in the concept

The planner splits into two worlds anyway (§4.3): the **trip resolution** arises
beforehand, at home, online and without time pressure; the **day resolution and
everything on the road** must work offline, instantly and reliably. Exactly
along this seam runs the sensible split between the models:

| | local | Opus 5 (online, opt-in) |
|---|---|---|
| Curating candidates | Weighted sum, **random in the lower half** (measured) | **better, but local too** |
| Understanding the request | **on par, and faster** (measured) | on par |
| Evaluating documents | **stays local, decided, not open** | out of the question |
| Negotiation chat beforehand | barely sufficient | **clearly better** |
| Journal/recap texts | decent | better |
| Replanning on the road | **must be local** | unsuitable |
| Solver | **neither of the two** | neither of the two |

**The hard rule: Opus 5 must never be on the critical path of replanning.**
"We are falling behind" has to work in the dead zone in Hakata. A network call
there is not an improvement but an outage.

### 11.2 What does not change

- **The solver stays arithmetic.** Knapsack per block plus a short round trip
  over two to four stops is exact, solvable in milliseconds, deterministic and
  offline. No model in the world does it better; it makes it slower, more
  expensive and not reproducible. What Opus 5 can contribute is the
  **selection** that goes into the solver, not the calculation.
- **The hallucination rule from §10.4 stays.** Opus 5 invents drastically less
  often, but "less often" is not "never", and the error is invisible. Every
  place name is still validated against the pool. Technically cheap, hence no
  exception.
- **The ellipse prefilter, the light calculation, the block logic**: all
  computation methods, all untouched.

### 11.3 What would get clearly better

1. **Candidate curation instead of day ranking.** Today a weighted sum of OSM
   tags and Wikipedia article length decides what a favorite is, roughly. In 1M
   context, the complete pool of a city including Wikipedia excerpts fits into
   **one** request, and out comes a justified, thematically balanced selection:
   "these 12 of 34, and why". That is the biggest quality leap, and
   paradoxically the cheapest, because it runs beforehand and in batches (batch
   API: half price).
2. **Request understanding.** Reliably translating "with grandma, relaxed, no
   car" into constraints is brittle for a local model. With **structured
   outputs** (`output_config.format`) or `strict: true` on the tools, a
   schema-valid object comes back, exactly what §8.2 displays as chips.
3. **The negotiation chat before the trip.** Opus 5 could operate the planner
   API itself via tool use (`vorrat_durchsuchen`, `constraint_setzen`,
   `anheften`, `neu_verteilen`), instead of only spitting out constraints. "Too
   much walking" becomes a tool call with a visible effect instead of a
   paraphrase.
4. ~~**Document evaluation.**~~ **Decided, and against.** Pulling fixed points
   from OCR text (flight times, check-in rules in the small print, foreign-language
   confirmations) would be the discipline in which a frontier model clearly
   beats a local one. But it is not a technical question: §11.5 expressly
   exempts documents from everything that leaves the house, and the "separate,
   independently switchable case" for which this was deferred here has been
   answered in the negative. This row is thereby no longer an open option but a
   commitment: **local or not at all.**

   What helps in its place is not empty: better text extraction *before* the
   model, prompts with the lessons from real errors (the documents module now
   explains to the classifier which of five dates in a letter is the relevant
   one), few-shot from our own holdings and the learning loop from corrections.
   After the measurements in §11.0, this is not an obviously worse way.
5. **Texts in the travel journal.** Low risk, visible gain.

### 11.4 Cost is not the obstacle

Roughly estimated: the curation of a city is in the range of a few tens of
thousands of input tokens, so **well under one euro**, halved via the batch API.
A chat history with prompt caching costs cents, because cached tokens cost only
about a tenth. For a family system this is irrelevant.

Two caching details that matter here: the order is `tools` → `system` →
`messages`, stable parts first, changeable ones at the end, so pool and system
prompt first, the current question last. And Opus 5 allows **system messages in
the middle of the history** (`role: "system"` within `messages`, without a beta
header), which preserves the cached prefix when a rule changes during the
negotiation.

### 11.5 The real price: privacy

This is the only serious question, and it is not a technical one. "Everything
stays in the house" is the product's backbone promise (§3). A curation call
sends candidate lists, interests, travel period and group composition to a
service.

This can be mitigated considerably, because the task does not need the
identities at all:

- **Public goes out, private does not.** The pool consists of OSM and Wikipedia
  data, which is public. What makes it private is the preferences, and those can
  be stated abstractly: "two adults, one child (7), one person with limited
  walking distance" instead of names and faces.
- **No anchor addresses.** The anchor zone suffices as a coordinate centroid;
  the hotel address does not have to go along.
- **Nothing from documents, photos or finances** leaves the house for curation.
  The separate, independently switchable case for which document evaluation was
  deferred here has meanwhile been **answered in the negative** (§11.3).

  There is still one deliberately built exception, and it should be named rather
  than concealed: `scripts/taxonomy/cloud_audit.py` sends document text to
  Claude to spot-check the local classifier, **PII-scrubbed beforehand** (IBAN,
  e-mail, amounts, dates, phone numbers, long numbers, addresses as well as
  personal names, household members from the database and third parties via
  patterns like "Dr. med. …"). It runs offline, on demand, and its result is
  rules in code, not a runtime dependency. That is a different promise than
  "nothing at all"; whoever does not want even that switches off one script and
  rebuilds nothing.
- **Switchable per function, not globally.** A single "make AI better" switch
  would be the wrong granularity.

Expressly not recommended is the third possibility: the **web search tool**
(`web_search_20260209`) as a gap filler for opening hours, closures and events.
It would indeed close the real-time weakness from §14, but with the same trade
that was already decided against the Google API in §10.7, only at a different
place. If this gap is to be closed, then as a conscious decision of its own, not
as a side effect of a model change.

### 11.6 Conclusion

**Status after the measurements: none of the four rows is a reason to buy any
more.**

| Task | Status |
| --- | --- |
| Understanding the request | **measured**: local on par and twice as fast |
| Curating candidates | **measured**: a model clearly beats the tag sum, the local one without a miss |
| Evaluating documents | **decided**: stays in the house |
| Negotiation chat | **measured**: local 10/10, no overreach, three times faster |

This is expressly **not** a decision of principle against the cloud, but a
result from evidence: three rows were re-measured and say "not necessary", the
fourth is a commitment about privacy. Had the measurement turned out differently,
something else would be written here.

The original consideration remains correct nonetheless, only with the opposite
sign: a better model would make the planner **smarter in preparation** and change
nothing about behavior on the road, because on the road reliability counts, not
cleverness. The architecture would stay the same, with an optional curation step
between candidate search and solver. The measurement confirmed that this step is
worthwhile; it refuted that it needs a *paid* model. The split "model
understands and formulates, computation method plans" is right regardless of how
good the model becomes, and that is the actual finding of this chapter.

## 12. Architecture sketch

```
iOS (SwiftUI, feature "Trip/Planen")
        │  REST
┌───────▼──────────────────────────────────────────────┐
│ Encore service  trip-planner                          │
│  · NL → constraints (llm-service, JSON schema)        │
│  · Candidate search → geo /pois/search                │
│  · Ranking          → interests, votes, prominence    │
│  · Travel time: heuristic, optional matrix from router│
│  · Weather (cache) + sun position/light per spot      │
│  · Block sizing + ordering (solver)                   │
│  · Redistribution from "now/here"                     │
│  · Persistence: plans / days / blocks / stops / pool  │
└───┬──────────────┬────────────┬──────────┬────────────┘
    │              │            │          │
 geo (PostGIS)  llm-service  Open-Meteo  routing (NEW,
 OSM POIs,      local LLM    (external,  stage 2)
 addresses,                   rounded    Valhalla,
 building                     coordinate) GTFS optional
 geometry
```

**Routing moves to the back.** Because blocks only need totals, a heuristic on
straight-line distance with a detour factor is enough for the first cut (on foot
≈ straight line × 1.3 at 4.5 km/h; motorized: the first three kilometers as a
town crossing, the rest as a country road — see §4.5). A real router (Valhalla —
one container for foot, bike and car, with a matrix API, on the same Geofabrik
PBFs that `osm-admin` already loads) improves this measurably later, but is no
longer the blocker it was in the first draft. GTFS goes from a prerequisite to
an optional refinement.

**The solver becomes much simpler thanks to blocks.** Instead of an
*Orienteering Problem with Time Windows* with hard clock times, it is now a
**knapsack problem per block** (which spots fit into the time budget, maximize
the value) plus a **short round trip within the block** (exhaustively solvable
with 2–4 stops). Both run in TypeScript in milliseconds — important because
redistribution on the road has to react immediately and, if in doubt, runs
offline.

**Three changes to the OSM import** are prerequisites and belong in the first
implementation step, because each requires a re-import of the regions:
`name:en` in the tag allowlist (`geo/src/osm2pgsql.lua` knows only `name` and
`name:de` today — in Japan `name` contains kanji), the facade azimuth computed
during import as its own column (§7.3), and the **inclusion of food service and
everyday infrastructure** in the filter (§10.2), which is entirely missing
today. The first two are a handful of lines each; the third noticeably enlarges
the region databases and needs to be measured beforehand.

**The light calculation needs no external source.** Sun elevation and azimuth
can be computed from coordinate and time (~100 lines, no dependency, no
network) — deliberately implemented twice, in TypeScript for the server and in
Swift for the device, so the light hint is correct offline as well. The facade
orientation is derived once from the OSM geometry when the candidates are built
and stored on the spot. Only the weather forecast is external.

**The LLM does not plan.** It translates language into validated constraints
and writes justifications. This way it hallucinates neither opening hours nor
routes. This division of roles holds regardless of how good the model is — §11
plays through what would change with a frontier model (curation yes, solver no).

**Ranking signals** (weighted sum, weights visible in the UI):
prominence (Wikidata/Wikipedia present, article length) · fit with the
interests (embedding similarity against OSM tags/description) ·
group votes · proximity to spots already set in the block · opening hours fit
the block · **indoor/outdoor against the block's precipitation** (the strongest
weather signal) · **light window lies within the block** (small bonus) ·
category variety (no three churches in a row) · optional
history bonus/penalty.

**Data model** (new, Drizzle):
`trip_plans` (trip, period, constraints as JSONB) ·
`plan_legs` (stage: period, region/database, anchor address, transfer) ·
`plan_days` · `plan_blocks` (type, time budget, start/end point) ·
`plan_stops` (POI reference, position in block, estimated duration, status
`geplant|erledigt|übersprungen`, pinned) ·
`plan_pool` (scored candidates per stage including score justification,
indoor/outdoor, facade azimuth) ·
`weather_forecasts` (rounded coordinate + day → hourly values, cache) ·
`plan_votes` (user/AI per candidate, analogous to album voting) — the
multi-user tables (roles, fairness, branches, visits) are described in §6.6.

## 13. Possible implementation steps

> "Stage" (German "Etappe") consistently means a **trip section** in this
> document (§4.2); the implementation is divided into **steps**.

### 13.0 Preparatory work before step 1 can sensibly begin

Four things that are not feature work but would otherwise become expensive
later:

- **Add PostGIS to the test environment** (decided, §15.1). The geo tests today
  work with scripted query stubs (`geo/src/replication.test.ts`) and run outside
  the main test run (`geo/**` is excluded in `vitest.config.ts`). For a spatial
  tag query, however, the risk lies in the SQL semantics. To do: make the
  PostGIS extension available in the sandbox and CI, write a test helper that
  creates an `osm_pois` table and fills it with a few dozen rows, and decide
  whether the new tests run as part of the main test run or stay in the separate
  geo run.

  **Implemented (step 1):** The search tests stay in the geo-specific run
  (`geo/src/poi-search.test.ts`, `node:test`), because geo is a standalone
  package with its own container and its own database; for this the geo
  workflow gets a PostGIS service. Without a reachable database they **skip**
  themselves with a clear reason instead of going red — a red suite that merely
  means "there is no database here" trains people to ignore red suites. The link
  to the main test run is kept instead by `osm-admin/poi-tag-sync.test.ts`: it
  reads the geo files from disk and fails as soon as the tag lists drift apart.
- **Merge the triple tag list** (implemented in step 1 as a drift test, see
  below). The same tag knowledge lives in `geo/src/osm2pgsql.lua` (import
  filter), `geo/src/pois.ts` (query defaults) and `osm-admin/poi.config.ts`
  (caller filter) — with two "must stay in sync" comments as the only
  safeguard. The planning extends all three. Beforehand: generate the Lua tables
  from the TS configuration, or at least a test that reads the Lua file and
  compares the sets.
- **Development regions are Swabia and Upper Bavaria** (decided, §15.1) —
  administrative districts (Regierungsbezirke), not federal states. Swabia
  carries the fixtures around Augsburg, Upper Bavaria is added for stage,
  transfer and corridor tests. Because every filter change forces a re-import,
  the rule stays: **bundle filter changes** instead of pushing them through one
  by one — the reason why step 4 combines everything import-relevant.
- **Measure the growth** before food service and everyday infrastructure go to
  production (§10.2) — on the real host. Swabia is the right yardstick for
  this: small enough that the run is not off-putting, and representative enough
  to extrapolate from there to the remaining districts.

  **There is now a button for this:** `GET /osm/regions/:slug/storage`
  (`osm.admin`) returns the size of the region database, broken down by table,
  plus the POI count per matched tag. Read it once before the re-import, once
  after — the difference is the price.

  Two things to note when comparing. First: compare `totalMb` against
  `totalMb`, not against `tableMb`. The total includes indexes and TOAST and is
  what the disk feels; `tableMb` is only the heap. Second: the largest part of a
  region is the **osm2pgsql middle tables** (`planet_osm_*`), which are kept for
  replication and barely grow with a broader POI filter. Anyone who looks only
  at the total size therefore considerably underestimates the relative growth of
  `osm_pois` — the breakdown exists precisely for this.

  **Before measurement** (before the re-import with the broader filter, read via
  the button in the admin UI):

  | Region     | DB total   | `osm_pois` total   | `osm_pois` heap | POIs   |
  |------------|-----------:|-------------------:|----------------:|-------:|
  | Schwaben   | 729.17 MB  | 4.82 MB             | 2.62 MB          | 16,249 |
  | Oberbayern | 1337.6 MB  | 8.75 MB             | 4.84 MB          | 31,017 |

  Both regions are at this point still prior to the schema that carries
  `shape`/`facade_azimuth` — `poisWithShape`/`poisWithFacadeAzimuth` are
  accordingly at 0. The POI distribution at this point is strongly dominated by
  `historic=*` and `tourism=*` (`historic=wayside_cross` alone 8,630 rows in
  Upper Bavaria); food service and everyday infrastructure are missing
  entirely.

  **After measurement** (after the re-import with the broader filter):

  | Region     | DB total   | `osm_pois` total   | `osm_pois` heap | POIs   |
  |------------|-----------:|-------------------:|----------------:|-------:|
  | Schwaben   | 1484.74 MB | 20.2 MB             | 12.01 MB         | 30,443 |
  | Oberbayern | 3059.78 MB | 43.12 MB            | 25.54 MB         | 67,310 |

  **Difference:**

  | Region     | DB total          | `osm_pois` total  | `osm_pois` heap | POIs             |
  |------------|-------------------:|-------------------:|-----------------:|------------------:|
  | Schwaben   | +755.57 MB (+104 %) | +15.38 MB          | +9.39 MB          | +14,194 (+87 %)   |
  | Oberbayern | +1722.18 MB (+129 %) | +34.37 MB         | +20.7 MB          | +36,293 (+117 %)  |

  **The actual finding lies elsewhere than the preliminary reasoning
  suspected:** Almost the entire size growth comes not from food service and
  everyday infrastructure, but from the fact that `planet_osm_nodes` — previously
  not present at all in either region — is now carried along: 741.3 MB in
  Swabia (98 % of the total growth there), 1484.65 MB in Upper Bavaria (86 % of
  the growth). `osm_pois` itself grows by only 15–34 MB — trivial compared to
  the node table.

  This is not a consequence of the broader POI filter. `geo/src/import.ts` has
  always called osm2pgsql with `--slim` **without** `--drop` — deliberately so,
  because `osm2pgsql-replication update` (the hourly diff application) needs
  exactly these middle tables and aborts with exit 1 without them (comment
  there). `planet_osm_nodes` should therefore always have been there. That it
  was missing before means: Swabia and Upper Bavaria were imported long before
  this replication policy, presumably still with `--drop` or a different
  osm2pgsql configuration — the same pattern as the missing
  `shape`/`facade_azimuth` (§13.0 Sturz-Fix). So the re-import brought these
  regions up to date not only with the new POI filter but with several policies
  introduced since. For capacity planning this means: **The factor of
  2–2.3 in total size is predominantly the price of becoming
  replication-capable (keeping nodes), not of food service.** In a rollout to
  further administrative districts that have never been re-imported, a similar
  jump is likely to occur — it is plannable nonetheless: once per region, not
  continuously.

### 13.1 The steps

1. **`geo /pois/search` against the current data** — area and radius search with
   category filter. **Without re-import:** sights are already in `osm_pois`,
   and they suffice for the first planner, because the lunch block is only a
   time window anyway (§10.3). This decouples the slow part (import) from the
   fast part (query, solver).
2. **`trip-planner`, one day, walking routes via heuristic** — constraints via
   API, no LLM, no frontend. Delivers blocks with spots. Deterministically
   testable.

   **Implemented:** `POST /trip-planner/day`. Deliberately **stateless** — the
   plan is computed and returned, not stored. Persistence (§12) would come with
   step 3, when redistribution actually needs it; creating it now would mean
   building a data model for mechanics that do not exist yet. The order within
   the block is solved exactly (permutation up to seven stops), the selection
   greedily by value per minute. Only the last spots block pays for the way
   back to the anchor — that is the way one actually walks.
3. **Redistribution** — "from here, from now", pool, moving to following days.
   Deliberately **before** the pretty UI, because it is the core mechanic.

   **Implemented:** `POST /trip-planner/plans` creates a multi-day plan (days
   are solved one after another from a shrinking pool, so that no spot appears
   twice), `POST /trip-planner/plans/:id/redistribute` recomputes the rest.
   Persistence is added here (migration `0157_trip_planner`): plan → days →
   blocks → stops, plus the pool. The decisions stay in the pure modules —
   `redistribute.ts` receives state and returns state, without clock, network or
   database, so that redistribution works in a dead zone. Four rules are
   implemented literally: only the rest is recomputed, pinned stops stay,
   displaced items go back into the pool with a bonus instead of the wastebasket,
   and what gets dropped is the lowest-scored.
4. **Import extension** — now that the planner runs and shows which tags it
   really needs: `opening_hours`, `cuisine`, `wheelchair`, `fee`,
   `website`, **`name:en`**, `diet:*`, `outdoor_seating`, plus **food service
   and everyday infrastructure** (§10.2) and the **facade azimuth** (§7.3).
   Everything that forces a re-import, in one go.

   **Implemented.** Two things turned out differently from what was planned
   here:

   - **The polygon stays.** The plan was to compute the azimuth during import
     and discard the outlines. That does not work: the hourly replication
     re-inserts changed POIs through the same table definition, and
     `osm2pgsql --append` fails on a table whose columns no longer match. So the
     outline stays as a column, and an **incremental follow-up pass**
     (`refreshFacadeAzimuth`) computes the azimuth for everything that does not
     have one yet — after the import and after every replication run.
   - **It is computed from the oriented hull**, not from the longest polygon
     edge: the smallest rotated rectangle around the outline, whose longer side
     gives the main direction. More robust against a single long back wall and
     without a vertex iteration, which the Lua interface does not offer.

   The separation from §10.2 is thereby also anchored in the test: the filters
   of the photo matcher are from now on a **subset** of the import, no longer
   congruent with it — otherwise bakeries would compete with sights.
5. **NL input** via llm-service (JSON schema, strict validation) +
   multi-day planning.

   **Implemented:** `POST /trip-planner/interpret` — sentence in, constraints
   out. Multi-day planning already came with step 3 (`days` up to 14); only the
   language is added here.

   Three decisions that were made along the way:

   - **A separate call instead of a text field on the plan endpoint.** The
     traveler first sees *what was understood*, and then builds a plan on that.
     A misunderstood sentence thus costs a correction instead of a wrong trip.
     `rejected` lists what the model proposed and could not be used — silent
     swallowing is thereby ruled out.
   - **The model proposes, it does not decide.** `constraints.ts` is a pure
     module that checks every field against the same limits that the typed
     endpoints also enforce: invented categories are thrown out, 90 days are
     capped to 14, a pace outside the three values is discarded. What is tested
     is exactly what language models really get wrong — prose instead of JSON,
     numbers as words, duplicate entries.
   - **No coordinates from place names.** The service has no forward geocoder;
     `placeHint` merely returns the named place, the anchor is still supplied by
     the caller. Guessing coordinates from "Augsburg" would be exactly the
     confident half-answer that §15.3 rules out.

   The category vocabulary is fetched from geo at runtime (new:
   `GET /pois/categories` in the geo client), not copied here — a category added
   in geo is thereby immediately reachable by sentence. A drift test
   (`prompt-vocabulary-sync.test.ts`) ensures that every category really ends up
   in the prompt; otherwise it would remain unreachable without anything turning
   red.
6. **Stages, fixpoints, two resolutions** (§4.2–§4.4) — trips across several
   places, mode per stage, anchor zones, transfer days, hard clock times with
   backward calculation, pool per stage, detailing only on the evening before.
   Contains the **corridor search** for planned arrivals (ellipse filter, still
   without a router).

   **Partially implemented — the corridor search.** `POST /trip-planner/corridor`
   answers "what lies on the way, without much of a detour?" for a trip from A
   to B. In geo this is a `corridor` option of the area search next to `bbox` and
   `center`; the condition is the ellipse from §4.2, evaluated by PostGIS.

   Three things that were decided along the way:

   - **The detour budget counts there and back.** A spot 500 m next to the route
     costs about 1000 m. This is not a subtlety but the difference between a
     usable corridor and one twice as wide — the tests pin it down.
   - **The ellipse extends beyond both foci.** A place 300 m beyond the
     destination is a legitimate intermediate stop. The index prefilter is
     therefore a buffer of half the minor axis around the route, not tightly
     sized around it: `b ≥ budget/2` always holds, so the prefilter cannot lose
     a row that the exact condition would keep.
   - **Both ends must lie in the same imported region.** Stitching two regions
     together would mean merging two sides and re-sorting — and would still
     leave a hole where only one is imported. The endpoint would rather say
     which end is not covered (§15.3).

   Still **without a router**: what is measured is straight-line distance,
   which overestimates roads and underestimates detours around a lake. For a
   rough budget that is the right trade-off, and when a router arrives, the
   ellipse remains the cheap prefilter in front of it.

   **What is still missing here is the use case, not the computation** (§22):
   no UI calls the endpoint, and there is no path from a found spot to a stop on
   the arrival day. What this hinges on — a stop that lies along the way and
   thus belongs to no stage — is described in §22.4.

   **Partially implemented — stages.** A plan is now a list of stages instead of
   a single anchor. Each stage has its own anchor, its own mode of travel, its
   own region database, an optional start date — and thereby its **own pool**:
   redistribution happens only within a stage; what drops out in one city does
   not slip into the next.

   - **The anchor zone is a tolerance, not an address.** If nothing is booked
     yet, `anchorRadiusM` stores, next to the centroid, how far the real
     accommodation may be from it. The planner computes with the centroid and
     does not claim an address it does not have.
   - **The mode belongs to the stage.** For this, `travelLeg` separates driving
     speed and fixed costs per mode. This is not fine-tuning: only this way does
     public transport lose against the bike over 1.5 km and win over 6 km — a
     single average speed cannot express that, and the block budget would be
     wrong at one of the two ends.
   - **The flat single-city request stays.** A weekend trip still sends
     `anchor`/`days`; this becomes one stage. There are thereby not two ideas of
     what a plan is — downstream everything sees only stages.

   Migration `0159_trip_plan_legs`: days and pool hang off the stage instead of
   the plan; every existing plan becomes a single-stage trip with its previous
   anchor and its region.

   **Partially implemented — fixpoints.** `fixpoints.ts` lays the blocks of a
   day onto an imaginary clock and lets the fixpoints take what is due to them.
   The solver afterwards gets only a smaller budget and never learns what a
   clock time is — exactly the division of labor from §4.4.

   - **Two kinds of fixpoint, and the difference is the whole point.** After an
     `appointment` (booked tour) one is back and the day goes on; after a
     `departure` (last train) one is gone. Treating both alike planned an
     evening block behind a train that had already left — the first test run
     showed exactly that.
   - **Calculated backwards.** A train at 18:40 with a 15 min walk and 20 min
     buffer binds from 18:05; an evening block starting at 17:30 keeps 35
     instead of 120 minutes. The closer to the edge, the harder the budget bites.
   - **The buffer is never zero.** `MIN_BUFFER_MINUTES` is a floor, not a
     default: whoever sets it to 0 has not decided to run, but not to think
     about it.
   - **A displaced block does not disappear silently.** The response names it
     with a reason ("Letzter Zug 17:45 lässt für ‚Abend' keine Zeit
     mehr" — last train 17:45 leaves no time for "evening") — the sentence the
     app shows.

   Migration `0160_trip_plan_fixpoints`: fixpoints hang off the day, times as
   minutes after midnight without a time zone. A fixpoint is "the 18:40 train",
   not a point in time on a global clock — and offline on the device the same
   calculation has to come out.

   **Implemented — transfer days.** A stage can carry a `transfer`: the trip
   *into* it. This yields two things the planner already understands — a
   `departure` fixpoint on the last day of the stage being left, and a later
   start on the first day of the stage being entered. A transfer day is thereby
   not a new kind of day, but an ordinary one with a hard edge at one end.

   A bug surfaced here that only the test run revealed: blocks are purely
   relative, so a later start *shifted* them instead of letting them drop out —
   the arrival day had a "Vormittag" (morning) that began at 16:00.
   `scheduleDay` now knows, besides the actual day start, the *assumed* one:
   blocks the day has already run past drop out, and the first one still reached
   is cut into (arrival 16:00 → 90 minutes of afternoon, then the whole evening).
   This applies only to the arrival day; after that the day is relative again
   and fixpoints can shift it freely.

   **Added later from field testing (stage 12): a sliver is not a block.**
   Arrival at 12:00 left thirty minutes of the morning, which nominally runs
   until 12:30 — and the plan showed a "Vormittag 12:00–12:30" for a day that
   had none. A block is now cut into only if at least a third of it remains;
   otherwise it drops out and the next one starts at the arrival
   (`CAUGHT_BLOCK_SHARE` in `fixpoints.ts`).

   **Added later: the arrival applies to the first stage too.** "Nobody
   transfers into the start of the trip" holds for the *departure* — there is no
   day before, onto which a fixpoint could go. For the *arrival* it does not
   hold: one arrives on the first day as well, at some point, and a full morning
   for a city that the group reaches at 2 p.m. is a morning that the plan
   invented. The arrival time must therefore be set independently of the anchor
   and independently of the check-in: arriving and checking in are two times, and
   planning starts from the first.

   A second bug was noticed in the process: the arrival lived only in the
   request. Every replanning — every settings change — silently gave the morning
   back. Migration 0169 adds it as `arrive_minutes` to the stage, next to
   `day_starts_at`, from which it differs: `day_starts_at` is when *every* day
   begins, `arrive_minutes` only the first.

   **Added later: the anchor has its own name.** `title` is the city, the anchor
   is the hotel — one column could not be both, so a trip was named after the
   accommodation as soon as one picked a hotel on the map, and the day screen
   could not say where the day starts. Migration 0169 separates the two
   (`anchor_label`). In the app the section is accordingly called "Unterkunft"
   (accommodation) instead of "Wohin?" (where to?) — what was asked for was the
   city, what was stored was the anchor — and the **anchor zone** from §4.2
   ("noch nichts gebucht, ungefähr im Umkreis von…" — nothing booked yet,
   roughly within a radius of…) finally has a UI instead of just a field in the
   request.

   What lies *on* the way remains a separate question — the corridor search
   answers it. How the day is framed does not depend on whether anyone wants to
   stop.

   **Implemented — two resolutions.** `detailDays` (default 2) says how many days
   from the start of the trip are planned down to spots immediately. Later days
   get their **frame** — blocks with budgets, fixpoints — and otherwise stay at
   trip resolution; `POST /trip-planner/plans/:planId/days/detail` makes one of
   them concrete, usually on the evening before.

   - **An unplanned day is not an empty day.** The frame is exactly what the
     family votes on in advance, so it exists from the start — the last train
     has already shortened the afternoon of the fourth day before a single spot
     was even considered for it.
   - **The detail budget is spread across the trip, not per stage.** "The next
     two days" means the next two days, whichever stage they lie in.
   - **The pool is not consumed on days nobody has looked at.** For a weekend
     trip both resolutions coincide, exactly as §4.3 describes.
   - **Detailing an already planned day again is rejected.** It would silently
     throw away what is pinned or already visited; that is what `redistribute`
     is for.

   Migration `0161_trip_plan_day_detail`: `detailed` on the day, existing rows
   count as detailed.
7. **iOS UI** — block cards, map, swipe gestures, "Heute" (today) mode,
   **handovers to map apps** (§9.1) and the food list on site (§10.3).

   **Largely implemented.** Plan list, day view with block cards and
   utilization, map with numbered pins, time slider, "Heute" with swipe
   gestures, map handover and food list are in place. Reachable via the trip
   tab ("Urlaubsplanung" — vacation planning); a separate tab bar is full, and
   the running trip and the planned journey belong side by side.

   Three places where the implementation forced a decision:

   - **The time slider answers `nil` instead of guessing** — before the start of
     the day, after the end of the day, in the gap of a booked tour and for every
     plan without block times. A slider that always points somewhere makes
     impossible exactly the check it exists for. For this, migration `0162`
     stores the clock time of every block, which `scheduleDay` computed anyway
     and until then threw away.
   - **Ticking off is not replanning.** `POST /trip-planner/plans/:id/stops/status`
     only sets the status, which a later redistribution reads as "past".
     Going through `redistribute` would have rearranged the afternoon under the
     traveler's thumb.
   - **`LSApplicationQueriesSchemes` was actually missing** — the stumbling block
     from §9.1, literally. Without the entry, `canOpenURL` always reports "not
     installed", and the Google Maps option disappears without an error. A test
     now reads the Info.plist as a file; going through `Bundle.main` did not work
     because in the test target that is the test runner.

   **The food list** (`POST /trip-planner/food`) adheres to the rules from §10.3:
   sorted by distance, never by a quality we do not know. A missing tag means
   **unknown**, not "no" — unfiltered lists therefore keep everything untagged,
   and a row without information gets no struck-through symbols, but no row at
   all. `limited` stays `limited`: "vegan (begrenzt)" (vegan (limited)) is a real
   answer, and reducing it to `false` would exclude a usable restaurant.

   **Negotiating (§8.4) and the "umplanen" (replan) button (§8.5) are also in.**

   - **Moving recomputes the whole day, not the two blocks.** A block begins
     where the previous one ended — take the last spot out of the morning and the
     start of the afternoon shifts. A patch of the two touched blocks would let
     the rest of the day describe a route that nobody walks.
   - **An overfull block is reported, not refused.** The traveler deliberately
     dragged it there; a red block says more than a rejected gesture. Moving
     *across stage boundaries*, by contrast, is rejected: a spot from Tokyo in an
     Osaka day would be measured from the wrong anchor and reached with the
     wrong mode.
   - **The lunch block accepts nothing.** It is time plus area, not a restaurant
     (§10.3) — pulling a museum into it would silently turn it into something
     else.
   - **Replanning guesses nothing.** Position comes from CoreLocation, current
     block and remaining budget from the day frame. If one of them is missing —
     no fix, no block times, or no block is currently running —, the button says
     why. A rearranged afternoon based on a guessed position is worse than none.

   **Addendum — the entry point was missing.** Step 7 was considered complete,
   although the planner list promised "Sag, wohin und wie lange" (say where and
   for how long) but nowhere offered a place to say it: there was no action for
   creating a trip. Thus *everything* from steps 1–8 was unreachable from the
   app — the empty state was the whole feature. Added later as `TripNewPlanView`:
   form first, sentence as an accelerator below, because the model on our own box
   is regularly cold and a screen that only works with a model answer sometimes
   does not work at all. The place is searched via MapKit on the device and must
   be confirmed; a sentence that names a different city moves the search field,
   never the pin (§15.3).

   **Added later: changing settings, and the pool.** Two gaps, reported while
   trying it out.

   The "how" — pace, companions, interests — could be set exactly once, on
   creation. `PATCH …/plans/:planId/settings` changes it afterwards and
   **replans the days**, because pace and companions scale the block budget: a
   stored value that left the days untouched would be a switch without effect.
   What is preserved is the frame (stages, anchor, dates, mode, search radius)
   and **everything that someone put into the pool by hand** (§9.2) — changing
   the pace must not cost anyone their research. It is rejected as soon as a
   stop has been ticked off: a started day is a record, and adapting it to a
   setting changed afterwards would mean rewriting it. For that there is
   "Umplanen" on the road (§5, §8.5), and the rejection says so.

   **Added later: the interests — and the reason why they never worked.** The
   bonus asked `interests.has(category)`, and a category is one of nine
   (`sight`, `museum`, `viewpoint`, `worship`, `theatre`, `food`, `cafe`,
   `essentials`, `outdoors`). The interpreter, on the other hand, is told to
   extract *topics* — "barock", "Industriegeschichte". A topic is never a
   category ID, so nobody got the +2, and the setting was decoration.

   Instead of checking free text against Wikipedia — the candidate carries a
   Wikidata ID and a *link*, not the article — there is now a **small vocabulary
   of what OSM actually distinguishes** (`interests.ts`): museums, castles and
   palaces, churches and monasteries, ruins, technology and industrial history,
   outdoor art, views, nature, theater. Each entry is a set of OSM tags, and the
   spot's tag is compared. **What the data does not provide is not offered:**
   "Barock" (baroque) is not in the list because the map does not know which
   church is baroque — and an interest that silently matches nothing is worse
   than one that does not exist.

   Three things that hang on this: the justification now names the matched
   interest ("ihr wolltet: Burgen und Schlösser" — you wanted: castles and
   palaces) instead of "passt zu euren Interessen" (fits your interests); old
   trips whose interests are category IDs still match; and free text that the
   interpreter once stored is preserved and sent back unchanged on saving,
   instead of being silently deleted by the new screen. The list reaches the app
   via `GET /trip-planner/interests` — two copies would have drifted apart at the
   first additional day, and the error would again have been a silent one.

   **Extended: from nine to fifteen, six of them with re-import.** Two entries
   could be separated immediately because the tags were already there:
   "Denkmäler und Gedenkorte" (monuments and memorial sites)
   (`historic=monument|memorial`, `man_made=obelisk`) leaves "Kunst im Freien"
   (outdoor art) — whoever ticks sculptures rarely means war memorials —, and
   "Türme und Aussichtsbauten" (towers and lookout structures)
   (`man_made=tower`, `historic=tower`, `man_made=lighthouse`) can now be said
   without ticking castles and industrial history along with it.

   The remaining four — "Berge, Seen und Strände" (mountains, lakes and
   beaches), "Zoos und Tierparks", "Märkte", "Bäder und Thermen",
   "Weingüter und Brauereien", plus gardens in "Parks und Gärten" — depended on
   a **filter extension** (`geo/src/osm2pgsql.lua`): new
   `natural=peak|water|beach`, `craft=winery|brewery`,
   `leisure=garden|nature_reserve|water_park`, `amenity=marketplace|public_bath`,
   `tourism=zoo`. As §13.0 demands, in **one** go — every filter change forces a
   re-import per region.

   **New here is a rule that was not needed before: name required.** The old
   filters take everything they match, named or not, and that is right for
   them — a nameless chapel is still a destination. For landscape and everyday
   places it would be wrong: `natural=water` alone would pull in every pond in
   Bavaria, and nobody plans an afternoon around any of them. `poi_name_required`
   therefore applies to all newly added values; a name is the cheapest available
   evidence that a place is a place. A drift test ensures that only values the
   import actually matches are listed there — an outdated entry would be
   invisible.

   The new categories carry their own dwell time (`zoo` 180 minutes, `bath` 120,
   `producers` 60, `market` 40): a zoo is not an intermediate stop, and a spa is
   not twenty minutes — getting that wrong is the way an afternoon ends up with
   three things that do not fit into it. The photo matcher sees none of this
   (§10.2): a lake among the photo candidates displaces a landmark.

   It was noticed that the stage **did not store its search radius at all**
   (nor the day start). A replan would have silently fallen back to the defaults
   — a different area than the one chosen. Migration 0165 adds both to the
   stage; `null` still means "default", which corresponds exactly to what older
   rows were planned with.

   The **pool** had been data since the first day and was visible nowhere — only
   indirectly via "Warum hier?" (why here?) and the line "Zurück in den Vorrat"
   (back into the pool) after a redistribution. Meanwhile four paths lead into it
   (§9.2) and none led anywhere you could look. `TripPoolView` shows it, best
   scored first, with the justifications and the marker "schon eingeplant"
   (already planned). Deliberately read-only: putting a candidate into a specific
   block is a decision that the solver makes with budget and walking distance in
   view — a screen that dropped it somewhere would either duplicate or ignore
   that calculation.

   **The checkmarks are a filter (2026-10-04).** From practice: "Was zählt auf
   dieser Reise?" (what counts on this trip?) read the wrong way around, because
   nothing ticked was the neutral state and a checkmark only gave +2 points. On
   top came a second, invisible mechanism: the categories that the sentence
   interpreter extracted from "vier Tage Lissabon, Museen und Kirchen" hard-limited
   the search without any screen showing it. Now the rule is: **only what is
   ticked is searched**, all rows are on at the start, and there is a sixteenth
   row **"Alles andere"** (everything else) for places that belong to no topic
   (`OTHER_INTEREST_ID`) — without it, a filter over a short vocabulary would
   silently lose the bridge and the square. The bonus is dropped; "ihr
   wolltet: …" appears only when the selection is actually narrowed. All on and
   none on mean the same (`selectionOf` → `null`), words outside the vocabulary
   are ignored instead of being checked against nothing. The interpreter's
   categories are translated into checkmarks (`interestsForCategories`) and no
   longer applied; migration 0226 removes checkmarks and categories from old
   trips, so that they keep searching everything their screen now also says. The
   heading reads "Wonach gesucht wird" (what is being searched for).


   **Added later: a trip without an imported region.** The planner rejected
   ("no imported OSM region covers this location") and thereby threw away
   everything the traveler had typed — because of a download that he could not
   even trigger himself. §4.3 has long had a resolution for this: the plan is
   stored **with frame but without spots**, and the import is requested. Zero
   candidates yield exactly this frame — the solver fills the budget it gets, and
   without candidates, blocks without stops result.

   The request goes through the same `createPending` as the region management
   and thereby inherits its rule instead of bypassing it: a small region loads
   immediately, a large one waits for approval. Whoever plans a trip does not
   commit the server to fifty gigabytes by typing a city name.

   **Added later: "a small region loads immediately" was not true.** The rule
   was built (`DEFAULT_AUTO_APPROVE_MAX_PBF_MB = 1500`), but
   `regionToSuggestion` hard-set the size to `null` — and `autoApprove` requires
   a known size below the threshold. So it was *always* false, and every region,
   even a district of 40 MB, waited for a click that the threshold was meant to
   spare it. The size is now determined on creation via HEAD (`probePbfSizeMb`,
   already existed for the importer). Unknown size still means *ask*: a failed
   HEAD is not permission to pull three gigabytes. The trip planning passes the
   already determined size on to `createPending` instead of asking a second
   time. The response names under `pendingRegions` what each stage is waiting
   for; `POST …/plans/:planId/plan` fills them later and refuses as long as the
   maps are missing — "it is still loading" is something one can wait for, an
   empty day without explanation is not.

   **Added later: the map icon on the stop.** It always opened a route. A route
   from home to a café that one will walk to next month is a number nobody
   wants — at the kitchen table the question is "where is that?". If no trip is
   running (`TripStore.isActive`), the same icon therefore shows only the point.
   The planner does not decide this itself from data: "planned for July" and
   "currently on the road" are different states, and only Trip Mode knows which
   applies.

   **Added later: sharing the trip (§6.2).** A plan belonged strictly to whoever
   had created it — every query filtered on `owner_id`, so nobody else could even
   see it. Thus one person planned the family vacation while everyone else
   watched; §6.2 wants the opposite.

   Implemented as **a list of people**, not as a permission matrix, because there
   is exactly one distinction: the organizer — whoever created the trip — may
   change the frame and invite/remove. *Everyone may do everything else*, and
   none of it is restricted on the road: "Wer vor Ort ist, darf umplanen."
   (Whoever is on site may replan.) The organizer is deliberately **not a share
   row** but the owner of the plan: an accidentally deleted row could otherwise
   leave behind a trip to which nobody can invite anyone any more. Everyone may
   leave on their own — having to ask permission to stop planning someone else's
   vacation would be absurd.

   Two things that the tests pin down, because they can tip in the wrong
   direction: a fellow traveler may **contribute finds** (that is the purpose of
   sharing), and whoever was never invited gets **"plan not found"** instead of
   "no permission" — that this plan exists is none of their business.

   Migration 0166 creates `trip_plan_shares`; the `role` column exists so that
   handing over the role (§6.2, "transferable") later needs no further
   migration.

   With that, step 7 is complete.

   **§9.2 and §9.3 — bringing in one's own finds.** Not part of the numbered
   steps, but hooked in here because it needs the UI:

   - **Map link** (case 1): `trip-planner/map-link.ts` reads Apple, Google, OSM
     and `geo:` links. Fragile by design, so a coordinate is never *derived* — a
     link with a bare search term yields a name and no position, and the fallback
     is a map to confirm.
   - **Article** (case 2) and **screenshot** (case 3) converge as soon as text is
     available: `article.ts` extracts it, `extract-places.ts` lets the model pull
     names with a **literal quote**, and an entry whose quote does not literally
     appear in the page mechanically drops out.
   - **Resolving** (§9.3 stage 4) via `geo`'s new name filter and
     `resolve-place.ts` — unambiguous / ambiguous / none, the same building
     block that §10.6 needs for merchant name → POI.
   - **The server fetch** is only the fallback and has all the precautions named
     in §9.3: only `https`, no private address ranges *even after a redirect*,
     time and size limits.
   - **The extension hands over, it does not decide.** It puts link and text into
     the app group; the confirmation — which trip, which of three cafés, how
     long — happens in the app, where the screen for it is anyway.

   **Added later: the handover was only apparently there for a long time.** The
   extension said "Gemerkt" (noted), nothing waited in the app, and when sharing a
   photo it said "F4mil ist nicht eingerichtet. Bitte öffne die App und melde
   dich an." (F4mil is not set up. Please open the app and sign in.) — to someone
   who was signed in and saw their albums. Both targets are signed for the app
   group `group.de.f4mil.photos`; the code asked everywhere for
   `group.dev.fk-encore.F4milPhotos`: token mirror, upload queue, recently used
   albums and the planner's mailbox.

   The failure pattern is more instructive than the bug. `UserDefaults(suiteName:)`
   does **not** fail for a group the process has no entitlement for — it returns a
   store that ends up in its own sandbox. Writing succeeds, reading succeeds,
   every side behaves correctly, and yet two processes talk in two boxes with the
   same label. A handover without a check is therefore only as reliable as the
   question it asks: only the group's *container* has the entitlement as its
   answer (`containerURL(forSecurityApplicationGroupIdentifier:)`, `nil` without
   entitlement). Exactly that is now asked before the extension claims "Gemerkt"
   or blames the sign-in for "nicht eingerichtet" — §15.3 applies to one's own
   infrastructure too, not just to OSM data. A test reads both entitlements files
   and fails as soon as app and extension are signed for different groups or a
   source file names one that nobody is signed for.

   - **The text extract from the opened page** (§9.3 stage 1) runs via
     `NSExtensionJavaScriptPreprocessingFile`: `TripSharePageReading.js` is
     executed by Safari *in the page that is already open* and returns its
     visible text, along with title, canonical URL and — if present — the
     reader's selection. The script sets navigation, ads and cookie banners aside
     beforehand (§9.3 stage 2) and works on a copy of the DOM, so that the page
     the reader continues to have in front of them stays untouched. A *selection*
     beats the page text because it expresses an intent that the page does not
     know ("this café", not "the eleven cafés in this list") — below a few
     characters, however, it is treated as a mis-tap. The server fetch remains
     the fallback for a link without a page, e.g. from a message.

     The script itself runs in Safari and is not reachable by a test. What is
     pinned down is therefore the *boundary*: that the file exists under the name
     that the `Info.plist` registers, that the `WebPage` activation is set for it,
     that the script still writes exactly the four keys that the Swift side reads
     — and what becomes of such a response. Each of these errors produces a
     takeover that looks like it works and brings along less than it should.

   **Case 4, the search in the app** (`POST …/search`, `TripPlaceSearchView`):
   the way in that has to work when nothing else does — no share sheet, no maps
   app, no language model. Two things the list says explicitly instead of by
   omission: what is already in the plan is **marked, not hidden** (a silently
   shorter list reads like "not in OpenStreetMap"), and a region that was not
   reachable is named — "nothing found" and "a region was not reachable" are
   different answers.
   **The pool as a work surface.** It was data from the first day and then a list
   to look at — the wrong half to stop at: with four paths in, a stack that only
   grows is not a pool but a backlog. Added are the three gestures one reaches
   for immediately: *where is that* (the same detail view as for a planned stop,
   with a jump to Apple Maps or Google Maps), *not this one* (`…/pool/drop`) and
   *into Tuesday morning* (`…/pool/place`). Plus a search field, because a pool of
   150 candidates can otherwise only be scrolled through; the search also covers
   the **note**, because "beste Pastéis laut Blog" (best pastéis according to a
   blog) is often the only thing someone remembers.

   Two decisions here: a spot set by hand is **pinned** — the one deliberate
   decision on this screen must not be cleared away by the next redistribution
   (§5). And an overfull block turns **red, not rejected** (§8.4): the traveler
   put it there on purpose. Removing leaves no tombstone — at the next replan the
   planner can find the same spot again, since it still lies in the area; an
   invisible banishment list would be worse than the honest repetition.

   **Migration 0167** moves note and source onto the *stop*. §9.2 demands
   "origin and link are preserved" — exactly until the moment someone actually
   plans the find, that was not the case: the pool row was its only home, and
   planning it deletes it.

   **Deleting a trip** (`DELETE …/plans/:planId`) never existed — the plan list
   was a one-way street. It belongs to the person who created the trip (§6.2): it
   takes the trip away from everyone it is shared with, not only the typing
   person. Whoever merely wants to get off leaves it via "Mitreisende" (fellow
   travelers) and needs nobody's permission for that.

   **Several cities, also afterwards (§4.2).** From the first day the server
   accepted up to ten stages (since 2026-10-05: twenty cities,
   onward journeys do not count — with them as stages, six cities was the limit)
   — own anchor, own mode, own region, own pool — but *only on creation*, and
   the app built exactly one of them. The twenty days of Japan from §16 were thus
   plannable in one request and unchangeable afterwards, which is not how anyone
   plans twenty days.

   Three endpoints (`trip-planner/legs.ts`) and two screens close this: add a
   city — also in the middle, the following ones move up —, move its anchor when
   the hotel changes, and strike one that did not come about. Four things that
   easily go wrong silently here and therefore have tests:

   - **A stage added later is a stage like any other.** It goes through the same
     `planLegForTrip`, thus inherits pace, group, interests and the longest walk
     of the trip, requests its region the same way, and comes back
     framed-and-empty if that is still being imported (§4.3). A second reading of
     the same constraints would be a second place where they diverge.
   - **A transfer frames both ends.** Arrival at 14:00 shortens the arrival day,
     departure at 09:30 puts a `departure` fixpoint on the *last day of the
     preceding stage* — which is therefore replanned too, because this day has
     really changed. Only the departure time reaches back; a stage that already
     carries a dentist appointment is no reason to replan it.
   - **The frame belongs to the organizer** (§6.2), the rest of the trip to
     everyone. Whoever was never invited gets "plan not found".
   - **A started day is not overwritten.** Moving the anchor, changing the
     length, deleting a stage: all rejected as soon as a stop is ticked off, and
     the message names which. Name and date still go through — a name is not a
     plan.

   Positions are renumbered without gaps on insertion and deletion, because
   `position` is what every endpoint uses to address a stage: a hole in the
   sequence would mean that "stage 2" refers to different cities before and
   after.

   **Added later: choosing the stage.** The day view always showed the first
   stage. But pool, map and moving hang off the stage on screen, so the other
   cities were not merely not shown but unreachable — a three-city trip could
   not be edited for two thirds. On top of that, a crash on creation: the city
   rows held their `Binding`s via the index, and SwiftUI evaluates a deferred
   target once more while it disappears — swiping the second of three accessed an
   index that no longer existed. Rows have since been resolved via their
   identity, not their position, and `.onDelete` converts the offsets of the
   *displayed* list into cities.

   **"Heute" is now called "Unterwegs".** The view is not a date, but the one for
   outdoors: the block the group is in, what remains of it, and the big replan
   button (§8.5). A sun said nothing about that.

8. **Location** — geofences around the next stops, done detection, offered
   redistribution, "what is nearby".

   **Partially implemented.** The boundary from §7.1 determined the split: the
   location stays on the device, only the *event* goes to the server
   ("X was at Y from 13:40 to 14:20, because dwell time and photo"). A table of
   coordinates over time would be a different product than a travel journal.

   - **Done detection** (`visits.ts`, `POST …/visits`): The threshold is the
     larger of ten minutes and a quarter of the planned duration — not the
     smaller. A quarter alone would let two minutes at a viewpoint count, ten
     minutes alone a walk across the museum forecourt. For spots that lie between
     two others, one and a half times that.
   - **One signal asks, two act.** A wrong checkmark costs a swipe, a false alarm
     interrupts the vacation. The verdict is **formed anew on the server**, the
     device is not believed: the rule is a product decision, and one that lives in
     two places drifts.
   - **A "no" is remembered, not deleted.** Otherwise the next sync recognizes the
     same stay and asks again — exactly the nagging that §6.4 wants to avoid.
   - **Unplanned stays** are recorded too (`stop_id` null). That is the more
     valuable half: the app records the day that took place instead of ticking off
     the planned one.
   - **"Was ist in der Nähe?"** (what is nearby?) (`POST /trip-planner/nearby`)
     draws **first from the stage's pool**, only behind it from the region
     search. The travelers have already told the planner what they like; a fresh
     unfiltered search would answer a different question than the plan, and the
     two would silently contradict each other. What is already planned is marked,
     not hidden.
   - **The offered redistribution** (`TripArrivalHeuristic`) checks the direct
     question — does the remainder fit into the remaining time? —, not a progress
     fraction. "Two of four at half the block" sounds right and is not: two long
     and two short stops make the number meaningless. Two brakes keep it from
     nagging: not before the half of the block, and once per block.

   - **The geofences themselves** (`TripGeofencePlan`, `TripDwellTracker`,
     `TripVisitMonitor`): region monitoring around the next one to two stops plus
     significant location change, as §7.1 prescribes. The radius depends on the
     size of the object — a viewpoint is a point, a park is three hundred meters
     in every direction, and one radius for both either misses the one or counts
     the passing by at the other. Done *and* discarded stops get no fence: the
     former would be a wake-up without content, the latter would ask about
     something that was deliberately struck.

     Three cases that go wrong silently and are therefore spelled out: a
     duplicate "entered" (iOS delivers region events multiple times) must not
     reset the clock shortly before the dwell time takes effect; an "exited"
     without a prior "entered" (cold start outside) must not invent a stay; and a
     running stay is "still here", not "zero minutes". What leaves the device is
     exclusively the event, never the trace (§7.1).

   - **The photo signal** (`TripPhotoSignal`): A photo counts only if it was taken
     *there* and *then*. Strict in both halves, because a signal acts together
     with the dwell time without asking — a photo *of* the cathedral from the hill
     opposite is no evidence of having been *at* it.

   **Signal 3 (payment) — decided: omitted for now.** With today's data it cannot
   be built cleanly, and an unclean second signal is worse than none, because two
   signals act without asking. `finance_transaction` does carry `counterparty`,
   but `booking_date` is the *booking* date: a card payment typically posts on
   the next business day, so there is no time window but at best a day.
   `document_receipt_extraction` carries neither purchase time nor merchant name.
   In addition: **the trip-planner reads no finance data** (decided). Dwell time
   and photo carry the detection; signal 3 becomes a topic again only when
   receipts bring a real purchase time along with the merchant name — then via
   the building block from §10.6, which is shared with §9.3 stage 4 and already
   exists (`resolve-place.ts`).

   **Brought forward from §9.1: the setting "Navigation öffnen mit"** (open
   navigation with). The mechanics had been there since the map handover, but
   there was no UI that sets the value — so in practice always Apple Maps. Google
   Maps appears only if it is installed; if it is selected and missing, the
   screen says so instead of silently opening Apple.

   **Implemented from §9.2: the path into the pool** (`POST …/finds`). All five
   rules are visible in the code:

   - **The right stage by location.** A café in Osaka goes into the Osaka stage,
     even if you are standing in Tokyo. In no stage → ask, do not take the nearest
     one: that would put the find in the wrong week.
   - **Suggestion, not an appointment.** The find lands in the pool and competes
     there; nothing schedules it into a day.
   - **Duplicates are merged**, and the notes of **both** are kept. Two people who
     like the same café for different reasons are the case that deserves good
     handling.
   - **Origin stays.** Note, source and who contributed it.
   - **What is missing is named, not guessed.** Without an OSM hit the category is
     `unknown` and the response names what is missing. Instead of inventing a
     duration, the endpoint refuses and asks for the estimated one — that is the
     one question that §9.2 grants the planner. The reference gets the prefix
     `manual:`: an invented `node:` entry would be a claim about data that does
     not exist.

   The remaining paths from §9.2 — the share extension (cases 1–3: map link,
   article, screenshot) and the search in the app (case 4) — have meanwhile been
   built and are described under step 7.
9. **Weather & light** — Open-Meteo connection with cache, indoor/outdoor
   derivation, sun position module, light hints, evening block suggestion and the
   time slider (§8.3). The **horizon profile** from the elevation model (§7.3)
   belongs here — without it the light information in mountainous terrain is
   wrong, not merely imprecise.

   **Started with the light, and there with the hint.** Built first is the part
   without any dependency: `sun.ts` computes elevation and azimuth of the sun
   from coordinate and time — pure arithmetic, no API key, the same numbers on
   server and device, and runnable offline (§3.9). From it the three bands from
   §7.3: golden hour (−4° to +6°), blue hour (−6° to −4°), harsh midday sun (above
   50°).

   Two decisions that were made along the way:

   - **Bands are elevations, not durations.** A golden hour lasts twenty minutes
     in Lisbon and half an afternoon in Tromsø, because the sun there creeps along
     the horizon instead of crossing it. Shortening the northern one to Central
     European standards would mean inventing a sunset that does not exist.
     Likewise the polar winter gets no harsh midday sun — there is none there.
   - **The time zone is passed in, not guessed.** A coordinate carries no time
     zone, and deriving it from the longitude would be wrong in half of Europe and
     all of China. The caller names the offset; the app takes the device's, which
     is correct on site and when planning from home is the most honest estimate.

   **From the generality a statement is made** via `light.ts` and the facade
   angle, which the import has long computed per outline
   (`geo/src/facade-azimuth.ts`): if the sun stands across the building, one of
   the two long sides is in light and the other in shadow; if it runs along, no
   side is lit frontally. **Which** of the two sides it is, the planner does not
   say: the angle is deliberately folded to [0°, 180°), because an outline does
   not know the front — and whoever stands in front of it sees it in a second
   (§15.3). Migration 0171 carries the angle along to stop and pool, so that the
   hint gets by without a round trip to the region database.

   **Of the four ways in which light may enter the plan according to §7.3,
   exactly one is built: the hint on the spot card.** Order within the block,
   ranking bonus and evening block suggestion change what the planner *does*; as
   long as the horizon profile is missing, that would be a promise of a minute
   that in the valley is long in shadow. The card says so too: "ein Hinweis, kein
   Termin — und ohne Berücksichtigung von Bergen oder Häusern" (a hint, not an
   appointment — and without taking mountains or houses into account).

   **Then the weather, by the same rule: first know, then act.**
   `weather-client.ts` fetches hourly `precipitation`, `cloud_cover`,
   `temperature_2m` and `relative_humidity_2m` from Open-Meteo; `weather.ts`
   turns that into three classes — dry / some rain / wet — plus heat via the heat
   index, because §7.2 explicitly places 33 °C at high humidity next to the
   downpour.

   Four decisions:

   - **What leaves the house is rounded to ~5 km.** The rounding happens at the
     one place where the request is built — and it is at the same time the cache
     key: everyone in the same city asks the same question.
   - **One fetch per place and day** (migration 0172). Six hours counts as fresh,
     for *today* one — the day one is standing in is the one that changes.
   - **Beyond ~16 days there is nothing**, and that is said as such. §7.2 wants
     climate normals there; until they exist, silence is more correct than an
     invented average.
   - **"No forecast" is not "nice weather".** An outage of the service costs the
     plan nothing: a plan is a plan even in the rain. A stale forecast is
     preferred to a missing one, and the caller learns that it is secondhand.

   **Indoor/outdoor** (`shelter.ts`, migration 0173) is the derivation without
   which the weather is of no use: knowing that it rains only helps once one
   knows which spot it bothers. Three values, not two — a market hall, a castle
   ruin, a cloister *are* half outdoors, and forcing them into one of the other
   two drawers either sends a family into the rain or wastes the one dry hour
   indoors. The OSM tag beats the category here: "sight" contains cathedrals and
   market squares alike, and the decision hinges on exactly that.

   **Then the first intervention: the weather may rearrange the day — on
   request.** `weather-shuffle.ts` is deliberately a *swap*, not a replan: every
   spot that the sky bothers looks in the pool or in a block it affects less for
   a place swap; displaced spots go back into the pool with the same bonus as in
   §5. Everything else of the day stays as it was — a dry afternoon is not
   topped up from the pool on the occasion, that is the work of planning and not
   of the weather at eight in the morning. The same protection rules as for
   redistribution: done, skipped or pinned is not touched, and a block without a
   forecast remains untouched.

   The shrunken budget factor is *applied* here for the first time: what no
   longer fits after the shortening drops out — namely the lowest-scored, that
   is, what the group cared least about (§6.1).

   **Separated into two calls, and that is exactly the feature.**
   `POST …/weather/proposal` computes and stores nothing, the app shows the moves
   in words; `POST …/weather/apply` does it, after asking. §7.1 is clear about
   it — "rearranging unasked would be overreaching" —, and a forecast is an even
   weaker reason to intervene in other people's days than standing in the wrong
   place at the wrong time. The second call computes **anew** instead of
   replaying the proposal: a proposal that was pondered for ten minutes may
   concern a day that has changed in the meantime.

   **Added:** the swap of entire rainy days (§7.2), the time slider with light
   window (§8.3), the light's ranking bonus and an endpoint for climate normals.

   **Added: the two remaining light paths** (§7.3) — the order within the block,
   which may only come about for free, and the evening block suggestion, which
   writes nothing until someone accepts it.

   **Added: the consequences of the climate normals** (§7.2) — the buffer day in
   the middle of the stage, with its justification instead of a flag, and the
   measured indoor share of the pool including the missing number.

   **Added: the producer of the horizon profile** (§7.3) — the fan of 24
   directions over a free elevation model, stored once per place and forever,
   computed with curvature and refraction. With that, step 9 is done.
10. **Further context signals** — document fixpoints, travel group, plus the
    **travel readiness check** and the packing list (§8.6), both of which merely
    collect existing states.

    **Of this implemented: travel readiness and packing list** (§8.6) as well as
    the **document fixpoints** (§3.4). Documents are now attached to a trip:
    suggested with justification, attached on request, times read as a
    suggestion including a proof line instead of as a written fixpoint. The
    ticket line of the evening-before check has thereby become answerable — with
    the honest limit that the app knows what is attached, not what might be
    missing. Plus the **travel group** (§3.5): who travels along is now stored as
    persons on the trip instead of as a sentence in the constraints, and
    `withChildren` is drawn for the start of the trip from the birth dates of the
    guardians — "shorter distances", on the other hand, never, that is set by a
    human. With that, step 10 is done, except for the votes, which continue to be
    shown as open instead of as checked.
11. **Multi-user operation** (§6) — contributions and votes per person,
    heart's-desire wishes and fairness account, organizer role, fine-grained
    merging of concurrent changes, automatic done detection, splits with meeting
    point. Deliberately late: a trip that one person plans has to work completely
    beforehand.

    **Of this implemented: the rating** (§6.1) — votes per person and per
    proxy-cast vote, heart's-desire wishes with a quota per stage, the derived
    fairness account including its sentence, and the application to planning as
    its own call instead of as a side effect of every swipe. With that, the
    evening-before check (§8.6) also answers its fourth question — and with names
    instead of a quota: whoever has not said anything yet is named, because that
    is exactly what the question is about. Organizer role and done detection were
    already in place (§6.2, §6.4). Plus the **fine-grained merging** (§6.3) —
    buffered operations, replayed idempotently, with journal and undo — and the
    **splits** (§6.5): branches on a block, budget backwards from the meeting
    point, suggestion from the votes. Both also have their screen in the app
    (`TripJournalView`, `TripSplitView`); with that, step 11 is done.
12. **Refinement, optional** — Valhalla for real travel times, GTFS per
   region, offline bundle, link with trip album and recap.

    **Of this implemented: the offline bundle** (§3.9) — `GET …/plans/:planId/bundle`
    and the screen "Unterwegs ohne Netz" (on the road without network). Brought
    forward because it presupposes nothing that is still missing: the plan is
    coarse enough to be fully fledged without a network, and the light
    calculation was already available.

    **And the review of the plan** (§8.7) — `GET …/plans/:planId/review` and
    "Danach" (afterwards): planned versus actually visited, unplanned stays,
    photos per spot via `photo_poi_matches`, plus the link with the recap in both
    directions (the review adopts the name of the planned trip, the trip shows its
    review). Valhalla and GTFS remain open.
13. **The idea pool** (§20) — a shared pool without a trip, the notification on
    proximity, the tour suggestion from several ideas and the area search.
    **Implemented** (§20.1–20.3): the pool including sharing, the proximity
    notification with quiet period, the excursion suggestion via `solveDay` and
    the three paths between pool and trip. **Events (§20.4) are not being built
    for now** — they depend on a source that does not exist as open data; the
    mechanics around it are in place and will take it in as soon as one exists.
    Deliberately after step 8: it lives off the location loop, and without it it
    would be a bookmark list. Events (§20.4) depend on a source that does not
    exist yet and are therefore not part of this step.

14. **Routes** (§4.7) — a spot with extent: end point, length, ascent, own
    duration. **Stage 1 implemented:** the field on pool and stop, the find with
    an end point, and every rewalk — solver, moving, redistribution, weather,
    light — continues from the end of the route. Stage 2 (input
    and line in the app) and stage 3 (a stop may run beyond the end of the block,
    `spill.ts`) and stage 4 (spots on the route count as passed, `on-the-way.ts`)
    and stage 5 (import of the OSM route relations, `osm_routes` including search,
    duration estimate and "routes nearby") are likewise implemented. With that,
    §4.7 is complete in substance; what remains open there is also the duration by
    travel group (2026-09-19): the modes of travel in §3.5 are in place, the
    walking pace scales the route duration, and whoever is on wheels is not
    suggested routes with ascent. With that, §4.7 is complete.

15. **The excursion nobody asked for** (§4.6) — "four days in San Gimignano", and
    Florence comes up anyway. **Stage 1 implemented:** the measure for the
    under-supplied stage (`thin-pool.ts` — would a whole day stay empty even if
    the remaining pool were planned in?), the day targets from `osm_admin` and a
    grid without re-import (`geo/src/day-targets.ts`) and the reading suggestion
    `GET …/plans/:planId/day-trip`, which writes nothing and names **one** target.
    **Stage 2 is also implemented:** accepting via the day anchor (§4.5), the "no"
    remembered on the stage (§6.4) and the "Tagesausflug" (day trip) screen. With
    that, §4.6 is done. Deliberately after step 14: it presupposes §4.5, and until
    the measure existed, every suggestion would have been a guess.

Steps 1–3 are the honest test — and they get by **without a single re-import**:
does the machine deliver, for *one* day in *one* city, a block division that one
would actually walk through like that — and does it hold up when the day goes
differently? Everything after that is expansion.
## 14. Known weaknesses

- **OSM data quality.** `opening_hours` is patchy, and restaurant quality is
  not recorded there at all. Remedy: the coarse resolution (§4) forgives
  inaccuracy, and missing information is flagged as "unverified". For
  food and drink this applies twice over — §10 covers the data situation and
  its consequences in detail.
- **Estimated travel times.** The heuristic can be well off near rivers,
  mountains or poor public transport connections. Remedy: buffers in the
  block budget, honest labelling as an estimate, and step 12 for the regions
  where it pays off.
- **Weather forecasts are uncertain.** Three days ahead, the precipitation
  amount is only a rough tendency. Remedy: use only the three classes,
  update the plan on every refresh (§5), and show the uncertainty in the UI
  instead of faking a millimetre figure.
- **Facade orientation is an approximation.** Derived from the longest polygon
  edge, it works well for simple building shapes and hardly at all for round,
  nested or free-standing objects. And the golden hour lasts anywhere from
  twenty minutes to three hours, depending on latitude and season. That is why
  light remains a hint with a small weight and never becomes a hard
  constraint.
- **Location costs battery and trust.** Remedy: region monitoring instead of
  continuous GPS, everything relevant to planning on-device, only the rounded
  weather coordinate going out — and a switch that turns off all the
  automation.
- **Non-Latin scripts.** Without `name:en` in the import, unreadable names
  show up in the plan in Japan, Greece or Thailand. Even with the tag a gap
  remains where OSM has no English name — then the only help is the original
  spelling plus the Wikidata label as a fallback.
- **The corridor filter is an approximation.** The ellipse works with
  straight-line distances; it does not see mountains, rivers or border
  crossings. A spot with "+10 min." according to the ellipse can really cost
  half an hour. As long as no router takes part in the calculation, the detour
  figure must therefore be labelled as an estimate, and the budget is set
  generously so that the preselection does not discard anything good.
- **Handovers are one-way streets.** What happens after the deep link is
  invisible to the app (§9.5). The way back into the plan must therefore be
  so cheap that nobody forgets it — a swipe gesture, not a form.
- **Concurrent changes are expensive.** Several devices, some offline, on the
  same plan (§6.3) are the costliest part of multi-user operation — and
  without fine-grained merging, changes get lost silently. Likewise the
  automatic done detection (§6.4) is imprecise in dense city centres and
  indoors; hence dwell time instead of entry, two signals for silent marking,
  and a swipe gesture to correct it.
- **The light model only knows the terrain where it has been measured.** The
  horizon profile (§7.3) is computed on the first light query for a place and
  then kept; before that — and where the elevation model is silent or
  unreachable — the free horizon still applies, and in valleys and hill towns
  (Lisbon, Prague, anything Alpine) the figure is then systematically too
  late. The 90 m resolution also sees the ridge, not the house across the
  street. As long as no profile exists, the figure must be labelled "with a
  free horizon".
- **A base camp with day trips cannot be expressed** (§4.5). The anchor
  belongs to the stage, every day inherits it, and the search radius does not
  know the means of transport — four days in San Gimignano with excursions to
  Florence and Pisa are therefore either three stages promising something
  different, or a pool in which Florence does not appear. Proposal and order
  are in §4.5 — and §4.6 covers how the excursion should arise on its own from
  "four days in San Gimignano", without anyone asking for it.
- **No real time.** Traffic, strikes and spontaneous closures are invisible to
  the system — a deliberate handover to Apple/Google Maps for navigation.
- **Storage requirements** of a later router (Valhalla tiles in addition to
  the PostGIS region DBs) must be measured in step 12 and integrated into the
  region management (deleting a region = deleting the tiles too).
- **Offline maps.** Vector tiles from the PBFs (planetiler + MapLibre) would be
  a large building block of their own. For now MapKit online; offline there
  are the block list, spots and directions, but no map display. The offline
  bundle (§3.9) names this gap itself (`omits`), so that the screen can state
  it, rather than letting someone discover it in a strange city.

## 15. Decided questions

As of 2026-09-02 all twelve open questions are answered; the answers appear
below, under the respective question, and have been worked into the affected
chapters. The grouping by urgency is kept because it shows which decision
affects which implementation step.

**That leaves nothing open that blocks the start.** New questions arising
during implementation belong here.

### 15.1 Affects step 1

1. **Test environment — decided: PostGIS.** The test environment (sandbox and
   CI) gets PostGIS, `osm_pois` is filled by hand with a few dozen rows for
   tests, entirely without osm2pgsql. That way radius, tag predicate, sorting
   and the order of filter and `LIMIT` (§10.2) are really tested and not just
   the assembled SQL string. See §13.0.
2. **Development region — decided: Swabia, plus Upper Bavaria.** Correction of
   an earlier version that said "Bavaria" here: what is imported are not
   federal states but **administrative districts** (Regierungsbezirke), and a
   Bavaria-wide dataset does not exist at all.

   For development this is not a drawback but an advantage, for two reasons.
   First, an administrative district is much smaller than a federal state, so
   the re-import after a filter change is correspondingly shorter — exactly the
   cycle that step 4 goes through often. Second, and more important: **Two
   neighbouring regions are a better test case than one large one.** Stages
   each have their own region database (§4.2), so Augsburg → Munich is a real
   stage change including transfer and corridor search — in a single
   Bavaria database exactly this mechanism could not have been tested.

   **Swabia** is the primary playground (Augsburg; the test fixtures are also
   located there), **Upper Bavaria** the second region for stage, transfer and
   corridor tests.

### 15.2 Affects step 2

3. **Block scheme — decided: four-part split as the default, adjustable.**
   Every day is created with morning / midday / afternoon / evening; each
   block can be renamed, split, merged or deleted (§4.1).
4. **Web frontend — decided: iOS only, API stays neutral.** The UI is built
   exclusively in the iOS app; location, geofences, camera and Trip Mode are
   at home there anyway. The endpoints are nevertheless cut to be
   frontend-neutral, so that a web frontend can be added later without an API
   rework. Concretely, "neutral" means: no iOS-specific data formats or field
   names in the responses, no state that exists only on the device, and
   presentation decisions (wording, symbols, colours) in the client rather than
   on the server.

### 15.3 Affects steps 5 to 9

5. **Region scope — decided: import automatically, propose deletion after a
   grace period.** If a destination is planned for which no region database
   exists, the planner triggers the matching Geofabrik import itself — without
   asking. The disk protection for this already exists: the importer probes the
   PBF size via HEAD, scales it up by the expansion factor and goes into
   `blocked_disk` if there is too little free space, rather than filling up the
   disk (`osm-admin/importer.ts`). Two things still need to be built: the
   **mapping from destination to Geofabrik extract** (a place name must lead to
   the right sub-region, and "Hakata" to Kyushu), and an honest **progress
   display** — an import takes minutes to hours, and for that long this stage
   has no pool yet, which the planner must say instead of delivering empty
   results. If `blocked_disk` kicks in, it becomes a notice with a clean-up
   suggestion instead of an error message.
   **Clean-up:** Three months after the end of the trip, the region management
   proposes deletion — proposed, not executed. The region's derived data
   (routing tiles, §12) is deleted along with it.
6. **Claude API — decided: build it with two tracks.** Every model call goes
   through an exchangeable interface; the local model is the default, Opus 5 a
   provider that can be enabled **per function** (§11.5 — a global switch would
   be the wrong granularity). What matters is what the abstraction must cover
   so that it holds up later: structured output with schema validation, tool
   calls, a cost counter per function and a **fallback to local** when there is
   no network or no credit. The anonymisation from §11.5 (abstract group
   description instead of names, anchor zone instead of address) belongs in
   this layer, not in the callers — otherwise it will be forgotten at some
   point.
7. **Automation threshold — decided: put a ready-made proposal next to it.**
   When the app notices a delay or a weather change, it immediately computes
   the redistribution and shows the result concretely ("Museum out, moves to
   Friday — accept?"). One tap is enough, a second one undoes it. This is
   exactly what the solver is fast enough for (§12), and nobody on the road
   wants to hunt for a button that calculates something first. Two guardrails
   against it turning into nagging: **only ever one open proposal** — a new one
   replaces the old one, they do not pile up — and a rejected proposal does not
   come back for the same cause until the situation changes substantially.
8. **Light hints — decided: fully active for everyone.** Light windows appear
   on every spot card, quietly influence the order within the block and may
   propose an evening block that would not exist otherwise. To keep this from
   tipping over, the weights from §7.3 stay small: light orders and proposes,
   it does not select and is never a hard constraint. An evening proposal
   follows the same rule as any other automation (question 7) — at most one
   open, rejected means done. It can still be switched off, just not off by
   default.
9. **Hotel choice — decided: rate areas, not houses.** The planner rates
   locations, not beds: "from here two thirds of your favourites are reachable
   in 20 minutes, and something nearby is still open in the evening". This can
   be derived reliably from OSM — price, room quality and availability cannot,
   and a list of houses without this information would look like a
   recommendation without being one (the same mistake that §10 avoids for
   restaurants). Booking happens elsewhere; the result of the booking comes
   back as a document and turns the zone into an anchor (§3.4).
   Implementation: rating an area is not new machinery but the existing
   planner, applied experimentally to several anchor candidates — how much
   pool fits in the time budget if the day starts and ends here.

### 15.4 Affects multi-user operation (§6), step 11

10. **Quota of heart's desires — decided: two per three days, per stage.** It
    scales with the length of the trip and resets with each stage — whoever
    set their two in Tokyo starts fresh in Osaka. Rounded up, so that a
    two-day stage does not go empty-handed. Note: with four people that is
    eight picks per three days, enough to fill a day plan — if a heart's desire
    no longer fits the budget, it is therefore not silently dropped but
    explicitly reported ("X's wish only fits if something else gives way"),
    and the counter does not expire.
11. **Proactive splits — decided: yes, but only for a clear conflict.** The
    proposal appears only if two spots exclude each other in time **and** each
    is strongly weighted for a different person — not for every computational
    improvement. For smaller disagreements the planner stays quiet. It is
    phrased neutrally and as one option among several ("one possibility would
    be …"), never as a recommendation to the group; splits can be created by
    hand at any time anyway. For the threshold this means: it needs both
    conditions, otherwise conflict resolution turns into an app that keeps
    suggesting separations.
12. **Visibility within the family — decided: visible to everyone in the
    trip.** Everyone sees who visited which spot. This is necessary so that
    after a split it is clear what the other branch has seen (§6.5), and so
    that the shared travel journal is accurate. Three limits: **Only the event**
    is shared ("X was at the temple"), never a live location; sharing can be
    **switched off per person**, in which case the stop appears to the others
    only as done, without a name; and it ends **with the trip** — visits do not
    become retroactively visible across completed trips.

---

## 16. Worked example: 20 days in Japan

Three worked examples test the mechanics at their edges: a long multi-city
trip (§16), a short car trip with a planned journey there (§17), and a single
day trip (§18). Each one changed the concept. A fourth is still pending and is
recorded in §21: a cruise, where the accommodation travels along and half the
days have no place.

First the long case — **3.9. to 22.9.2027,
Tokyo, Osaka and Hakata, two people**. Deliberately a hard case: long,
several places, far in the future, non-Latin script, different time zone.

### 16.1 Preparation: the regions

Before any planning, the OSM data must be in the house: three Geofabrik
sub-regions of Japan — **Kanto** (Tokyo), **Kansai** (Osaka), **Kyushu**
(Hakata/Fukuoka). Today that is an admin task, takes time, and happens weeks
in advance, not during planning (see open question 2 in §15).

### 16.2 Input

```
3.9. bis 22.9.2027, Tokio, Osaka und Hakata,
zu zweit, viel zu Fuß und mit der Bahn,
wir mögen Tempel, Aussicht und Märkte
```

→ Chips: `20 Tage` · `3 Etappen` · `Modi: Fuß, ÖPNV` · `Interessen: Tempel,
Aussicht, Märkte` (20 days · 3 stages · modes: on foot, public transport ·
interests: temples, views, markets). If the documents service finds flight and
hotel confirmations for the period, they are proposed as fixed points —
arrival at Haneda, three hotels, and thereby implicitly the stage boundaries.

### 16.3 Stages and transfers

Tokyo 3.–11.9., Osaka 11.–18.9., Hakata 18.–22.9. (§4.2). The Shinkansen
journeys in between are fixed points that each cost half a day; each stage
gets its hotel as the day anchor and its own region database.

### 16.4 Plan coarsely, do not plan everything

At trip resolution (§4.3), a rated pool is created per stage — "Tokyo: 34
candidates, 12 clear favourites" — plus the points bound to dates (timed-entry
tickets, a day trip). The two of you vote on them, and the AI votes along. The
result is not a route but a ranking: it later decides what drops out first.
Concrete blocks are only created one to two days beforehand.

### 16.5 Weather eight months ahead

Does not exist. At trip resolution, climate normals therefore count (§7.2):
September in Japan is hot, humid and **typhoon season**. Practical consequence
in the plan — enough indoor candidates in the pool and one unscheduled buffer
day per stage. From about two weeks before, the real forecast adds detail day
by day.

### 16.6 A day in Tokyo

The evening before, the plan for Asakusa and surroundings is created:

| Block | Content |
|---|---|
| Morning (approx. 3.5 h) | Sensō-ji → Nakamise → Sumida riverbank |
| Midday | open, in the area |
| Afternoon (approx. 3 h) | a ride to Ueno → museum → park |
| Evening (proposed) | viewpoint from approx. 17:00 |

The evening block comes from the light module — and here it pays off
concretely: **Tokyo lies at the eastern edge of its time zone**, the sun sets
around 6 p.m. in early September. The golden hour there is late afternoon, not
evening; anyone setting off for the viewpoint at 19:30 by European intuition
ends up standing in the dark. In Hakata, a good nine degrees of longitude
further west, the same moment falls roughly 35 minutes later. No travel guide
tells you that, and it can be computed offline in milliseconds (§7.3).

### 16.7 On the road

At 2 p.m. you are still at Sensō-ji. The geofence notices, and the app offers:
*„Der Nachmittag wird knapp — Museum raus, rutscht auf Freitag Vormittag. Der
Aussichtspunkt um 17 Uhr bleibt."* (The afternoon is getting tight — museum
out, moves to Friday morning. The 5 p.m. viewpoint stays.) One tap is enough;
the museum is not deleted, it is back in the pool.

If the edge of a typhoon passes through, the same mechanism applies one level
up: the rainy day swaps with a dry day **of the same stage**, outdoor items move
into the pool, indoor ones move up.

### 16.8 Stage change and afterwards

On 11.9. the morning is taken by the Shinkansen; from Osaka on, a new region
database and a new anchor apply, and Osaka's pool has long been rated.
In parallel, Trip Mode collects the photos — at the end there is the travel
journal with planned versus actually visited blocks, and the recap.

### 16.9 What this example changed in the concept

The walkthrough uncovered five gaps, which have now been worked in:
stages as a layer above the days (§4.2), two planning resolutions (§4.3),
climate normals instead of a forecast beyond the forecast horizon and heat as
a budget factor (§7.2), the facade azimuth, which has to be computed during
import because of the centroid reduction (§7.3), and `name:en` in the tag
allowlist, without which the plan would show 浅草寺 instead of "Sensō-ji"
(§12).

---

## 17. Worked example: four days in Prague by car

**30.8. to 2.9.2027, Augsburg → Prague and back, by car.** The counter-design
to Japan: short, one destination, but with a journey there that itself needs
planning, and a change of mode along the way.

### 17.1 Input and framing

```
30.8. bis 2.9.2027 Prag, mit dem Auto ab Augsburg.
Hotel etwa 5 Metro-Stationen vom Wenzelsplatz.
Check-in ab 15 Uhr. Auf dem Weg gern was anschauen,
wenn es nicht groß umwegt.
```

This becomes **one** stage (Prague) with two transfers, plus:

- **Anchor zone instead of anchor** (§4.2): The hotel is not booked yet. The
  planner works with the centroid of the zone around Muzeum/Můstek and outputs
  it as a search aid — which neighbourhoods lie within about fifteen minutes
  by metro, it knows from the OSM data better than a booking portal.
- **Mode per stage** (§4.2): car for the outbound and return journey, in Prague
  **on foot and metro**. One does not drive into the city centre — the change
  is a fixed point: park & ride at a metro terminus or the hotel car park, then
  drop off the luggage, then continue on foot.
- **Only one resolution** (§4.3): Four days are short enough that trip and day
  resolution coincide.

### 17.2 The arrival day — the most interesting calculation

The drive Augsburg–Prague is a good four hours of pure driving time. Check-in
**from** 3 p.m. is not an obstacle but the source of the free time window: with
a departure at eight, one would arrive just after twelve and stand for three
hours in front of a closed reception. The planner turns this around and
searches the **corridor** (§4.2) for an intermediate stop of about two hours
with a small detour budget.

The ellipse condition draws a narrow band along the route from the region
database — candidates with almost zero detour lie on the way anyway, those
further away have to justify their budget. The result is a small pool instead
of a single recommendation, with the detour time as a visible metric
("+5 min.", "+25 min."), which you decide on.

The day then looks like this:

| Time | Element |
|---|---|
| ~8:00 | Departure (fixed point, self-set) |
| Morning | Drive, first leg |
| Midday block | Intermediate stop in the corridor, approx. 2 h |
| Afternoon | Rest of the drive, P+R, luggage to the hotel |
| from 15:00 | Check-in (fixed point) |
| Rest of the afternoon | first short block on foot around the anchor |

### 17.3 The two full days and the departure

31.8. and 1.9. are normal block days, from the anchor, on foot and by metro —
exactly the case from §4.1. The 2.9. is again a half day: check-out in the
morning, drive back. Whether the return can still accommodate a corridor stop
depends on when you want to be home — the same calculation as for the
outbound journey, only with the fixed point at the other end (§4.4).

### 17.4 What this example contributed

Three mechanics that are now part of the concept: the **anchor zone** for
accommodation not yet booked, the **mode per stage** including the mode change
as a fixed point, and the **corridor search with detour budget** including the
ellipse prefiltering, which works without a router.

Of the three, the corridor search is the only one that was built and still
reaches nobody: the intermediate stop above cannot be offered or accepted
today. §22 says what is missing for that.

---

## 18. Worked example: one day in Nuremberg by train

The smallest possible trip — **Augsburg → Nuremberg and back, in one day, by
rail**. Valuable as a test case, because here every simplification of the
concept reaches its limit.

### 18.1 What falls away here

A day trip is a stage with one day, no hotel and no trip resolution. The
**anchor is the main station** — start and end point at once, and in Nuremberg
conveniently right next to the old town, so that the whole day works on foot.
The pool is small, the voting is dropped, and nobody needs climate normals:
for tomorrow there is a real forecast.

The system must therefore **degrade cleanly downwards** — no empty stage
wizard, no prompt to choose a hotel, no four-week pool.

### 18.2 The day hangs between two trains

This is where §4.4 shows its use. Both ends are hard times:

| | |
|---|---|
| Outbound | Fixed point — depending on the train, roughly one to two hours |
| Morning | Old town and castle hill, on foot from the main station |
| Midday | open |
| Afternoon | Museum or a second district |
| **Return** | **Fixed point, calculated backwards** |

From the last sensible train, the walk to the station and a safety buffer are
deducted; what remains is the budget of the afternoon block. If you fall
behind at three o'clock, the redistribution (§5) bites harder than in Prague
or Tokyo — there is no "then tomorrow instead", the pool has no following day.
This is exactly why the ranking from the voting counts most here: what drops
out first should not be what you made the trip for.

### 18.3 The ticket as a constraint

If a ticket exists as a document, its restriction becomes a fixed point: a
saver fare tied to a specific train fixes both ends, a Bayern-Ticket is valid
on weekdays only from 9 a.m. and thereby shifts the start of the morning block.
This is the same mechanism as the hotel booking in §16 — only tighter, because
a single day has no reserve.

### 18.4 What this example contributed

It forced the wording of §4.4: fixed points are absolute and carry a time of
day, blocks stay relative. Without this separation, coarse planning would have
failed precisely where punctuality matters. In addition, the insight that the
system must be able to **degrade downwards**: a day trip must not feel like an
amputated world tour.

---

## 19. Market landscape

As of 2026-09-02, based on web research — partly from vendor sites, so
**advertising claims, not verified facts**. Before drawing strategic
conclusions, an afternoon with two or three of these apps and a real trip
would be worth more than any further search.

### 19.1 Two mature camps

**AI trip planners** are a full market: Layla builds multi-city routes and road
trips with a day plan and live prices, Mindtrip fields a POI database in the
millions including booking integration, Wanderlog is strong at map-based
reordering, Stardrift advertises changing individual days without rebuilding
the plan (i.e. §5), Stippl adds budget, packing list and group sharing.

**Light planners for photographers** are equally mature: PhotoPills, Sun
Surveyor, LightPlan (3D terrain, cloud overlay), PhotoTime (offline), Golden
Hour (sun azimuth, time slider). They compute §7.3 — in part better, see the
terrain shading that was adopted from there.

### 19.2 The gap lies between the camps

Nothing was found that combines both. **The light apps plan a shot, the trip
planners plan a day — nobody plans the day around the light.** In addition
there are two things that no market app covers, and structurally so:

- **The private context.** None of these apps reads your own hotel confirmation
  from your own document store, knows from face recognition who is travelling
  along, or knows your own receipts. They cannot either — that would require
  hosting their users' digital lives. fk-encore already does that; that is the
  actual moat.
- **The loop on the road.** The market apps *generate* plans. That a geofence
  notices that the group is still at the first stop at 2 p.m. and puts the
  ready-made replacement plan next to it (§5, §7.1) was nowhere to be seen —
  nor were group fairness and splits (§6).

### 19.3 What follows for the priorities

**Generating a trip plan has become a commodity.** Competing there against
vendors with booking data and millions of POIs would be wasted effort. The
value lies in the other half: private context, the loop on the road, the
light.

This shifts the bar for steps 1–3 (§13): the honest test is not "is the
generated plan as good as the big players'", but **"does it hold up when the
day goes differently, and does it use what only we know"**.

### 19.4 Explicit non-goal: booking

Booking integrations (accommodation, tours, tickets) are the core of the
business model for the market apps. For a self-hosted family system they are
**not a goal** — they would bring commission logic, commercial data
dependencies and exactly the paid ranking that §3.8 and §10.7 decided against.
The planner stops at the recommendation; booking happens elsewhere, and the
result comes back as a document (§3.4). This is stated here so that in a year
the gap is recognisable as a decision and not as an omission.

## 20. The idea pool: things you would like to do some day

Up to here, everything presupposes a **trip**. You create one, name a place,
and get days. That is the half you plan — and the rarer one. The more common one
is the one you *collect*: the beer garden someone told you about, the
exhibition in the neighbouring town, the hike that came up twice in
conversation. Things without a date, without a city, without a frame. Today
they have no place in this concept, although the building block for them has
long existed: the **pool** (§5) is exactly a rated list of possibilities — it
just hangs off a stage.

> **How to use it**, without reading this chapter:
> `documentation/ideenvorrat.md` — endpoints, data model, rules and status.

### 20.1 What it is

A **pool without a trip**, per household: an idea collection into which
everyone puts whatever they come across. The same four ways in as in §9.2 — a
map link, an article, a screenshot, the search in the app — and the same entry
at the end: a place with coordinate, category, estimated duration, note and
origin. All that is missing is the assignment to a stage.

Two properties that distinguish it from a bookmark list:

- **It is shared.** Not as a copy per person, but as one list the family
  writes into (§6). Whoever puts something in stays visible — "Dad wanted to
  go there" is half the information.
- **It is location-based, not list-shaped.** An idea collection that is only a
  list gets read until it is too long, and never again after that. The benefit
  arises when it **speaks up by itself**.

**Implemented (the pool itself):** `POST /trip-planner/ideas`,
`GET /trip-planner/ideas`, `POST …/ideas/remove` as well as `…/ideas/share` and
`…/ideas/unshare`, plus migration 0179 (`idea_pool`, `idea_pool_shares`).

The way in is **the same as for a find** (§9.2) and not a second one:
coordinate, optional name, note, origin; the OSM entry is looked up, and if none
fits, the one permitted question is asked (how long?) instead of inventing a
duration. A second mention of the same place is merged — and adds only what it
brings with it: it never overwrites what someone wrote the first time.

**Shared** here literally means a list: `idea_pool_shares` has the same shape
as the participant list of a trip (§6.2) — people, no rights grid — and every
entry records who put it in. A pool into which nobody was admitted does not
exist for outsiders (`not_found`, not `permission_denied`): what does not belong
to you, you should not even know exists.

The columns for the **proximity rule** (`last_suggested_at`, `dismissed_count`)
and the **validity window** for dates (§20.4) are already in the table, so that
"reported once" holds up when §20.2 is built — remembered rather than deleted,
just as §7.1 remembers a "no".

**Done (§20.2):** the pool speaks up by itself, the tour proposal from several
nearby entries, and the area search ("find us something within 50 km"). This is
the part that turns the bookmark list into a day-trip planner — and it calls
`solveDay` with the location as anchor instead of inventing something new.
Built as `POST …/ideas/nearby` (one spot, one sentence, with quiet period),
`POST …/ideas/dismiss` and `POST …/ideas/outing`; the area search is the same
call with a named centre instead of a measured one, because the trigger is then
the free time and not the place. In the app: `TripIdeasNearbyView`,
`TripIdeasOutingView` and `TripIdeaNoticeMonitor`.

**Done (2026-09-13): an entry is editable.**
The pool could be filled and emptied, with nothing in between — an entry was
what it was on the day it was saved. For a planned spot there have been title,
note, link and duration of stay since the spot notes (§9.2); an idea is the
same place before it belongs to a trip, and precisely the sentences that decide
whether anyone goes ("entrance around the corner", "only until Easter") are
learned after saving.

`PATCH /trip-planner/ideas/:id` changes title, note, link, duration of stay,
validity window and the photo marker — all columns the table already has, so
without a migration. Omitted fields stay, empty ones are deleted: the same
three-state rule as for the spot note, and it now lives in `field-edit.ts`,
because two slightly different readings of "empty" are the way one screen
deletes what another has written.

In the app, the row is thus no longer a dead-end entry: it leads to the same
detail screen that a planned spot gets (`TripSpotDetailView`), with map,
category, Wikipedia and route — plus a pencil. The finds from "Entdecken"
(Discover, §9.2) lead to the same screen, just without the pencil: there is
nothing to correct yet there, because nobody has kept the place yet.

**Done (2026-09-13): the pool is grouped by place.**
Flat, the list is fine with five entries and useless with forty — the beer
garden two streets away and the museum in the neighbouring country sit next to
each other, sorted by when someone happened to save them. Grouping is done by
single linkage over 25 km, i.e. via the excursion distance from §20.2 instead
of a city boundary: what makes two entries belong together is that one
afternoon could hold both. A chain of villages thus remains one group, even if
its ends are further apart than the radius — the alternative would be a border
where nobody on site would draw one.

The groups are named by **Apple's geocoder**, not from the entries: the same
division of labour as everywhere (§9.1), Apple names, fk-encore plans. A name
derived from the entries would, with nine places, be named after whichever was
saved first. As long as no answer is available, the count is shown — honest,
as opposed to an invented place name.

### 20.2 The actual mechanism: the pool speaks up

The machinery for this is already fully in place. §7.1 monitors regions around
the next stops and reports events back to the device; §7.2 knows "what is
nearby" and draws **first from the stage's pool**. The idea pool is the same
move with a different reference:

- **A spot nearby.** "The beer garden that Anna saved is ten minutes from
  here." Once, not twice — and never again for the same spot in the same
  week, otherwise it is nagging (§6.4).
- **Several spots nearby: a tour proposal.** This is the point where a
  bookmark list becomes a planner. If three entries are close enough together,
  the question is not "do you want to go to this one?" but **"shall I make an
  afternoon out of it?"** — and the answer to that is a day plan, which
  `solver.ts` already computes today. A pool plus an anchor plus a time budget
  *is* the planner's input; only the occasion is missing.
- **An area instead of a coincidence.** Equally useful the other way round:
  "We are free on Saturday — find us something within 50 km." Then the trigger
  is not the location but the time, and the area is specified instead of
  measured.
- **Not only from the pool.** If too little is found, the region search may
  top it up — with the same ranking as in §7.2: what the family itself saved
  comes before what OpenStreetMap offers. Both are **marked**, so that "from
  us" and "found" remain distinguishable.

This turns the idea pool into a **day-trip planner** — and that is the actual
extension of the concept, not the list itself. So far this system plans
holidays; this plans Saturday, and it uses every existing building block to do
so.

**Implemented:** `POST /trip-planner/ideas/nearby`, `POST …/ideas/dismiss` and
`POST …/ideas/outing`.

*Proximity.* The response is sorted by distance and names who put the entry
in — "the beer garden that Anna saved" is the form that §20 demands. **Being
returned counts as having been reported:** the timestamp is set on delivery,
not when an app reports back that it has displayed it — an app that forgets
this would make the rule silently ineffective. After that there is a week of
quiet (`QUIET_DAYS`). Whoever only wants to see the list by distance sends
`markSuggested: false`; a screen is not the same as a notification.

*Swiped away.* `dismiss` counts up and leaves the entry in place. After three
"not now" it falls silent — but it remains in the pool, because nobody said
"get rid of it" (§7.1 remembers a no instead of deleting it).

*The outing.* `…/ideas/outing` is exactly what §20.5 describes: a call to
`solveDay` with the location as anchor, **one** block over the time budget and
the pool as candidates. An outing is one block, not a four-part split — that
belongs to a holiday, not to Saturday afternoon. What the family saved goes
into the selection with a head-start bonus and thus ranks before what the
region search tops up; both are marked in the result (`fromIdeas`).

Two things that were decided along the way. The planner's **leg limit** value
(40 minutes) is a *walking* budget: right within a city, wrong for an outing —
half an hour by car is the way to the lake, not a detour. A larger limit
therefore applies to car and public transport. And **expired dates** are not
even considered: an exhibition that ended on Sunday is no longer an idea
(§20.4).

What is still missing: carrying an accepted proposal over into a real one-day
trip (§20.3) — the path for that is `POST …/finds`, and it exists.

### 20.3 How it relates to the trip

Not a second mechanism, but one more source:

- **When creating a trip**, entries of the idea pool that lie in one of its
  stages are offered — not adopted automatically. "You have collected four
  ideas for Lisbon" is a question, not an action, because an idea from last
  year is not automatically the wish of this trip.
- **Adopted** via the same path as a find (§9.2, `POST …/finds`): right stage
  by location, duplicates merged, origin preserved. The entry stays in the
  idea pool in the process — it is not used up, only used.
- **The other way round**: what was left over in the stage pool on a trip and
  nobody looked at may move into the idea pool at the end. "Next time" is the
  most honest place to file a spot that did not make it into the plan.

**Implemented:** `POST /trip-planner/ideas/outing/accept`,
`GET /trip-planner/plans/:planId/ideas`, `POST …/plans/:planId/ideas/take` and
`POST …/plans/:planId/pool/to-ideas` — all three directions via existing paths,
no new mechanics.

*Accepted outing.* Exactly what §20.5 announces: a perfectly ordinary one-day
trip with one stage and **one** block over the time budget. The day is
deliberately planned out only **after** the accepted ideas are in the pool —
otherwise it would plan itself from the region search and the ideas would come
afterwards. They go in with a raised rating so that they rank before what the
map offers (§7.2). The response states separately what ended up on the day and
what stayed in the pool: an outing that fits is shorter than the one someone
wanted.

*When creating a trip.* `GET …/plans/:planId/ideas` offers what lies in a
stage — sorted by stage and distance, with "who saved it".
**Nothing is adopted on its own**; for that there is `…/ideas/take`, and it
runs via `POST …/finds` (§9.2): right stage by location, duplicates merged,
origin preserved.

*Back into the pool.* `…/pool/to-ideas` moves leftovers into the collection.
Something already collected is not an error in the process, but is counted and
reported.

**In all three directions the idea stays put.** §20.3 says it literally: not
used up, only used. One detail noticed along the way: a place that the map does
not know gets a **new** `manual:` reference as a find — the idea's own
reference is then no longer good for recognition. "Already in the trip" is
therefore decided over the same 80 metres with which `finds.ts` calls two
entries the same place; a different number here would let the same beer garden
be both "already included" and "duplicate" at once.

### 20.4 Events: interesting, but without a source no feature

An idea pool that also knows dates — concert, market, exhibition until Sunday —
would be worth considerably more than one made up entirely of permanent
places. But the open question hangs on exactly this: **there is no good
source.**

What exists is each only half usable:

- **OpenStreetMap** knows event *venues*, not events.
- **Municipal portals** have usable data, but every city has a different
  format; some deliver iCal or RSS. This does not scale beyond a district, but
  is astonishingly viable for one's own area — and one's own area is exactly
  the case the idea pool is meant for.
- **Commercial aggregators** (ticket providers) would have coverage, but bring
  licence terms and paid ranking with them — this concept decided against both
  (§3.8, §10.7, §19.4).
- **Wikidata/Wikipedia** are suited to recurring major events, not to the
  weekend.

The order follows from this, not a rejection: **The idea pool is built without
events** and gets them retrofitted as a source of their own as soon as one
exists that withstands the standard. As a first step, the realistic form is an
**iCal subscription per source**, which the household enters itself — like a
calendar subscription, with the same trust model and without a provider in the
data path. A date is then an idea-pool entry with a validity window, and
everything else — proximity, tour, adoption into a trip — applies unchanged.

What is expressly **not** done here: scraping events together from web pages.
That is the point where detection without evidence begins, and §9.3 has a
clear answer for that — an entry without a verbatim quote is dropped.

**Status: will not be built for now.** Not because the benefit is missing, but
because the prerequisite is: without a source there would only be an empty
list with mechanics attached. The rest of §20 is deliberately built so that a
date upsets nothing later — an idea-pool entry with a validity window, and
proximity, tour and adoption into a trip apply unchanged. This will be reopened
as soon as a source exists that withstands the standard; the realistic first
form remains the iCal subscription per source, which the household enters
itself.

### 20.5 What data it needs

Little, and almost all of it exists:

- `idea_pool` — the same columns as `plan_pool` (§12), without `leg_id` and
  with `household` reference, `created_by` and an optional validity window for
  dates.
- A **proximity rule** per entry, so that "reported once" holds up: when last
  suggested, how often swiped away. The same mechanism with which §7.1
  remembers a "no" instead of deleting it.
- The **tour proposal** needs no new table: it is a call to `solveDay` with the
  location as anchor and a time window, and what comes out is either a
  proposal on screen or — if accepted — a perfectly ordinary one-day trip with
  one stage.

That is why this extension, despite its scope, is late and cheap: it invents no
mechanism, it gives the existing ones a second occasion.

---

## 21. Still to be worked through: 22-day cruise

The cases in §16 to §18 have been worked through and have changed the concept.
This one has **not yet** — it is here because it presses on a spot where the
existing mechanics do not merely get tight but mean something different.

**The case:** a cruise, 22 days, Hamburg to New York. In between, ports with
shore excursions and sea days without. Beforehand one to several nights in
Hamburg, because one does not arrive on the day of departure.

### 21.1 The fundamental question: one trip or many?

The obvious shortcut would be to plan each shore visit as a small trip of its
own — a day trip like Nuremberg in §18, ten times. That **already works
today**, without a line of rework, and is the honest stopgap for the time
being.

Still, it is the wrong answer. **It is one trip.** Everything that hangs off a
trip hangs off this one: the travel group (§3.5), who plans along (§6), the
shared pool, the packing list (§8.6), the trip readiness, the retrospective
(§8.7) and the offline bundle (§3.9). Ten trips mean ten packing lists and ten
retrospectives for one voyage. And the one thread you must on no account lose —
when the ship departs — belongs to the whole, not to ten single days.

§4.2 already says it: a stage is "a city or **station** of the trip". A port
day is a station. The structure is thus: Hamburg (hotel) as an ordinary stage,
then one stage per port with exactly one day, the sea days in between.

### 21.2 What already fits

More than one would expect — which speaks for the stage mechanics:

- **A port day is a stage with one day.** §18 proved exactly that: the anchor is
  not the hotel but the station. Here it is the berth.
- **Arrival and departure** are there: `arriveMinutes` per stage (§4.2) and the
  `departure` fixed point (§4.4), after which the day is over. "Ashore from 8
  a.m., back on board at 4:30 p.m." is exactly this form.
- **A booked shore excursion** is a fixed point that frames a block and brings
  its spot along — the same mechanism as the evening light in §7.3
  (`blockId` + `spotRef`).
- **A pool per stage** (§4.2) means: own candidates per port. Correct.
- **Offline** (§3.9) is more important here than anywhere else: there is no
  network at sea, and roaming in port is expensive.

### 21.3 What is missing, and why it is not a detail

Six points. The first three are model questions, not conveniences:

1. **A day without a place.** A sea day has no anchor, no region, no pool — and
   in the middle of the Atlantic there is no Geofabrik extract. Today every
   stage needs an anchor, and the region router would find nothing for this
   coordinate and report that as an error. The buffer day from §7.2 is the
   closest thing, but means something different ("left free because of
   weather"). A sea day is not an empty day: it is a day **on board**, with its
   own programme, just without a map.

2. **The accommodation travels along.** In the glossary the anchor is "the
   accommodation", where every day begins and ends. On a ship the accommodation
   is the same for 21 days and yet somewhere else every day. For the individual
   port day the berth works as an anchor — but everything that assumes "a stage
   change means a hotel change" (§8.6 the evening before, the transfers in
   §4.2) is then no longer true.

3. **The transfer is the quarters.** §4.2 treats the way between two stages as a
   planning object with corridor search. Between two ports, the transfer is the
   ship, overnight, and there is nothing along the way. The corridor search
   would look for spots in the middle of the Atlantic. A transfer must be
   allowed to say: *this one is not planned.*

4. **Departure is a deadline, not a departure.** A missed train costs an hour; a
   missed ship costs the trip. The default buffer of 20 minutes (§4.4) is off
   by an order of magnitude here, and for tender ports the boat ride ashore and
   back comes on top. This is not a number you change but a property that the
   fixed point must know.

5. **Time zones shift in the middle of the trip.** Hamburg to New York is five
   to six hours, and the ship adjusts the clock overnight. Fixed points are
   stored as minutes after midnight **local to the stage** — the right form. But
   a day with 25 hours appears nowhere in the concept.

6. **Ten ports are ten regions.** Lisbon, Azores, Bermuda, US Northeast — each
   its own extract, imported weeks in advance. That is the admin problem from
   §16.1, times ten, and the reason why preparation starts earlier than
   planning here.

### 21.4 What follows

No rework before the case has really been worked through — §16 to §18 have
shown that the walkthrough finds the gaps and thinking about it does not. What
is to be recorded is the direction: **one trip with stations**, and the three
model questions above (placeless day, travelling accommodation, unplanned
transfer) together are a stage of work in themselves — not three small
additions.

Until then the stopgap from §21.1 applies: plan the shore visits individually
and know what you are missing in doing so.

**Addendum (2026-10-02):** The three model questions are answered without a
new kind of stage being needed — see §22.7, "Mitfahrende Unterkunft und
Seetage" (accommodation that travels along, and sea days). Still open are
point 5 (time zones) and point 6 (preparing ten regions); both are an
operations topic, not a model one.

---

## 22. Open: spots along the way — the built mechanism without its use case

> We are going there by car. On the way we pass interesting things after all —
> a small detour would be worth it to us.

This wish has already been answered twice in the concept, and still nobody can
use it today. That is why it stands here as an open case of its own and not as
a new idea: what is missing is not the difficult part.

### 22.1 What already exists

- **The calculation** (§4.2): Spots that lengthen the drive by at most *n*
  minutes are the points inside an **ellipse with start and destination as foci**.
  A single condition in PostGIS that cuts a narrow band out of a whole
  country, entirely without a router.
- **The worked day** (§17.2): Augsburg–Prague, check-in only from 3 p.m.
  The check-in there is not the obstacle but the **source** of the free
  window — whoever sets off at eight would otherwise stand in front of a closed
  reception at twelve. The intermediate stop of about two hours sits in the
  midday block, and the detour time appears as a metric on the proposal ("+5
  min.", "+25 min.").
- **The endpoint**: `POST /trip-planner/corridor`, including the three
  decisions in §13.1 step 6 — the budget counts outbound **and** return, the
  ellipse extends beyond both foci, and both ends must lie in the same
  imported region.

### 22.2 Why the case is still open

**Nobody calls it.** Neither the iOS app nor the web knows the endpoint. A
built endpoint that no UI reaches is, for the traveller, not a feature — it is
an assurance that nobody can redeem.

**And there is no path from the result into the day.** The answer is a list.
§17.2 says "a small pool …, which you decide on" — only there is nothing to
decide: no call turns a found spot into a stop in the arrival day.

### 22.3 What the case demands

Four things, and only the last is difficult:

1. **The occasion, not the search.** The question is asked because a transfer is
   coming up and the day has slack — not because someone opens a search screen.
   §4.6 has just shown the form: measure, then a proposal that writes nothing.
2. **The budget from the day, not from thin air.** Not "n minutes" as a set
   number, but what the fixed points yield: departure plus driving time
   against the check-in. §17.2 calculates exactly that — and the same
   calculation applies backwards on the departure day (§4.4).
3. **The metric on the proposal.** "+25 min." is what a detour is weighed by,
   and it must be where the decision is made.
4. **Where the stop belongs.** This is where the real question lies.

### 22.4 The model question: a stop that belongs to no stage

Today a stop hangs off a block, a block off a day, a day off a stage — and a
stage off its anchor. A corridor stop fits none of these: it takes place
**along the way**, between two anchors, and the day continues afterwards.

The day anchor (§4.5) is the closest thing and means something different: "this
day takes place there", with outbound and return from this day's blocks. An
intermediate stop is not a destination but an interruption.

That leaves two paths, and it is the same kind of question as in §21:

- **The transfer learns to carry stops.** §4.2 already calls it a planning
  object; today it is a fixed point that eats half a day, and carries nothing.
  That would be the honest place — and §21.3 wants the transfer to be able to
  say more than today anyway (there: *this one is not planned*).
- **The arrival day commits to a block whose place is not at the anchor.** Less
  rework, but it weakens the rule that a day is planned around one place — and
  that is exactly what carries the block budgets.

### 22.5 What follows

The difficult part is done: the ellipse is in place, tested, and works without
a router. What is missing is the path from the endpoint into the day, and that
hangs on the question from §22.4 — which shares a common root with §21's
"placeless day" and the "travelling accommodation": **The model knows places
where you stay, and none that you pass.**

Until then the stopgap, and it is usable: create the intermediate stop as a
find (§9.2) and place it by hand in a block of the arrival day. The plan will
then compute the travel time wrongly — it measures from the stage's anchor
instead of from the route — but the stop is in the day, with name and
duration, and nobody forgets it on the way.

### 22.6 The variants, compared (2026-09-28)

*Submitted for decision, not yet decided.*

**A finding up front: The transfer day has two homes today.** §16.3 writes
"Tokyo 3.–11.9., Osaka 11.–18.9." — the 11th belongs to both stages, morning
Tokyo, afternoon Osaka. The code sees it differently:

- `redateLegs` dates stages seamlessly *one after another*. The departure lies
  on Tokyo's last day, the arrival on Osaka's first — one calendar day later.
  A four-hour journey is spread over two dates.
- If you enter the dates by hand overlapping, the app declares the shared day
  an error and takes the earlier stage (`TripPlan.position(on:)`). Osaka's
  arrival day then never becomes "today": no arrival question, no fence around
  the new hotel, no Live Activity for the afternoon.

This is the same root as §21 and §22: the way between two places has no room in
the model, so it is spread over two stages that are both only half responsible.
Each of the three variants must therefore also answer this question, not just
the one about the intermediate stop.

**Variant A — the transfer becomes an object of its own.** A table
`trip_plan_transfers` between two stages: date, departure (place, time),
arrival (place, time), means of transport, "is planned / is not planned" and
its own stops. The transfer day then shows three parts: the morning of the old
stage, the journey with its stops, the afternoon of the new one.

- *Carries:* intermediate stops (§22), the unplanned transfer of the cruise
  (§21.3 point 3), the travelling accommodation as a property of the transfer
  ("overnight on board").
- *Does not carry:* the sea day (§21.3 point 1) — a transfer that lasts a whole
  day is again a day without a place, just in another spot.
- *Costs the most:* a new container for stops next to the block. Everything
  that today assumes "stop belongs to block belongs to day" needs a second path
  — saving, moving, redistributing, ticking off, fences, the offline bundle, the
  Live Activity, the retrospective, the voting. And the rule "same actions
  everywhere" demands one more surface for stops.
- It solves the two-homes finding only half: morning and afternoon still belong
  to two stages, and the day needs a view that composes three things.

**Variant B — a block gets a place of its own.** The arrival day receives an
"on-the-way block" with start and destination instead of the stage anchor; its
pool comes from the corridor search. Stops stay in blocks.

- *Carries:* intermediate stops, with the least rework — `solveDay` already
  knows start and destination per day (`dayWalkOf`), which would mean: per
  block.
- *Does not carry:* the sea day, the unplanned transfer, the travelling
  accommodation. And the two-homes finding not at all.
- *Costs:* the rule that a day is planned around one place. That carries block
  budgets, redistribution and light; a block with its own place becomes a
  special case in each of these calculations.

**Variant C — the journey becomes a stage of its own kind.** A stage gets a
kind: `stay` (as today), `transit` (on the way from the previous to the next)
or `aboard` (a day without a map). A transit stage has one day. Its start is
the anchor of the previous stage, its destination that of the next, its pool the
corridor search. It is planned with the solver that exists: `solveDay` with
different `start` and `end` is the day trip from §4.5, only with two ends
instead of one.

- *Carries:* intermediate stops — the corridor spots are the pool of the
  transit stage, and redistributing, ticking off, fences, voting and offline
  run without a new path, because everything already runs per stage. The sea day
  as an `aboard` stage: no anchor, no pool, no region, the on-board programme as
  fixed points. The unplanned transfer: a night crossing between two ports is
  not a stage at all, the port afterwards begins the next morning. And the
  two-homes finding: the transfer day is **one** day in **one** stage, with the
  morning at the old place — the ellipse includes the surroundings of both
  ends — and the evening at the new one.
- *Does not carry by itself:* the travelling accommodation. It is a property of
  the stage ("accommodation as before") that the evening before (§8.6) and the
  fence around the quarters must read — in every variant additional work.
- *Costs:* a `kind` column on the stage, an optional anchor for `aboard`, a
  region router that knows "no region" as an answer rather than as an error,
  and in the app a header row of its own for transit and on-board days. What
  today assumes "a stage change means a hotel change" must ask the kind.
- *Changes a habit:* The journey is no longer a fixed point at the edge of two
  days but a day in itself. Whoever plans "museum in the morning, then onwards"
  plans that in the transit day. The previous form (departure as a fixed point,
  later arrival) remains for trips without a transit day, and existing plans do
  not change.

**What is added in every variant.** The corridor search today requires that
both ends lie in the *same* imported region. Augsburg–Prague lies in two
Geofabrik extracts; the search must search per region and merge the hits. And
the driving time needs a place in the day budget: a four-hour drive is not a
way between two stops but a block that holds time like the meal in §10.3.

**Recommendation: C.** It is the only one that answers all three model
questions from §21.3, the intermediate stop and the two-homes finding with one
concept, and it builds on what the model does best: everything built so far
works per stage. A would be cleaner if one started from scratch, but doubles
every stop mechanic. B is quick and answers only the question one started from.

Open for the decision, if C is chosen:

1. **Whole days only?** A transit stage has exactly one day. A one-hour onward
   journey that does not deserve a day of its own would then stay with the
   existing fixed point. The alternative — a transit stage of half a day —
   shares the date with its neighbours again.
2. **Who creates the transit day?** Proposal in the spirit of §4.6: measure
   (journey longer than two hours, the day has slack), then *one* proposal that
   writes nothing. By hand it always works.
3. **Order.** First `transit` (the case from §22, with real demand), then
   `aboard` and the travelling accommodation, when the cruise (§21) actually
   comes up.

### 22.7 Decided: C, with points in time instead of whole days (2026-09-28)

**Variant C.** And on the three open points:

1. **An onward journey has a beginning and an end, each with date *and*
   time.** No whole days: that makes journeys of two hours as possible as those
   over several days (night train, ferry). The previous stage ends with the
   departure, the next begins with the arrival — a calendar day can thus
   contain morning in Tokyo, journey and evening in Osaka. Which stage currently
   applies is thus no longer decided by the date alone, but by date and time.
2. **The app may propose** (in the sense of §4.6: measure, one proposal, write
   nothing). Creating by hand always works.
3. **`transit` first**, `aboard` and the travelling accommodation later.

How this fits into the existing model:

- An onward journey is a stage with `kind = transit`, with the anchor of the
  **next** stage as destination and the anchor of the previous as starting
  point (`origin_*`). Its days run from the departure date to the arrival date.
- Beginning and end are fixed points that already exist: an appointment
  "Abfahrt" (departure) with the origin at the first day (the day starts from
  there, `day-ends.ts`) and a `departure` "Ankunft" (arrival) with the
  destination at the last (the day ends there).
- The previous stage gets the departure as a `departure` on its last day and
  ends on the departure date; the next begins on the arrival date with the
  arrival as a late start of the day. Subsequent stages shift accordingly.
- **Only what can be planned is planned:** an onward journey within one day by
  car, bike or on foot. It gets a single block "Unterwegs" (on the way) over
  the whole time window, its pool is the corridor search, and the solver
  computes the drive from start to destination as base load — a stop only gets
  in if its detour still fits in the window. By rail or plane, or over several
  days, the onward journey remains a frame without stops: it says where you
  are, and plans nothing into it.
- The corridor search from now on searches in **every** imported region that
  covers start or destination, and merges the hits. Since 2026-09-29 also in
  every region whose rectangle touches the corridor ellipse: a journey from
  home to the coast leads through extracts that contain neither of the two
  ends, and the monastery halfway lies in one of them. The router checks the
  ends precisely (polygon and data sample), the middle only against the
  rectangle — a region that does not reach the corridor after all answers with
  nothing, and that costs one query and nothing else.
- **An onward journey dates the trip** (2026-09-30). Whoever gives a trip
  without a date its journey there has thereby dated it: the arrival day is the
  first day of the first city. From a city, the departure day is its last, and
  the first travel day is counted back over the cities before it. Nobody has to
  switch on "Termin steht fest" (date is fixed) first.
- **Home once, not per trip** (2026-09-30). The place of residence is in the
  settings (`trip_user_homes`, `GET/PATCH /trip-planner/home`) and is carried
  over into every new trip; a trip can have a home of its own, and the first
  one anybody gives a trip becomes their place of residence as long as none is
  set. An older trip without a home offers the place of residence for adoption.

Build stages: (1) Server — model, creation, planning, which stage currently applies;
(2) App — display, creation and editing, "today" by time of day; (3) the
proposal.

**Build stages 1 and 2 implemented.** `POST …/plans/:planId/transits` creates an
onward journey between two dated stages and frames both neighbours
(`transits.ts`), `transit-leg.ts` plans it, `running-day.ts` and, in the app,
`TripPlan.position(on:)` decide by date and time which stage currently
applies. The trip duration counts calendar days instead of stage days
(`calendarDayCount`), otherwise a day with an onward journey would be counted
three times. In the app, the onward journey appears in the city list between
two cities, with „Weiterreise einfügen" (insert onward journey), and its day
shows "Start → Ziel" instead of the accommodation.

**Build stage 3 implemented: the proposal.** `GET …/plans/:planId/transit-suggestion`
measures the journey between two consecutive, dated places without an onward
journey in between (car or bike). From two hours it proposes *one* onward
journey: departure at ten on the last day of one place, arrival at the time the
next place expects, otherwise after the drive plus two hours for stops. Nothing
is written. The app shows the proposal as a card above the city list; „Ansehen"
(View) opens the onward-journey screen prefilled with it, „Nein" (No) is
remembered by the phone.

**Editing in place.** `PATCH …/plans/:planId/transits/:legIndex` takes new
points in time and a new means of transport and frames the neighbours exactly
as creating does. The onward journey keeps its row, its position and its name.
Previously it was deleted and recreated; if the recreation failed, it was gone.
Now a rejection leaves everything as it was.

**Outbound and return (implemented).** The wish behind it was never the onward
journey as such, but the way: finding and planning interesting things on the
journey there, between two places and back — also via voting. For that the trip
now has a **home** (`PATCH …/plans/:planId/home`, migration 0217). With it,
outbound and homeward journeys are onward journeys like those between two
places: `afterLegIndex: -1` is the way from home to the first place, the
position of the last place the way back. Both have the same corridor search as
their pool, and because voting works per stage (§6.1), the places along the way
can be voted on like any other — "lieber nicht" (rather not) takes a stop out
again at the next planning. The proposal also knows both ends (outbound first,
homeward last). In the app, the home is at the top of the city list; before it
„Anreise einfügen" (insert outbound journey), after it „Heimreise einfügen"
(insert homeward journey).

**Travelling accommodation and sea days (implemented, 2026-10-02).** The cruise
from §21 gets by with what exists — decided against the stage kind `aboard` of
its own from §22.6, because that would have rebuilt everything the onward
journey can already do (points in time, start, destination, "plan nothing", the
decision by date and time), and would have made anchor and region optional
everywhere.

- **The voyage between two ports is an onward journey with the means of
  transport `ship`** — overnight or over sea days, up to seven days. Nothing is
  planned into it; its days are called „An Bord" (On board; instead of
  "Unterwegs"), and the on-board programme is appointments as on any other day.
  A place cannot be travelled to by ship: the "Fortbewegung" (means of
  transport) selection offers the ship only on the onward-journey screen.
- **A port day is an ordinary stage whose anchor is the berth**, with the
  property `quartersAboard` („Unterkunft fährt mit", accommodation travels
  along; migration 0223). The property takes effect in exactly one place: the
  departure that an onward journey writes onto the last day of the stage being
  left is then called **„Alle an Bord"** (All aboard) and holds **60 minutes**
  of buffer instead of 20 (`aboard.ts`); a **tender port** (`tenderPort`) adds
  **30 minutes** for the boat ride. Whoever changes the property afterwards
  gets the departure rewritten, provided an onward journey leaves the stage —
  that replans the last day and is therefore excluded on a day already begun,
  like any other replanning.
- In the app: when creating a city and when changing it, under „Unterkunft"
  (accommodation) or „Auf dem Schiff" (on the ship); the city list shows
  „Unterkunft an Bord" (accommodation on board) on the port day and the ship on
  the onward journey; the day header of a sea day says „An Bord · Hafen →
  Hafen" (On board · port → port).

What is *not* solved with this: the time zone moves with the ship, and a day
with 25 hours still does not appear in the model (§21.3 point 5).

Found along the way: inserting or deleting a stage *before* two or more others
failed on the uniqueness of `(plan, position)` — the renumbering in one step
collided row by row. It now runs via negative intermediate values.

## 24. Router: real travel times in tiers (2026-09-30)

Up to here, the planner computes every travel time as straight-line distance
times a detour factor (§4.5, `travel.ts`). That is enough for blocks that only
need sums, and it keeps the planner pure and offline-capable. But it is
measurably wrong where a road does not run straight — a river without a
bridge, a bay, a pass — and it knows nothing about timetables. The router comes
in three tiers, each usable on its own; what it does not know, the planner
continues to say (§15.3, §9.5).

**Tier 1 — the service is up (implemented).** A `routing` container (Valhalla)
builds its tiles from the same Geofabrik extracts that the region management
already downloads: `geo_data/pbf` is mounted read-only, the tiles live in
`routing_data`. One tile set for all regions; a new region is routable only
after a restart of the container (the entrypoint rebuilds when an extract is
newer than the tiles). In the backend: `router-client.ts` (status, matrix,
route), `travel-table.ts` (one matrix per day, the solver reads from the table,
everything else remains an estimate), `GET /trip-planner/routing/status`
(reachable, tiles, build date, and whether a region is newer than the tiles)
and `POST /trip-planner/routing/compare` (estimate next to router for a pair —
the measurement that §14 demands before the router determines the plan). Public
transport is not yet queried from the router: without a timetable the
pedestrian answer would be worse than the estimate.

**Tier 2 — the plan computes with it.** `planLeg` builds a table over anchor
and candidates before the solver (at most 120 points, otherwise estimate), the
onward journey measures its driving time on the router, the corridor search
orders the survivors by real detour. The day carries `travelSource` (router or
estimate), and the app shows it at the travel time. Only after the measurement
from tier 1: where the estimate is off by more than a quarter, it pays off.

**Of this implemented: the corridor along the road (2026-10-04).** From
practice: the candidates of a journey there sat almost all on the straight
line, because the ellipse around the two ends is only a few kilometres wide at
a few hundred kilometres, and the motorway runs elsewhere. Now the corridor
search asks the router for the route and up to two alternatives (`routes` with
`alternates`, `route-corridor.ts`), puts a tube of half the detour budget
around each (a place `d` metres beside the road costs about `2d`) and searches
in geo along these lines (`path` instead of `corridor` in `POST /pois/search`:
`ST_DWithin` to the line, detour as double the distance). The regions come from
the rectangle around all routes, not around the straight line. What comes back
is re-measured on the router — start→place and place→destination as two
matrices over at most 120 candidates, minus the route —, sorted by this driven
detour and discarded above the budget. Without a router, without tiles or
without a shape it stays with the ellipse; `POST /trip-planner/corridor` says
with `source: router | estimate` which of the two. Not yet connected: the
travel times *within* the day (the solver continues to estimate) and the table
for the city days.

**Tier 3 — GTFS (postponed, 2026-09-30).** Timetables per region (region
management: feed URL, import into Valhalla), `transit` is queried
multimodally with a departure time, the offline bundle keeps the times. Not
built for now: public transport stays with the estimate, the router is not
queried for it.

**The measurement by button (2026-10-01).** `POST /trip-planner/routing/measure`
walks through the caller's planned days the way the planner walks them — day
anchor or accommodation, the stops in block order, back — and asks the router
for each leg once (at most 80, without transit stages and without public
transport). What comes back, per means of transport, is how often the estimate
is off by more than a quarter (and at least 3 minutes), the typical deviation
and the five legs where it is furthest off. "Pays off" means: on at least a
quarter of the answered legs. In the app under Einstellungen › Trip & Reise ›
Reisezeiten prüfen (Settings › Trip & Travel › Check travel times), on the web
on the system status page in the routing tile. Nothing changes in the plans.
Until tier 2 is built, the planner continues to plan with the estimate —
`travel-table.ts` is ready but not yet connected.

**The router is visible** on the system status page in the web admin (tile
"Routing": reachable, tiles built on, newest region, and the notice when a
region is newer than the tiles).

Still open: storage (tiles ≈ one third of the PBF size) and memory during the
build (a few GB for Germany); tier 1 measures both in operation.

**Deleting a region takes the tiles with it (2026-10-01).** The geo service
deletes the region's downloaded extract along with the region and every six
hours cleans up extracts whose region database does not exist (older than a
day, no import running). The routing container compares the set of extracts
every ten minutes during operation; if a change persists for one further check,
it terminates itself, Compose restarts it, and it rebuilds from scratch —
tiles and administrative boundaries, nothing of the deleted extract remains.
Overlapping extracts are first merged into one file by `osmium merge`.
Downloads first land as `.part` and are renamed after completion, so that an
aborted download does not count as a finished extract.

**Follow-ups from practice (2026-10-05).** An onward journey is anchored at
the place of arrival, i.e. exactly at the anchor of the following stage. For a
shared find (§9.2) or an article proposal (§9.3), `chooseLeg` chose the nearest
stage by distance; the onward journey was equally near and won, and the spot
ended up in "Weiterreise nach Reykjavík" (onward journey to Reykjavík). Now the
stage gets the find as soon as one is within reach; an onward journey only if
no stage is near — a place along the way (§24). And the limit of a trip counts
stays (twenty), not stages: with onward journeys as stages it was over at six
cities.

## 23. Idea for later: the audio tour

*From testing, noted as a wish — not planned, not begun.*

There are apps like "Lauschtour": a tour is given, all you need is headphones,
a text tells you where to go, and as soon as you reach the next spot, the app
speaks up by itself and tells you what you have in front of you. Something like
that belongs in the planner too: the planned day *is* already a tour — a
sequence of stops with paths in between —, and the fences around the stops
(§7.1) are exactly the trigger that an audio tour needs.

What would already be there:

- **The tour**: the day with its order, the paths in between, and "Warum hier?"
  (Why here?) per spot (§3.8) as the core of what would be said.
- **The trigger**: the fence around each open stop of the day (§7.1) — today it
  asks "were you here?", it could just as well say "you're here, listen".
- **The speech output**: iOS reads text aloud (AVSpeechSynthesizer), with
  headphones and in the background, without the app having to be in front.

What is open, and it is the main thing: **Where do the texts come from?** The
candidates, each with a catch:

- **Wikipedia** (§10.4 already links the article): free, often available, but
  an encyclopedia article is not a narrative text for a walk.
- **The local language model service** (llm-service, §9.3 uses it for
  reading): could make a listening text from Wikipedia and the planner's
  reasons — with the risk that §15.3 names: an invented year sounds as
  confident read aloud as a correct one.
- **Own texts**: the family writes or dictates something about each spot before
  the trip — honest, but work, and not there for the random spot along the way.
- **Third-party audio tours**: Lauschtour and similar are content, not open
  data; at most a link could be integrated ("there is an audio tour here").

Until that is decided, it remains an idea. The cheap first step, if it is ever
wanted: when entering the fence, read out the spot's name and its "Warum
hier?" — that is not an audio tour, but it is the scaffolding into which one
would fit.

---

## 25. Simplification: three levels, three places (2026-10-04)

From practice: with every requirement a menu item had been added, and in the
end the three-dot menu of the day screen had nineteen entries in four groups.
The groups did not follow what someone is currently working on: "Diese Reise"
(This trip) contained the candidates and the wishes (which belong to the stage)
next to cities and settings (which belong to the trip), and the structure of
the trip — stages, onward journeys — was one entry among many, although the
upper area of the screen has long shown it.

The finding behind it: there are not two levels but three — **trip**, **stage**,
**day** —, and the middle one had no place. Everything belonging to it
therefore lay in the menu.

### 25.1 The rule

Each level has exactly one place on the day screen, and each action lies in
the place of its level:

- **Trip — the stage bar at the top and the "Reise" (Trip) menu.** The bar shows
  the stages (always, even for a single one); to the right of it, fixed at the
  edge and not scrolled along, the pencil: the structure editor, in which
  stages are added, moved, removed and onward journeys, outbound and homeward
  journeys are inserted (`TripLegsView`, as a sheet with „Fertig" (Done)). The
  chips of the bar and the pencil are 44 pt high — the size Apple demands for a
  control.
  The menu now contains only what belongs to the whole trip: Einstellungen
  (Settings), Planen mit (Plan with), Reisegruppe (Travel group), Dokumente
  (Documents), Änderungen (Changes), Reisebereit? (Ready to travel?), Danach
  (Afterwards), Unterwegs ohne Netz (On the road without network).
- **Stage — the stage header row.** A card with an arrow like a list row, the
  first row in text colour: the most important entry point of the screen must
  not look like a footnote. A tap opens the stage sheet
  (`TripLegSheet`): at the top the stage itself (accommodation, length, date,
  means of transport; for an onward journey departure, arrival, means of
  transport), then **Hinzufügen** (Add; search for a place, create a route,
  routes nearby, adopt from the ideas — five ways to one destination, the
  stage's pool) and **Vorrat** (Pool; candidates, wishes, day trip). An onward
  journey has the same pool and the same wishes — the places along the way —
  and opens the same sheet.
- **Day — the lower area.** Fixed times, excursion destination, evening light
  are in the frame of the day; stops, search for a place, replan, map on the
  blocks. None of this is in a menu.

The distribution of the former menu items:

| Formerly in the menu | Level | Now |
|---|---|---|
| Städte | Trip | „Etappen" at the end of the stage bar |
| Einstellungen, Planen mit, Reisegruppe | Trip | Menu „Reise" |
| Dokumente, Änderungen, Reisebereit?, Danach, Unterwegs ohne Netz | Trip | Menu „Reise" (and as before the trip list) |
| Kandidaten, Wünsche, Tagesausflug | Stage | Stage sheet, „Vorrat" |
| Ort suchen, Strecke anlegen, Strecken in der Nähe, Aus den Ideen übernehmen | Stage | Stage sheet, „Hinzufügen" |
| Abendlicht | Day | Frame of the day |

A day of the onward journey into which nothing is planned — at sea, on the
train, over several nights on the road — shows a card „An Bord" or
„Unterwegs" respectively with the window of this day („Bis 08:00, Ankunft
Reykjavik — danach beginnt die nächste Etappe", i.e. until 08:00, arrival
Reykjavik — the next stage begins afterwards) instead of a buffer day with
„Diesen Tag jetzt planen" (Plan this day now); the server rejects planning such
a day. Departure and arrival of the onward journey appear without an X in the
frame of the day: they are the frame of the onward journey and are changed in
its editor; the server rejects their removal (`isJourneyEnd`) instead of
silently writing them again at the next replanning.

### 25.2 A new trip

The creation dialog asks only what a trip needs to come into being: name, first
city, length and date, means of transport. Further cities, onward journeys,
outbound and homeward journeys, who travels along, pace and what is searched
for — all of that happens afterwards in the same places as with later changes.
The sentence interpreter and the interests have been taken out of the dialog;
the former because it set things the dialog no longer shows, the latter because
they are in the settings and there all of them are on at the start anyway
(§8.1).

### 25.3 Stage B: wishes on the map

The wishes map showed blue discs with a question mark: they said that nobody
has voted yet, and nothing about what is in front of you. Now each pin carries
the **symbol of its category** on a light background and **your own answer as a
ring** around it (blue open, green „will ich" (I want to), pink heart's desire,
grey „egal" (don't care), red „lieber nicht" (rather not)); the legend draws
the same rings. `TripSpotMapPin.ringTint` is the switch for that, the other
maps keep their filled dots.

The sheet behind a pin shows the voting row and **below it the place itself** —
map section, name on site and in OpenStreetMap, route, „Warum hier?", the
Wikipedia link and „Alle Details" (All details) — instead of hiding the details
behind a second tap on the i (§3.8: whoever votes on a word votes on a word).

The **map section** of a spot (`TripSpotMapSnippet`, in the sheet and in the
detail view) is no longer an image: it zooms in place (zoom only, no panning —
it sits in a list, and a map that takes over dragging is a list that no longer
scrolls) and carries in the corner a button that opens the map app chosen in
the settings.

### 25.4 Stage C: the article in the sheet

„Artikel lesen" (Read article) opened Safari; if the article was Italian, the
footer said so and left the reading to iOS. Now the article comes into the app
(`TripArticleView`, reachable from the detail view, the pin sheet and the wishes
sheet), via `GET /trip-planner/wikipedia/article?url=…` (`wiki-article.ts`,
`wikipedia-client.ts`):

1. **German, where German exists.** The link from OpenStreetMap names the
   article in the national language; Wikipedia's language links say whether the
   same place has a German one, and that is shown.
2. **Otherwise translated.** The text goes section by section to the
   llm-service (`/json-prompt`, up to `MAX_TRANSLATED_CHARS`). On a local model
   that takes minutes, so the server first answers with the original and
   `translation: "pending"`, keeps working, and the app asks again every few
   seconds until `"done"` (or `"failed"`: then the original remains, labelled).
   Two readers do not trigger two translations.
3. **Stored.** One month per article (`trip_wiki_articles`, migration 0227):
   the Colosseum reads the same for everyone, and nobody pays for the
   translation twice.
4. **Images as with the routes** (§4.7): the article's files, main image first,
   without flags, maps, coats of arms and vector graphics; preview and licence
   from Commons, the photographer on the image.
5. **Said, every time:** Wikipedia, CC BY-SA 4.0, and that a translation is a
   machine's.
6. **The original stays.** A finished translation carries the text as it was
   written with it (`original`); in the article a segmented control switches
   between „Deutsch" and „Original (Italienisch)" (Original (Italian)). In the
   trip settings („Wikipedia-Artikel › Nicht übersetzen", Wikipedia articles ›
   Do not translate) you name the languages you can read; the app sends them
   along as `keepLanguages`, the server shows an article in one of them as
   written (`translation: "skipped"`) and translates it only when a reader
   without that language opens it — from the stored text, without asking
   Wikipedia again.
7. **Updates arrive.** The article carries the page's revision number. If the
   stored entry is older than a day when opened, the server asks Wikipedia only
   for this number; only a changed number fetches the article anew and
   translates it again where necessary — in the background, the reader
   immediately gets the existing text and the new one the next time it is
   opened. A failed check changes nothing; the month remains as the upper
   bound. The reader says „Stand: <Datum>" (As of: <date>).
   No cron run: that would also translate articles that nobody opens any more.
   References, literature, web links and their counterparts in other languages
   are not shown; a shortened article ends with „Weiterlesen auf Wikipedia"
   (Read on in Wikipedia).

### 25.5 What is still outstanding

- **One word per level.** The same thing is still called "Stadt" (city),
  "Etappe" (stage) and "Ort" (place). "Etappe" for the structure, "Ort" only
  for spots — a review of the texts is outstanding.

