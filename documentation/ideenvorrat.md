# Idea Pool — the Collection Without a Trip

As of: 2026-09-11 · Status: backend complete, iOS UI built
(two ways in and the events excepted — §6)

Detailed rationale and design: `documentation/ios-urlaubsplanung.md` §20.
This document describes **what is built** — endpoints, data model,
rules — so that it can be used without reading 3,600 lines of concept.

## 1. What it is

Everything else in the vacation planner needs a trip: create it, name a place,
get days. That is the half you *plan*, and the rarer one. The more
frequent one is the one you *collect* — the beer garden someone
mentioned, the exhibition in the neighboring town, the trail that came up
twice. Things without a date, without a city, without a frame.

The building block for it has existed for a while: the stage pool (§5) is a rated
list of possibilities that happens to hang off a stage. The idea pool
is the same list without it.

Two properties set it apart from a bookmark list:

- **It is shared** — one list the family writes into, not a copy per
  person. Every entry records who put it in, because "Dad wanted to go
  there" is half the information.
- **It is location-based, not list-shaped.** A collection that is only a list
  gets read until it is too long, and never again afterwards. The value
  arises when it **speaks up on its own** — and proposes an afternoon
  from that.

## 2. Status at a glance

| Part | Status |
| --- | --- |
| Collect, list, remove, share | built (`trip-planner/ideas.ts`) |
| Proximity notice with quiet period, "not now" | built (`trip-planner/outing.ts`) |
| Outing proposal from several ideas | built (`trip-planner/outing.ts`) |
| The three paths between pool and trip | built (`trip-planner/ideas-trip.ts`) |
| Events with validity window | columns exist, source missing — §20.4, not built for now |
| Screen: list, save, remove, share | built (`TripIdeasView`) |
| Ways in: own location, shared map link | built (`TripMapLink`) |
| "In der Nähe" (nearby) screen including "nicht jetzt" (not now) | built (`TripIdeasNearbyView`) |
| Outing proposal including adoption as a trip | built (`TripIdeasOutingView`) |
| Offer within the trip + "für später merken" (save for later) | built (`TripPlanIdeasView`, pool swipe gesture) |
| The notice **on its own** (location loop) | built (`TripIdeaNoticeMonitor`), **off by default** |
| Search across all groups, including group name | built (`TripIdeaSearch`, `TripIdeasView`) |
| Ways in: article, search | **not built** — need a trip (§9.3), see §6 |

The entry point is in place: in vacation planning, "Ideen" (ideas) leads to a list per
collection — with note, with "who saved it", with a hint about entries that
the map does not know. What gets in is **the place where you are standing right now** and
a **shared map link** (Apple Maps, also as a short link — it is
resolved); articles and search from §9.2 are missing and are deliberately not built
here (§6).

All three paths between pool and trip are in place: the accepted
**outing proposal** as a one-day trip, the **offer within the trip**
("Aus dem Vorrat" (from the pool) in the menu of the day card) and **"für später merken"** as a
swipe gesture in the stage pool. "In der Nähe" exists as a **question** (a
screen you open, which therefore consumes no quiet period) and as a
**notice on its own** — the latter is a switch in the menu and is **off**
by default.

