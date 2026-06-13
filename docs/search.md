# Photo Search Architecture

This document describes how photo search is implemented end-to-end in fk-encore:
from a free-form German query typed in the UI, through the Encore.ts backend,
down to the Python embedding service, and back.

The design goal is that a single entry point — the natural-language endpoint
`POST /photos/search/natural` — covers all major search intents (semantic,
date-filtered, location-filtered, or combinations), while more specialized
endpoints remain available for programmatic use cases.

## High-level flow

```
                 ┌──────────────────────┐
                 │   Vue frontend       │
                 │   NaturalSearchBar   │
                 │   useNaturalSearch   │
                 └──────────┬───────────┘
                            │ POST /photos/search/natural
                            ▼
                 ┌──────────────────────┐
                 │   Encore.ts backend  │
                 │   photo.ts           │
                 │   photo.service.ts   │◄──── Postgres (photos, photo_curation,
                 └──────┬──────────┬────┘      photo_locations, …)
                        │          │
          /parse/query  │          │  /search/text
                        ▼          ▼
               ┌─────────────────────────┐
               │  Embedding service      │
               │  (FastAPI, Python)      │
               │  • spaCy + dateparser   │
               │  • OpenCLIP XLM-R ViT-H │
               │  • pgvector similarity  │◄──── Postgres (photo_embeddings)
               └─────────────────────────┘
```

Three services are involved:

1. **Vue frontend** — renders the search bar, keeps search state, displays the
   parsed-query chips that tell the user how the query was understood, and
   feeds result IDs into the shared photo grouping pipeline.
2. **Encore.ts backend** (`photo` service) — authenticates the request,
   orchestrates parser + vector search calls, and joins the results against
   the relational photo metadata.
3. **Embedding service** (Python / FastAPI) — owns the natural-language
   query parser (spaCy + dateparser) and the CLIP text/image encoders plus
   the pgvector similarity lookup.

## Search endpoints in the backend (Encore.ts)

All endpoints live in [`photo/photo.ts`](../photo/photo.ts) and delegate to
`photo/photo.service.ts`. They all require authentication and the
`photos.view` permission.

| Endpoint | Method | Purpose |
|---|---|---|
| `/photos/search/natural` | `POST` | **Primary entry point.** Parses a free-form query, then applies structural + semantic filters. Returns results plus the parsed query for UI feedback. |
| `/photos/search` | `POST` | Pure CLIP semantic search over the user's library. |
| `/photos/search/date` | `GET`  | Date range / year / year+month filter (structured parameters). |
| `/photos/search/location` | `GET`  | City/country text search or GPS radius search. |

In practice the frontend talks to `/photos/search/natural` only. The other
endpoints are kept for API consumers (mobile clients, tests, future UI pieces
such as a structured-filter sidebar).

### `searchPhotosNaturalLogic` — three execution modes

The logic function picks one of three paths based on what the parser
extracted (`photo/photo.service.ts`):

1. **Structural only** — the query contains date/location but no semantic
   part left after stripping. Executed as a plain Drizzle `SELECT` on
   `photos` with a `WHERE` over `taken_at` / `location_*`, ordered by date.
   No CLIP call is needed.
2. **Semantic only** — the query reduces to free-form text with no dates or
   locations. Runs CLIP `POST /search/text` *and* a description token search
   in parallel, then merges both result sets (description matches get
   `score = 1.0`, CLIP hits keep their cosine score; results sorted
   desc-by-score).
3. **Combined** — both structural and semantic. The backend first fetches
   candidate photo IDs that satisfy the structural filter (enlarging `k` to
   compensate for intersection loss), runs CLIP `/search/text` and the
   description search in parallel, intersects CLIP with the structural set,
   then unions in description matches (which already had the structural
   filter applied at query time).

### Description token search

In addition to CLIP image embeddings, the search inspects the
`photos.description` column. The parser's `semanticQuery` is split on
whitespace; tokens of length ≥ 2 are AND-joined as `ILIKE %token%`
predicates. So a query like `Mariens Geburtstag` matches a photo whose
description is `"Mariens 30. Geburtstag im Garten"` even though CLIP would
not reliably find it from the image alone.

Description matches always count as a perfect hit (`score = 1.0`) and
therefore appear at the top of the result list, ahead of CLIP-only matches.

The hidden-photo filter (`photo_curation.status != 'hidden'`) is always
applied so deleted / archived photos stay out of results.

## The parser: spaCy + dateparser

### Remote parser (preferred)

`photo.service.ts::parseNaturalQueryRemote` calls the embedding service's
`POST /parse/query` with a 5 s timeout. The parser uses:

