# Rückblicke (Recaps) — Automatic Photo Retrospectives

## Overview

Recaps are auto-generated photo retrospectives — the local equivalent of
Apple/Google "Memories". Each recap groups a curated set of a user's photos
under a narrative title and cover image. Recaps are rebuilt by a daily cron
job and, incrementally, whenever new metadata (embeddings, faces, GPS, quality
scores) lands for a user's photos. Users can open a recap, play it as a
full-screen Ken-Burns slideshow, or dismiss it so it never resurfaces.

This document describes what the user sees, how recaps are computed, and
which external services contribute to the pipeline.

## User-facing surface

### Where recaps appear

- **Carousel on the Fotos home view** (`RecapsCarousel.vue`) — horizontal
  strip above the photo grid. Only shown when no search/filter is active.
  Clicking a card loads the recap's photos and opens the slideshow player
  directly (Instagram-Stories-style). An "Alle ansehen" link jumps to the
  dedicated Rückblicke view.
- **Dedicated Rückblicke view** (`RecapsView.vue`, route name
  `fotos-recaps`) — full grid of all visible recaps. Each card shows its
  cover, kind badge, title, subtitle and photo count. A round play button
  on the card opens the slideshow directly; clicking elsewhere opens a
  detail overlay with the full photo grid and an "Abspielen" button.

### Badges and states

- **Kind badge** — `Heute vor…` (on-this-day), `Reise` (trip), `Person`,
  `Ort` (place), `Thema` (theme), `Kürzlich` (recent_highlights).
- **"Neu" badge** — shown on cards where the current user has not yet
  opened the recap. The badge disappears the moment the user opens the
  detail overlay or starts the player. Stamped via
  `POST /recaps/:id/seen`.
- **Dismissal** — the detail overlay has an "Ausblenden" button. A
  dismissed recap is kept in the database (with `dismissed_at` set) so
  subsequent rebuilds don't resurface the same memory.

### Player

`RecapPlayer.vue` is a full-screen slideshow with:

- **Ken-Burns motion** — every slide picks a deterministic zoom-in or
  zoom-out plus a random pan direction, seeded from the photo ID so the
  motion is stable across rebuilds.
- **Progress bar** — one segment per photo, fills during playback, pauses
  when the user pauses.
- **Keyboard controls** — `←` / `→` step, `Space` pause, `Esc` close.
- **Auto-hiding chrome** — controls fade after 2.5s of inactivity.
- Default slide duration 4.5s (overridable via `durationMs` prop).

## Data model

| Table | Purpose |
|-------|---------|
| `recaps` | One row per recap. Columns: `user_id`, `kind`, `title`, `subtitle`, `cover_photo_id`, `period_start/end`, `score`, `dedup_key`, `seed` (JSONB context used by builders), `created_at`, `dismissed_at`, `seen_at`. |
| `recap_photos` | Ordered M:N link to photo IDs, with `rank` controlling playback order. |

Recaps are **user-specific**. The same trip or "on this day" event produces
independent rows for every user who owns matching photos — there is no
sharing across users. A unique index `(user_id, dedup_key)` guarantees that
rebuilds upsert rather than duplicate the same logical recap.

Relevant migrations:

- `0030_recaps.sql` — tables, `recap_kind` enum, unique and partial
  indexes.
- `0032_recaps_seen_at.sql` — adds `seen_at` and a partial index on
  unseen visible recaps.

## Recap kinds and builders

All builders live in `photo/recaps.service.ts` and share a common helper,
`upsertRecap()`, which handles dedup, cover selection, photo curation
(ranked by `ai_quality_score`, capped at 30), and title resolution.

### on_this_day

- Groups photos whose month+day matches the current date, bucketed by
  calendar year.
- Requires ≥ 4 photos per year bucket.
- Each year becomes its own recap (`years_ago` stamped into `seed`).
- Dedup key: `on_this_day:YYYY-MM-DD:years_ago`.

### trip

- DBSCAN-ish clustering over GPS-tagged photos taken outside the user's
  home centroid (> 100 km).
- Splits on time gaps > 2 days. Lookback window: 3 years.
- Home centroid is computed from the densest spatial cluster in the
  user's own library.
- Dedup key: `trip:YYYY-MM-DD:YYYY-MM-DD` (start…end).

### person

- Iterates persons the current user has assigned via
  `user_face_assignments`.
