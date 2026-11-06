# Candidates: ranked, pictured, explained — and one list instead of two

Status: in progress (2026-11-06). Stages 0 to 4 built; see "As built" under each stage.

## The problem

The candidates of a stay are a filtered, neutral list out of
OpenStreetMap. What orders it is a sum of three signals in
`trip-planner/candidates.ts`: a Wikidata item, a Wikipedia article and a
`tourism=*` tag worth one point, one point and half a point. In the
measurement of §11.0 (`documentation/ios-urlaubsplanung.md`), 18 of 34
places of one city tied at 3.0, and the order in which the region
database answered decided which of them made the cut. The reasons on the
card read "in Wikidata verzeichnet, hat einen Wikipedia-Artikel" ten
times, which is a database state, not a reason (§8.3).

Three more things the list lacks:

- **No picture.** A card with a name and a category does not make anyone
  want to go. Wikipedia's main image and the Commons pictures already
  reach the article view (§25.4) and the route strip (§4.7), but not the
  candidate card.
- **Thin text.** Where the Wikipedia article is a stub, or there is none,
  the card has nothing to say about why the place matters.
- **A place somebody added by hand starts at the bottom.** An idea taken
  from the collection into a trip enters at score 10 and is planned
  before anything the region search offers (§7.2, `ideas-trip.ts`). The
  same place added directly in the trip — from the search, a shared link
  or a web page — enters at score 1 like any candidate (`add-find.ts`)
  and climbs only by a heart wish. Whoever adds a place wants to see it;
  the two paths should say the same.

And one thing the app shows twice: "Kandidaten" and "Wünsche" are two
screens over the same pool of a stay. One manages (place on a day, drop,
hide, map), the other votes (will ich / egal / lieber nicht, heart
wish, names of the voters, fairness, "Neu verteilen"). The wishes map
already shows both at once, the vote as a ring around the pin and the
place below it (§25.3).

## What stays as it is

The concept's limits hold, and this plan does not reopen them:

- **No rating backend** (§10.7): no Google Places, TripAdvisor or Yelp.
  Public opinion is not open data, and what cannot be stored cannot be
  a pool.
- **No web search as a side effect** (§11.5). What leaves the house for
  a candidate list is public data about public places; preferences and
  group composition go along only abstractly, and only to the local
  model.
- **Nothing is invented** (§10.4). A model orders and explains what the
  pool holds; it adds no place and no fact without a source.
- **Voting does not re-plan, and silence is not rejection** (§6.1).
- **A heart wish outranks everything** a model or a statistic can say
  (`HEART_WEIGHT`).

## The sorting rule, stated once

The list of a stay is sorted by, in this order:

1. what the group said — heart wishes, then the vote sum, then the
   fairness nudge (`votes.ts`, unchanged);
2. what the family brought — every entry with `origin = manual`
   (stage 0);
3. what the local model made of it — the curated rank (stage 3), where
   one exists;
4. how well known the place is — the prominence from open data
   (stage 1);
5. the order of the region search, as today.

Every level is visible as a reason on the card, so the order can be
argued with (§3.8). Nothing filters: a spot the group voted below zero
stays in the list and only leaves the solver's reach, as today.

## Stage 0 — a place somebody added is a top pick

Backend only, no migration.

- `add-find.ts` writes `score: MANUAL_SCORE` (10, the value
  `ideas-trip.ts` uses today as `COLLECTED_SCORE`; one constant, in one
  place, `candidates.ts`) for every entry with `origin = manual`, with
  the reason "von euch hinzugefügt". `ideas-trip.ts` no longer raises
  the score afterwards; it comes out of `addFind` at that value.
- A manual entry that the region search also finds keeps the manual
  score when the two merge (`findDuplicate` in `finds.ts` already merges
  the rows; the score takes the greater).
- Existing rows are not backfilled: a one-off `UPDATE … WHERE origin =
  'manual' AND score < 10` is written as a migration so trips already
  planned see the change too.

Tests: `add-find.test.ts` (a find enters at 10 with its reason),
`ideas-trip.test.ts` (unchanged outcome, no second update).