- **spaCy** (`de_core_news_md`) for Named Entity Recognition. `LOC` and `GPE`
  entities become the `location` filter. Case-insensitive and tolerant of
  inflection ("in München" / "aus München" / "bei München" all collapse to
  `"München"`).
- **Explicit year-range regexes** for patterns that dateparser misinterprets:
  - `von YYYY bis YYYY`
  - `zwischen YYYY und YYYY`
  - `YYYY–YYYY` (with en-dash, em-dash or hyphen)
  - `YYYY bis YYYY`
- **Seasons** (`Frühling`, `Sommer`, `Herbst`, `Winter`) with optional year —
  expanded to a three-month window (winter crosses the year boundary).
- **dateparser** (German) for everything else: absolute dates
  (`"März 2019"`, `"15. Juni 2020"`, `"2019"`, `"03/2019"`), relative dates
  (`"letzten Sommer"`, `"vor 2 Jahren"`), and ranges that emerge as two hits.
- **Stop-word cleanup** on the remaining text so the CLIP query isn't
  polluted with connector words (`von`, `bis`, `und`, `in`, `im`, `aus`, …).

Result shape from `/parse/query`:

```json
{
  "semantic_query": "Kirchen",
  "location": "München",
  "from_date": "2004-01-01T00:00:00",
  "to_date":   "2017-12-31T23:59:59"
}
```

### Fallback parser

If the embedding service is unreachable or returns an error,
`parseNaturalQueryInternal` in `photo.service.ts` provides a pure regex
fallback. It supports explicit year ranges, month+year, bare years,
"in \<Location\>" phrases and stop-word cleanup, but does **not** handle
relative dates or case-insensitive locations. Search degrades gracefully
rather than failing.

### Example queries

| Query | semantic | location | from_date | to_date |
|---|---|---|---|---|
| `Kirchen in München von 2004 bis 2017` | `Kirchen` | `München` | 2004-01-01 | 2017-12-31 |
| `Sonnenuntergang am Meer` | `Sonnenuntergang Meer` | – | – | – |
| `Berlin März 2019` | – | `Berlin` | 2019-03-01 | 2019-03-31 |
| `letzten Sommer` | – | – | Jun 1 (prev year) | Aug 31 (prev year) |
| `Winter 2020` | – | – | 2020-12-01 | 2021-02-28 |
| `Familie zwischen 2019 und 2021` | `Familie` | – | 2019-01-01 | 2021-12-31 |

## Embedding service endpoints

FastAPI app under `embedding_service/app/api/endpoints.py`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | Readiness probe. |
| `/embed` | `POST` | Compute CLIP + DINOv2 embeddings for an uploaded image. |
| `/upload` | `POST` | Store embeddings for a photo in pgvector. |
| `/search` | `POST` | "More like this" — nearest neighbours to a given photo's vector. |
| `/search/text` | `POST` | Text-to-image CLIP similarity search. |
| `/parse/query` | `POST` | German natural-language query parser (spaCy + dateparser). |
| `/get` | `POST` | Retrieve stored embeddings for a set of photo IDs. |
| `/quality` | `POST` | Per-dimension quality scores via CLIP text-image similarity. |

### CLIP model

- Model: `xlm-roberta-large-ViT-H-14` (OpenCLIP).
- Text encoder is XLM-RoBERTa-Large → native multilingual support, so German
  queries do not need translation.
- Embedding dimension: 1024.
- Vectors are stored in `photo_embeddings.embedding_clip` (pgvector) with a
  cosine-distance index.

### Text search path (`/search/text`)

1. The query string is embedded with the CLIP text encoder.
2. `repository.search_by_clip` runs `ORDER BY embedding_clip <-> $1 LIMIT k`
   against pgvector.
3. Results are filtered by a cosine-similarity threshold (default `0.18` from
   the backend). Returned as `[{photo_id, score}]`.

#### Request validation

The `TextSearchRequest` schema in
[`embedding_service/app/models/schemas.py`](../embedding_service/app/models/schemas.py)
enforces:

| Field | Bounds |
|---|---|
| `query`     | 1 – 500 characters |
| `k`         | 1 – 1000           |
| `threshold` | 0.0 – 1.0          |

Requests outside these bounds are rejected with `422 Unprocessable Entity`.
The backend therefore caps every outgoing `/search/text` call via the
`EMBEDDING_TEXT_SEARCH_MAX_K` / `EMBEDDING_TEXT_SEARCH_MAX_QUERY_LEN`
constants in `photo/photo.service.ts`. This matters most in the combined
(Case C) path, where `clipK = min(candidateSet.size, limit * 5, 1000)` —
without the final cap, large structural candidate sets (e.g. a full-year
date filter over a big library) would exceed `k = 1000` and produce a 422.