- Two windows per person:
  - **Recent** — last 90 days, ≥ 8 photos of that person.
  - **Yearly** — one recap per calendar year with ≥ 12 photos.
- Face detections are the source of truth; recaps do not require the
  person to be the photo owner.

### place

- Groups by `photos.location_city`, requiring ≥ 20 photos and ≥ 3
  distinct capture days (to avoid a single birthday dominating a city).
- City names run through `repairMojibake()` before grouping, so photos
  with `Brüssel` and `BrÃ¼ssel` (legacy Latin-1-as-UTF-8 bytes) collapse
  into the same bucket.

### theme

- Curated set of visual themes (`photo/recap-themes.ts`): beach,
  mountains, food, pets, sunset, winter, flowers, celebrations.
- Each theme sends one or more CLIP prompts (German + English) to the
  `embedding_service` `POST /search/text` endpoint.
- Top-K (300) results per prompt are unioned, filtered by cosine
  similarity threshold (default 0.22; `sunset` uses 0.25 to suppress
  generic-landscape false positives), curated down to 30 photos.
- Theme builder is **skipped gracefully** when the embedding_service is
  unreachable — the other builders still finish.
- Gated by `RECAPS_THEMES_ENABLED` (default on) and a 15s per-prompt
  HTTP timeout (`RECAPS_THEME_TIMEOUT_MS`).

### recent_highlights

- Monthly "Zuletzt" recap from the last 28 days, requiring ≥ 12 photos
  and using `ai_quality_score` for curation.

## Title generation

`photo/recaps-llm-client.ts` calls the `llm-service` `POST /recap-title`
endpoint with a structured context (kind, place, date range, years_ago,
person_name, month_label, photo_count, keywords). The LLM produces a warm,
human-sounding German title + subtitle.

Design rules:

- **Never blocks the rebuild.** 8s timeout, on any failure the builder
  falls back to its deterministic title (e.g. `Vor 2 Jahren`, city name,
  `Juli 2024`).
- **Called at most once per recap.** The result is cached in
  `recap.seed.llm_title = true`; subsequent rebuilds reuse the stored
  title unless the seed changes.
- Gated by `RECAPS_LLM_TITLES` (default on).
- Titles and subtitles run through `repairMojibake()` before storage to
  neutralise UTF-8-as-Latin-1 corruption from tokeniser boundary splits
  in llama-cpp-python's JSON-grammar mode.

## Scheduling

### Daily cron

- `photo/recaps-cron.ts` registers an Encore `CronJob` (`recaps-rebuild`,
  every 24h) that calls the internal endpoint
  `POST /internal/recaps/rebuild`.
- The internal handler calls `rebuildRecapsForAllUsers()`, which
  iterates distinct `photos.user_id`.
- The function is guarded by a module-level promise lock
  (`allUsersRebuildRunning`). If a run overruns and the next tick fires
  before the previous finished, the second trigger logs a warning and
  returns `{ skipped: true }` instead of running a second pass.

### Incremental per-user rebuild

- `scheduleRecapsRebuild(userId)` in `recaps.service.ts` is called from
  the `scan-worker` whenever a job whose outcome can change the recap
  feed completes:
  - `face_assignment` → rebuild for the job's `user_id`.
  - `embedding`, `quality`, `geocoding` → rebuild for all users with
    access to the affected photo.
- Coalesces bursts: per-user mutex + 60s debounce. A bulk scan finishing
  500 jobs triggers at most one real rebuild per user.
- Runs with `{ includeThemes: false }` — the incremental path skips the
  theme builder to avoid hammering the embedding_service with 16–24
  HTTP calls per scan job. Themes refresh on the nightly cron and on
  manual rebuild.

### Manual rebuild

`POST /recaps/rebuild` runs the full builder set (including themes) for
the calling user. The "Aktualisieren"-button in `RecapsView.vue` calls it.

## Curation rules

- **Hidden photos are excluded.** Builders join `photo_curation` and
  filter `hidden_at IS NULL`.
- **Quality score** (`ai_quality_score`) drives both the ranking inside
  a recap (`recap_photos.rank`) and the cover choice (highest-ranked
  photo becomes `cover_photo_id`).
- **Min/max photos** per recap: 4/30. Below 4 the recap is skipped;
  above 30 the top-ranked are kept.

## External services