Search works **across all groups**: the field sits permanently above the
list and filters name (the user's own as well as the one on the sign), note, "from whom", type —
and the **name of the group**. "Lissabon" thus finds everything saved
there, even if no single entry carries the word. The groups
are otherwise only named once you scroll to them (the geocoder is
rate-limited); as soon as someone searches, the missing names are fetched,
one after the other. Groups in which nothing remains disappear;
a line at the top says "3 von 40 Ideen" (3 of 40 ideas).

## 3. Data model

Migration `0179_idea_pool.sql`, two tables.

**`idea_pool`** deliberately mirrors `trip_plan_pool` column by column, minus
`leg_id` and plus three things a standing collection needs:

- `owner_id`, `created_by` — who the collection belongs to, who put this entry
  in.
- `valid_from`, `valid_to` — for something that ends (an exhibition until
  Sunday). Both `null` for the normal case: a place that simply exists.
- `last_suggested_at`, `dismissed_count` — the bookkeeping that makes "reported
  once" durable.

A unique index on `(owner_id, osm_ref)`: the same beer garden, mentioned twice,
is **one** idea.

**`idea_pool_shares`** has the same shape as the participant list of a trip
(§6.2) — people, no permission grid. A household is a list of
people.

## 4. Endpoints

All under `/trip-planner`, all with `auth: true` and the permission
`photos.view`. `ownerId` is optional everywhere. **Without** `ownerId`, since
the household view: reading spans **all collections one has been
let into** (one's own first); writing goes to one's own.
With `ownerId`, exactly that one collection is meant.

**Two collections, one view.** Each person has their own collection
(`idea_pool.owner_id`); letting someone in (`idea_pool_shares`) gives the other
person write access to *my* collection. If two household members start separately
and later let each other in, **nothing is re-parented and nothing is
merged**: both keep their collection, both see from then on **one
list** made of both — with "von X" (by X) on every row and `ownerId` on every entry,
so that edit and delete know where to go. The same place in two collections
(same `osm_ref`, or two `manual:` entries within 80 m) is **one** row in
the list; the user's own copy wins, otherwise the older one. Proximity,
outing, "already in the ideas" when discovering, and "take over from the ideas"
in a trip read the same union.

### 4.1 The collection itself (`ideas.ts`)

| Call | What it does |
| --- | --- |
| `POST /ideas` | add an idea |
| `GET /ideas` | entries of all accessible collections as one list (or one via `ownerId`), plus the collections themselves |
| `GET /ideas/members` | who may write into my collection |
| `POST /ideas/remove` | delete an entry (`ownerId` says which collection it is from) |
| `POST /ideas/share` | let someone in — via `userId` from the household (the app shows the list, like album sharing) or via `email` |
| `POST /ideas/unshare` | take someone out again |
| `GET /shareable-users?forIdeas=true` | the household minus those who already write along (`household.ts`; with `planId` instead of `forIdeas` the same for a trip) |

The way in is **the same as for a find** (§9.2), not a second one:
coordinate, optional name, note, origin. Within **80 m**, the
matching OSM entry is searched; if none is found, the one permitted question is
asked (`dwellMinutes` — how long?), instead of inventing a duration. The
entry is then marked as `unmatched`, and the response states in plain text under
`unknown` what is not known (§15.3).

A second mention of the same place is **merged** and only adds
what it brings with it — what someone wrote the first time is never overwritten
by it (`merged: true` in the response).

Anyone who is in a collection may also remove something from it: §6.2 gives the
organizer three rights, and this is none of them.

A collection that nobody has been let into does **not** exist for outsiders
— `not_found`, not `permission_denied`. What does not belong to you
is also not something you should know exists.

### 4.2 The pool speaks up (`outing.ts`)

| Call | What it does |
| --- | --- |
| `POST /ideas/nearby` | "Is anything of ours nearby?" |
| `POST /ideas/dismiss` | "Not now." |
| `POST /ideas/outing` | "Shall I turn that into an afternoon?" |

**Proximity.** Sorted by distance, with `addedBy` — "the beer garden Anna
saved" is the form §20 demands. Default radius 5 km, maximum
100 km.

> **Being returned counts as having been reported.** The timestamp is set on
> delivery, not when an app reports back that it displayed it —
> an app that forgets that would make the rule silently ineffective. After that there is
> **one week of quiet** (`QUIET_DAYS = 7`). Anyone who only wants to see the list
> by distance sends `markSuggested: false`; a screen is not the same as
> a notice.

What lies within the radius but was deliberately not offered is **counted**
as `quiet` **rather than listed** — the number is honest, the list would be noise.

**Swiped away.** `dismiss` counts up and leaves the entry in place. After three
"nicht jetzt" (not now) (`DISMISSALS_UNTIL_QUIET = 3`) it goes silent — but it remains
in the pool, because nobody said "get rid of it" (§7.1 remembers a no
instead of deleting it).

**The outing.** The point at which a bookmark list becomes a planner: if
several entries lie close enough together, the question is not "do you want to go to
this one?" but "shall I turn this into an afternoon?". The answer is
a call to `solveDay` with the location as anchor, **one** block spanning the
time budget and the pool as candidates (default radius 25 km — a
day-trip radius —, default budget 240 minutes, default means of transport
car). An outing is one block, not a division
into four — that belongs to the vacation, not to Saturday afternoon.

Four decisions that were made along the way:

- **Collected items first.** Ideas enter the selection with a starting bonus (`score: 10`)
  and thus come before what the region search fills in. Both are
  marked in the result as `fromIdeas`, so that "ours" and "found"
  remain distinguishable.
- **Filling up is allowed, but can be switched off** (`fillFromRegion: false`).
- **The leg limit is a walking budget.** The planner's 40 minutes are
  the right rejection within a city and the wrong one for an outing:
  half an hour by car is the way to the lake, not a detour. For car and public transit
  90 minutes per stage therefore apply; on foot and by bike it stays at 40.
- **Expired dates are not even considered.** An exhibition
  that ended on Sunday is no longer an idea.

The response also says when nothing works (`offered: false`, `reason:
no-ideas | nothing-fits`) and how much was dropped (`leftOut`). An outing that
fits is shorter than the one someone wanted.

### 4.3 Between pool and trip (`ideas-trip.ts`)

Not a second mechanism, but one more source — three directions, all
over existing paths:

| Call | Direction |
| --- | --- |
| `POST /ideas/outing/accept` | proposal → **new one-day trip** |
| `GET /plans/:planId/ideas` | "You have collected four ideas for Lisbon" |
| `POST /plans/:planId/ideas/take` | idea → **stage pool** of this trip |
| `POST /plans/:planId/pool/to-ideas` | leftovers → **back** into the collection |

When a trip is created, the collection is **not** automatically used as a
candidate source — an idea from last year is not automatically the
wish of this trip (§20.3). So that it does not stay invisible nonetheless, the app's
day screen says the sentence from the concept once: "Ihr habt vier
Ideen für Lissabon gesammelt." (you have collected four ideas for Lisbon). The line leads to "Aus den Ideen übernehmen" (take over from the ideas),
where the decision is made; "Später" (later) silences exactly this count, one more
collected idea asks again. The menu item carries the number of ideas not yet
taken over.

**Accepted outing.** A perfectly normal one-day trip with one stage
and one block. The day is deliberately only planned out **after** the
accepted ideas are in the pool — otherwise it would plan itself from the
region search and the ideas would come afterwards. The response states separately what
ended up on the day (`planned`) and what stayed in the pool (`inPool`).

**When creating a trip**, what lies in one of its stages is offered —
sorted by stage and distance, with "who saved it". **Nothing is taken over
automatically:** an idea from last year is not automatically the
wish of this trip. What is already in the trip is marked
(`alreadyInTrip`) rather than hidden — that it is there is the answer to
the same question.

**Back into the pool** pushes what nobody saw on the trip.
"Next time" is the most honest place to file a spot that did not make it into
the plan. Things already collected are not an error here, but are
counted and reported (`alreadyThere`).

**In all three directions the idea stays in place** — it is not
used up, only used.

## 5. A detail that causes trouble if overlooked

A place the map does not know gets a **new**
`manual:` reference as a find. The idea's own reference then no longer serves for
recognition. "Already in the trip" is therefore decided via the same **80 meters**
with which `finds.ts` calls two entries the same place — a
different number here would let the same beer garden be "already included" and
"duplicate" at the same time.

## 6. What is missing

- **Two ways in**: article and search. Both need the region search
  or the language model and therefore hang off a trip (§9.3) — in the pool
  without a trip they would be a promise of a reading that nobody here can
  deliver. Everything else from §20 is in place.
- **Events** (§20.4) — not built for now, because there is no source
  that holds up to the claim. The columns (`valid_from`, `valid_to`) and
  the filtering of expired entries are in place; an event is then an
  ordinary entry with a validity window, and proximity, outing and takeover
  apply unchanged.

## 7. Where the code lives

| File | Content |
| --- | --- |
| `trip-planner/ideas.ts` | Collection: create, read, remove, share |
| `trip-planner/outing.ts` | Proximity, "not now", outing proposal |
| `trip-planner/ideas-trip.ts` | the three paths between pool and trip |
| `db/migrations/postgres/0179_idea_pool.sql` | `idea_pool`, `idea_pool_shares` |
| `trip-planner/ideas.test.ts`, `outing.test.ts`, `ideas-trip.test.ts` | Tests |
| `ios/Sources/FKPhotos/Features/TripPlanner/TripIdea*.swift` | List, models, view model, search (`TripIdeaSearch`) |