### Cold start and timeouts

The spaCy model and the CLIP encoders are lazy-loaded on first use. The
backend calls `/parse/query` with a 5 s timeout specifically because the
first call after service start can take a few seconds for the model load;
subsequent calls return in ~5–20 ms. Any failure (timeout, 5xx, network
error) triggers the regex fallback silently.

## Frontend architecture

### API layer

`frontend/src/api/photos.ts` exposes:

```ts
export interface ParsedQuery {
  semanticQuery: string
  location?: string
  fromDate?: string  // ISO-8601
  toDate?:   string
}

export interface NaturalSearchResult extends PhotoSearchResult {
  location_city?: string
  location_country?: string
}

export async function searchPhotosNatural(
  query: string,
  limit = 500,
  threshold = 0.18,
): Promise<{ results: NaturalSearchResult[]; parsed: ParsedQuery }>
```

`results` only carries the fields needed for post-filtering and ranking; the
full `Photo` objects are already loaded in the views, so the frontend filters
its local photo list down to the returned `photoId` set.

### Composable: `useNaturalSearch`

`frontend/src/composables/useNaturalSearch.ts` holds shared state so the same
search logic can be reused across views:

- `searchQuery` — two-way bound to the `<input>`
- `searchResultIds` — `number[] | null` where `null` means "no search
  executed yet"
- `parsed`, `loading`, `error`
- `executeSearch()` / `clearSearch()`
- Computed chip helpers: `locationChip`, `dateChip`, `semanticChip`,
  `hasParsedChips`. `dateChip` renders full-year ranges compactly
  (`"2004"` or `"2004–2017"`) and falls back to a German long date format for
  non-year-aligned ranges.

The returned `searchResultIds` ref is plugged into `usePhotoGrouping` via its
`searchResultIds` option; the grouping composable filters the flat photo list
down to the hit set without re-rendering unrelated photos.

### Component: `NaturalSearchBar`

`frontend/src/components/NaturalSearchBar.vue` is a presentational component
owning the layout:

- Search `<input>` with a leading `pi pi-search` icon and a trailing clear
  button.
- A PrimeVue `Button` that triggers `executeSearch`.
- A "N Treffer" count.
- Chips below the bar that show *"Verstanden als: [semantic] [location]
  [date]"* whenever the parser extracted anything structured. The chips are
  the main UX win — they make the parser transparent.
- A default slot for extras (e.g. a sort toggle in `PhotosView`).

Props mirror the composable output; the component emits `update:modelValue`,
`search`, and `clear`.

### Consumers

- `PhotosView.vue` — global photo grid. Search results narrow the visible
  timeline.
- `AlbumDetailView.vue` — album detail. The search is still global (the same
  `/photos/search/natural` call), but `searchResultCountInAlbum` filters the
  result-IDs by the album's own photo set so the displayed count matches the
  grid. Photos from outside the album are hidden by `usePhotoGrouping`.

## Error handling and degradation

| Failure | Observed behaviour |
|---|---|
| `/parse/query` timeout / 5xx / network | Backend falls back to regex parser. No user-facing error. |
| `/search/text` error | Backend throws → frontend shows `"Suche fehlgeschlagen."` |
| `k > 1000` or `query > 500` chars sent to `/search/text` | Service returns `422 Unprocessable Entity`. Prevented by the caps in `photo.service.ts`; if you see a 422 in the embedding logs, check whether a new caller bypassed those constants. |
| Empty parser result | Query treated as pure semantic; returns CLIP-only results. |
| No embeddings in DB for the user | `/search/text` returns empty list; UI shows "0 Treffer". |

## Related files

- [`photo/photo.ts`](../photo/photo.ts) — Encore API definitions.
- [`photo/photo.service.ts`](../photo/photo.service.ts) — search orchestration,
  regex fallback parser.
- [`embedding_service/app/services/query_parser.py`](../embedding_service/app/services/query_parser.py)
  — spaCy + dateparser parser.
- [`embedding_service/app/api/endpoints.py`](../embedding_service/app/api/endpoints.py)
  — `/parse/query`, `/search/text`, `/embed`, etc.
- [`frontend/src/api/photos.ts`](../frontend/src/api/photos.ts) — typed client.
- [`frontend/src/composables/useNaturalSearch.ts`](../frontend/src/composables/useNaturalSearch.ts)
- [`frontend/src/components/NaturalSearchBar.vue`](../frontend/src/components/NaturalSearchBar.vue)
- [`frontend/src/views/PhotosView.vue`](../frontend/src/views/PhotosView.vue),
  [`frontend/src/views/AlbumDetailView.vue`](../frontend/src/views/AlbumDetailView.vue)