| Service | Used by | Failure mode |
|---------|---------|--------------|
| `embedding_service` (`EMBEDDING_SERVICE_URL`, default `http://localhost:8001`) | `theme` builder via `POST /search/text` | Theme recaps skipped, other kinds still built. |
| `llm-service` (`LLM_SERVICE_URL`, default `http://localhost:8002`) | Title generation via `POST /recap-title` | Deterministic fallback title used. |

No other microservices are introduced. Thumbnails, face data, GPS and
quality scores all come from existing scan-worker pipelines.

## API surface

All endpoints require `auth: true` and `photos.view`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/recaps` | List visible (non-dismissed) recaps, unseen first, then by `score DESC`, then `created_at DESC`. |
| `GET` | `/recaps/:id` | Full detail including ordered `photo_ids`. |
| `POST` | `/recaps/:id/dismiss` | Hide permanently. |
| `POST` | `/recaps/:id/seen` | Idempotent stamp of `seen_at`. |
| `POST` | `/recaps/rebuild` | Manual rebuild for the current user. |
| `POST` | `/internal/recaps/rebuild` | Cron-only, not exposed. |

The frontend loads photo metadata via the standard `/photos/details`
batch endpoint — recaps only hold IDs, not denormalised photo data.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `EMBEDDING_SERVICE_URL` | `http://localhost:8001` | Base URL for CLIP text search. |
| `LLM_SERVICE_URL` | `http://localhost:8002` | Base URL for recap-title generation. |
| `RECAPS_THEMES_ENABLED` | `1` | Set to `0` to disable the theme builder entirely. |
| `RECAPS_LLM_TITLES` | `1` | Set to `0` to force deterministic titles. |
| `RECAPS_THEME_TIMEOUT_MS` | `15000` | Per-prompt HTTP timeout for theme queries. |
| `RECAP_TITLE_TIMEOUT_MS` | `8000` | Total timeout for a single LLM title call. |

## Gaps vs. the original feature ideas

The iteration-2 plan covered phases 1–8. What landed and what is still
open:

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Additional recap kinds (person, place, recent_highlights) | ✅ | Shipped in #181. |
| 2 — Rich viewer (Ken-Burns player) | ✅ | `RecapPlayer.vue`. |
| 3 — Incremental rebuild scheduler | ✅ | `scheduleRecapsRebuild()` + scan-worker hooks. |
| 4 — Curated CLIP themes | ✅ | 8 themes; embedding_service gated. |
| 5 — LLM-generated titles | ✅ | Cached via `seed.llm_title`. |
| 6 — Theme builder wired into rebuild plumbing | ✅ | Skipped on incremental path. |
| 7 — `seen_at` tracking + "Neu"-badge | ✅ | Migration 0032 + idempotent stamp. |
| 8 — MP4 export of recaps (`scan-service recap_render`) | ❌ | Deferred — no concrete user demand yet. The in-app Ken-Burns player covers the "lean back and watch" case. |

Additional smaller gaps worth tracking:

- **Upstream mojibake source.** ✅ Addressed. `repairMojibake()` is now also
  applied at both producers:
  - `photo/photo.service.ts` `asString()` / `asStringArray()` repair every
    IPTC-sourced field right after exifr hands them back, since exifr's IPTC
    parser uses `getLatin1String()` unconditionally and has no notion of
    `CodedCharacterSet`.
  - `llm-service/main.py` `_repair_mojibake()` is applied to the title,
    subtitle, sender, summary and tags fields after JSON parsing so the
    llama-cpp-python JSON-grammar boundary splits never leak into the
    Encore-side response.
  - Migration `0034_backfill_location_mojibake.sql` repairs historical
    `photos.location_city`, `location_country`, `location_name` and
    `location_short` rows in place.
  The defensive `repairMojibake()` calls in `recaps.service.ts` remain as
  belt-and-braces — they're no-ops on clean strings.
- **User-facing preferences.** There is no way to mute a specific theme
  ("I don't care about sunsets") or a specific person short of dismissing
  each generated recap one by one.
- **Audio.** The player is silent. An optional background track per
  theme (or per recap duration) was discussed but not spec'd.
- **Shared recaps.** Recaps are strictly per-user. Sharing a single
  recap as a lightweight album or link is not implemented.
- **Cross-user collaboration hints.** Trip clusters are computed per
  user even when multiple household members photographed the same trip —
  the feed shows duplicate trips rather than merging them.
- **Theme tuning / feedback loop.** Cosine thresholds and `minPhotos`
  are currently hand-tuned constants. There is no learning from
  dismissals or per-user tuning.