As built (2026-11-06): `MANUAL_SCORE` and `MANUAL_REASON` in
`candidates.ts`; `addFind` enters at it, `mergeIntoPoolEntry`
(`find-store.ts`) raises a merged search candidate to it and puts the
reason first; migration `0291_trip_pool_manual_top_pick` raises the
manual rows already in a pool and replaces the old "selbst hinzugefügt"
reason.

## Stage 1 — prominence from open data

A graded "Bekanntheit" replaces the three half-points. Every signal is
open, keyless, cacheable and offline-able:

| Signal | Source | Reason on the card |
| --- | --- | --- |
| Page views, monthly average over the last 12 months | Wikimedia REST pageviews API, per article | "12.000 Aufrufe im Monat" |
| Number of language editions (sitelinks) | Wikidata entity | "Artikel in 34 Sprachen" |
| Named in the city's Wikivoyage "Sehenswürdigkeiten" | Wikivoyage listings (CC BY-SA), matched by Wikidata id, else by name within 150 m | "in Wikivoyage genannt" |
| Number of Commons pictures | Commons category (P373) file count | "über 200 Bilder auf Commons" |
| Mapped as a sight | OSM `tourism=*`, as today | "als Sehenswürdigkeit erfasst" |

- Computed once per place, not per trip: a table
  `trip_spot_prominence` keyed by Wikidata id (or Wikipedia article
  where there is no item), with the raw numbers, the Wikivoyage
  description and a fetched-at date. Valid for 90 days; refreshed in
  the background when a pool is built, never on a request path.
- The pool row carries the result as `prominence` (jsonb: tier 0–3 and
  the reasons) so the offline bundle (§3.9) has it. `candidates.ts`
  turns the raw numbers into a tier with fixed thresholds that live in
  one place and are explained in a comment; the thresholds are relative
  within the pool (quartiles), because 2,000 views a month is a lot in
  a village and nothing in a capital.
- A queue job (`trip-planner/prominence.ts`, on the existing job
  mechanics) runs after every pool build and fills what is missing;
  the pool is usable before it finishes and re-sorts when it does.
- Wikivoyage: one request per stay for the city page's listings (the
  page is found by the stay's anchor through Wikidata's "Wikivoyage
  banner"/sitelink of the nearest settlement). The listing's one-line
  description is kept as the first source of text for stage 4.

Tests: pure scoring from raw numbers (`prominence.test.ts`), the
Wikivoyage listing parser on a fixture page with invented places, the
pageviews parser.

As built (2026-11-06), with three deliberate changes to the above:

- **Asked when the pool is built, not afterwards.** The days are
  planned out of the pool in the same request, so a job that re-sorted
  the pool later would re-sort a list whose best entries were already
  chosen by the old tag sum. `prominenceAround` (`spot-fame.ts`) runs
  in the pool build, answers from the cache first and gives Wikimedia
  `LOOKUP_BUDGET_MS` (8 s) for the rest; what does not answer in time
  is ranked the old way once, stored as waiting, and filled by the
  local cron job `trip-planner-spot-fame` (every 30 minutes) for the
  next build.
- **Keyed by the OSM reference**, in `trip_spot_fame`
  (migration `0292_trip_spot_fame`), with the Wikidata id and article
  it was looked up under beside it: every pool entry, stop and idea
  has an OSM reference, not all have an item.
- **No `prominence` column on the pool row.** The result travels as
  the score and the reasons, which the pool row and the offline bundle
  already carry; the raw numbers stay in the cache.

The Wikivoyage article is the nearest one to the stay's anchor by
Wikivoyage's own geosearch (German first, then English), not found
through the settlement's Wikidata item. Tiers are quartiles of
`fameValue` within the pool and add `TIER_POINTS` (0.5–2.5) to the
base score of 1 in place of the Wikidata and Wikipedia points; the
`tourism=*` half point stays. The test suite runs with a silent client
(`TRIP_SPOT_FAME=0` in `vitest.config.ts`).

## Stage 2 — a picture on the card

