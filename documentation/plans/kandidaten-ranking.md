# Candidates: ranked, pictured, explained — and one list instead of two

Status: planned (2026-11-06). Nothing built yet.

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