- The pool row (and the stop) gets `image` (jsonb: Commons file title,
  thumb URL at 320 px, licence, author, page URL), filled by the same
  job as stage 1: Wikipedia `pageimage` first, Wikidata P18 second, and
  for a place with neither a Commons `geosearch` within 60 m of the
  coordinate (`commons-client.ts` already does this for routes),
  keeping only photographs as `isPhotograph` in `wikipedia-client.ts`
  decides.
- The card shows the thumbnail; the detail sheet and the article view
  show the gallery: the article's images as today, then the Commons
  category of the Wikidata item (P373), which for most sights has
  dozens where Wikipedia has one or two. Licence and author on every
  picture, as §25.4 does it.
- Offline bundle: the 320 px thumbnail of every pool entry and stop is
  part of the bundle, so a card does not go blank at sea. The gallery
  is not.
- iOS: `TripCandidate` and `TripStop` get `image`; the row in
  `TripPoolView`, the pin sheet and `TripSpotDetailView` draw it. A
  missing image shows the category symbol, not a placeholder frame.

As built (2026-11-06): the picture is looked up with the prominence
(`picturesFor` in `spot-fame.ts`) and stored in `trip_spot_fame.image`
(migration `0293_trip_spot_fame_image`), read onto pool entries and
stops in `loadPlan` like the notes. Thumbnails are Commons' 640 px
(`THUMB_WIDTH`), not 320, so the large picture on the detail screen
is sharp. The gallery is `GET /trip-planner/spots/gallery`
(`spot-gallery.ts`) over the place's Commons category, shown on the
detail screen (`TripSpotPictures`); the article view keeps its own
pictures. A find is looked up in the background after it is saved.
Offline, `TripOfflineThumbnails` loads every card's thumbnail into
the URL cache when the plan is downloaded.

## Stage 3 — curation by the local model

The measurement of §11.0 found that a model, the local one included,
orders a pool better than any tag sum and never took a savings bank.
This stage builds what was measured, and nothing beyond it.

- After stage 1's job, a second job sends the local model one request
  per stay: every pool entry with name, category, prominence reasons,
  the Wikipedia lead paragraph (`wikipedia-client.ts` fetches extracts
  already) or the Wikivoyage line, plus the trip's interests and the
  group abstractly ("zwei Erwachsene, ein Kind (7)"; names, lodging
  address and documents never go along, §11.5).
- It answers with an ordered list of `osmRef` and one sentence per
  entry. The answer passes a gate like `normalizeConstraints`: unknown
  refs are dropped, duplicates collapsed, a sentence that names a fact
  not in the input (an opening time, a price) is replaced by the
  prominence reason. Nothing it says changes a place's data.
- Stored on the pool row as `curated_rank` and `curated_reason`; the
  sorting rule uses them at level 3. The card shows the sentence as its
  reason where it has one.
- Re-run when the pool changes by more than a handful of entries or the
  interests change; never on a request path. On the CPU twin this takes
  minutes per stay, which is why it is a job with a visible "wird noch
  sortiert" state and not a wait.
- Measured, not assumed: the benchmark of §11.0 (`trip-planner/llm-bench/`) gets a
  case per request from that measurement, with invented places, so a
  model change shows its effect before it ships.

As built (2026-11-06), with two deliberate changes to the above:

- **The order is kept per stay, not on the pool row.** The pool is
  rewritten on every re-plan, so `trip_leg_curation` (migration 0294)
  holds the gated answer per leg, with a signature of the pool and the
  interests it was asked for. `toCandidates` reads it on a re-plan
  (option `curated`), so the days are built out of the model's order.
- **A rank is a score band, not a separate key.** Everything in the
  planner orders by `score`, the solver included, so the rank becomes
  `curatedScore(rank, of)`: from `CURATED_TOP` (9) for the first to
  `CURATED_FLOOR` (5) for the last, above anything open data can reach
  and below `MANUAL_SCORE`. A pool row keeps the scoring's own score
  (`search_score`) and the band's (`curated_score`); the votes are
  `score − base`, so a curation that lands between two re-plans moves
  the row without losing what the votes added (`applyCuration`). A
  manual entry keeps its score and only gets the sentence.

Pieces: prompt, gate and "ask again?" in `trip-planner/curation.ts`
(`gateCuration` drops unknown refs, collapses duplicates and replaces a
sentence with a number or an opening-hours/price word the input did not
contain by the first open-data reason); the job in `curation-job.ts`
(`markCurationDue` on every pool write, the cron
`trip-planner-curation` every 5 minutes asks up to three stays one at a
time, a model that is away puts the stay back uncounted, a failed stay
is tried again after an hour, at most three times). Only reasons from
open data go to the model, never the vote reasons, which carry names.
Wikipedia intros come through `FameClient.leads`. The leg carries
`curation` (`pending`/`running`/`done`/`failed`), and the pool list
shows "wird noch sortiert" while it is pending or running. The
benchmark has a `planner` track that sends the shipped prompt through
the shipped gate (`run-curation.ts --track=planner`).

## Stage 4 — text where Wikipedia is thin

A `description` per place, with its source said on screen:

1. the Wikivoyage listing line (stage 1), with attribution;
2. else the lead paragraph of the Wikipedia article, as today;
3. else the place's own website (OSM `website` tag): fetched by the
   server with the guards of §9.3 (https only, no private ranges, size
   and time limits, readability extraction), summarised by the local
   model in two sentences with a verbatim quote that is checked against
   the page text — the mechanism `extract-places.ts` already uses for a
   shared article. Stored with the URL and the fetch date; a failed
   check stores nothing.

Blogs and travel reports keep coming in the way §9.3 built: shared from
the phone, where the page is already open. A search for them is a
separate decision (see below), not a stage of this plan.

As built (2026-11-06): kept per place in `trip_spot_fame` (migration
0295: the map's `website`, `description` as text, source and URL, and
`described_at`). A Wikivoyage line is read straight from the lookup and
never copied. The rest is looked for in the background
(`describeSpots` in `trip-planner/spot-description.ts`, cron
`trip-planner-spot-descriptions` every 30 minutes) for places in a pool
or on a day: the Wikipedia lead through `FameClient.leads` when it has
at least `MIN_LEAD_CHARS`, else the website through `fetchSharedPage`,
cut to `MAX_SITE_CHARS` and summarised by the local model, kept only
when its quote is on the page (`quoteAppearsIn`) and the summary names
no number or opening-hours or price word the page did not
(`namesUnknownFact` from stage 3). At most five websites per tick; a
failed check stores nothing and waits 90 days like a found one. The
curation (stage 3) reads the stored description too. Pool entries and
stops carry `description` from `loadPlan`; iOS shows it with its
source as a link in the detail view and the pin sheet
(`TripSpotDescriptionSection`).

## Stage 5 — one list

"Wünsche" merges into "Kandidaten":

- One screen per stay, list and map as today (`TripPoolPresentation`).
  Every row: thumbnail, name, the first reason line, and the vote ring
  of `TripSpotMapPin.ringTint` as a tappable control; the names of the
  voters below, as the ballot shows them. Placing, dropping and hiding
  stay in the row's menu and swipe actions.
- The sections about the stay as a whole — who has not said anything
  yet, the fairness account, "Neu verteilen" — move to the head of this
  list and step back while searching, as the ballot does today.
- The search covers what the ballot's covers, voters' names included;
  filtering by vote stays out (§6.1).
- `TripBallotView` goes; the wishes map becomes the map presentation of
  this screen. The stage sheet (`TripLegSheet`) offers one entry,
  "Kandidaten (n)". The handbook and §6.1/§25.3 of the concept say so.

## Open, deliberately

- **A web search per spot** ("Im Web nachsehen", user-triggered, via a
  self-hosted SearXNG, for display only and never for the ranking) is
  the form §10.7 names as the most compatible one. It is a decision of
  its own because every query still leaves the house, and it is not in
  this plan.
- **The idea collection** (§20) gets the picture and the description
  through the same place-keyed table, since an idea is the same place
  before it belongs to a trip; its own ranking stays by distance and
  recency.

## Decisions taken (2026-11-06)

- A manually added place is a top pick: it enters at the collected
  score, whichever way it came in. The heart wish stays above it.
- Candidates and wishes are one list; the split was one of screens,
  never of data.
- Ranking signals come from open data and the local model, in that
  order; no rating service and no automatic web search.
