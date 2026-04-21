# Photo View Responsiveness

This document describes the work that has been done to keep the photo views
responsive — especially while background scan workers are processing a large
library — and outlines additional improvements that could be made later.

The work was executed in two phases. Phase 1 addressed the hottest
server-side bottlenecks around queueing, pooling, indexing, and event-loop
fairness. Phase 2 is a layer of HTTP and process caching on top of that:
cheap short-circuits that keep the wire traffic and the CPU cost down when
nothing interesting has changed.

---

## Problem Statement

When the server is busy — typically while many scan workers concurrently
extract metadata, generate thumbnails, decode HEICs, run face detection and
landmark detection, and upload CLIP embeddings to the ML services — two
classes of user-facing pain used to appear:

1. **Photo lists feel sluggish.** `/photos/index` queries take longer,
   thumbnails come back slowly, and the UI spinner stays up. In the worst
   case, health checks start timing out because the Node.js event loop is
   saturated.
2. **One stalled external RPC stalls everything.** A hanging embedding /
   InsightFace / landmark request holds a DB connection slot, which
   eventually backs up the foreground HTTP handlers.

Both classes are addressed below.

---

## Phase 1 — Server-Side Throughput & Fairness

Phase 1 landed in commit `4a73368` (*"perf(photo): keep photo views
responsive under scan load"*).

### Quick wins

- **Thumbnail pre-warming on upload.** When a photo is ingested the common
  thumbnail widths (`320`, `480`, `800`) are generated immediately in the
  background instead of on first client request. The first time the grid
  scrolls over a photo, the thumbnail is already on disk and just needs to
  be streamed.
- **Slim `/photos/index` payload.** The endpoint used to materialise ~20
  columns per row, including the heavy JSONB columns (`ai_quality_details`,
  `location_*`, `description`, `hash`, GPS). The payload is now trimmed to
  ~10 small columns, so the same list of 5 000 photos is an order of
  magnitude smaller on the wire and much cheaper to serialize.
- **Covering indexes.** The filter + pagination query on
  `/photos/index` is served by a composite index aligned with the default
  sort, removing the post-fetch heap sort on large libraries.

### Medium work

- **sharp() worker pool (`photo/image-pool.ts`).** Resize operations are
  funneled through a bounded pool so a scan burst cannot monopolise all
  sharp threads and starve a user-facing thumbnail request.
- **DB connection slots (`photo/worker-db-slots.ts`).** Scan workers
  acquire slots from a dedicated semaphore before running their pipeline,
  which leaves headroom in the pg pool for HTTP handlers.
- **Prioritised scan queues.** Workers drain light / metadata jobs ahead
  of heavy GPU jobs so that visible effects (keywords, people, quality
  badges) show up first.

### Architectural work

- **Event-loop back-pressure (`photo/event-loop-pressure.ts` +
  `photo/scan-worker.ts`).** A lightweight monitor samples the event-loop
  lag every 2 s. When it exceeds the threshold (500 ms by default), scan
  workers *pause* between jobs or skip a tick entirely, giving the Node
  runtime room to service incoming requests. Health checks stay
  responsive, and as soon as pressure drops the workers resume at full
  speed. The state is exposed via `/photos/service-health` so the UI can
  show a banner.
- **Worker yield between jobs.** Even outside of pressure, workers yield
  via `setTimeout(0)` between jobs so pending I/O callbacks — including
  incoming health checks — always get a turn.

See [`event-loop-backpressure.md`](./event-loop-backpressure.md) for the
full design of the pressure monitor.

---

## Phase 2 — HTTP & Process Caching

Phase 2 is layered on top of Phase 1. It does not change the server-side
throughput, but it removes work on the *happy path* where nothing has
changed since the last request. The changes are deliberately cheap and
self-healing — they never return stale data.

### 1. Strong ETag on `/photos/file`

`photo/photo.ts :: getPhotoFile`

The thumbnail cache and the originals on disk are immutable for the
lifetime of a photo — filenames are content-addressed (upload timestamp or
external library path) and files are never overwritten in place. That
invariant lets the server emit a strong ETag derived purely from the
filename plus the transform parameters, without hashing the file bytes:

```
ETag: "md5(filename | w=<width> | c=<convert?>)"
Cache-Control: public, max-age=31536000, immutable
```

On a subsequent request the browser sends `If-None-Match` with that
ETag. The server compares it against the recomputed one and, if they
match, short-circuits with **304 Not Modified** — no `sharp()` call, no
HEIC decode, no file read. The browser reuses its local copy.

Even on a cache miss (no `If-None-Match` header, or a stale one) the same
`Cache-Control: immutable` and `ETag` headers are set on all three
response paths (thumbnail cache hit, freshly generated thumbnail, and
passthrough of the original), so the first response is automatically
cacheable for a year.

### 2. HEIC decode LRU (`photo/heic-cache.ts`)

HEIC decoding via `heic-convert` (libheif/WASM) is the single most
expensive step in the photo pipeline — a 12 MP iPhone HEIC takes
150–300 ms of pure CPU per decode. Several pipelines ask for the same
decoded JPEG back-to-back:

- thumbnail prewarm,
- quality scoring,
- face detection,
- landmark detection,
- embedding upload (when the original is HEIC),
- on-demand `/photos/file?convert=true` from the UI.

The decoded JPEG buffers are now held in a tiny LRU keyed by
`(filePath, mtimeMs)` with both an entry cap and a byte-budget cap. A
cache hit turns the decode into a memcpy. If a library ever replaces a
file under us, the stored `mtimeMs` no longer matches and the entry is
evicted automatically — stale data is impossible by construction.

Knobs (env):

| Variable | Default | Description |
|---|---|---|
| `HEIC_DECODE_CACHE_ENTRIES` | `32`               | Max cached decoded files. `0` disables. |
| `HEIC_DECODE_CACHE_BYTES`   | `134217728` (128M) | Soft byte budget. Eviction is LRU. |

### 3. Request timeouts on ML RPCs (`photo/rpc-timeout.ts`)

Every `fetch(…)` to an external ML service (embedding, InsightFace,
landmark) now goes through `fetchWithTimeout()`. A stalled external
service used to hold a DB connection slot and a libuv network slot
indefinitely, which eventually backs up the HTTP handlers behind
`/photos/index`.

- `ML_RPC_TIMEOUT_MS` (default **60 s**) — used for worker-side pipelines.
- `ML_RPC_QUICK_TIMEOUT_MS` (default **15 s**) — used for text search
  and other latency-sensitive, request-path calls. A hung embedding
  service can no longer hold up the UI spinner indefinitely.

A timeout raises a dedicated `MlRpcTimeoutError` (distinct from
user-triggered `AbortError`), so workers can branch on it for retry /
defer / mark-failed logic.

Caller-supplied `AbortSignal`s are still honoured — the implementation
chains the two signals so either the caller or the timeout can abort the
request.

### 4. `/photos/index` ETag + 304

`photo/photo.ts :: listPhotoIndex` (now an `api.raw` endpoint with
`auth: true`)

The endpoint now emits an ETag derived from a cheap user-scoped
fingerprint of the photos table *plus* the exact filter + pagination the
client requested:

```
ETag = md5( userId | MAX(photos.updated_at) | COUNT(*) | serializedFilter )
```

- `MAX(photos.updated_at)` is kept current by two triggers added in
  migration **0034** (see below). Any insert, update, or delete on
  `photos` bumps `photos.updated_at`; any insert/update/delete on
  `photo_curation` (per-user favorite / hide flags, which are part of
  the `/photos/index` payload) propagates the touch up to the photo's
  row so the fingerprint also flips.
- `COUNT(*)` catches deletes that do not move `MAX` — e.g. removing an
  older photo while a newer one still holds the max timestamp.
- `serializedFilter` is the filter + pagination pair with `undefined` /
  empty values stripped and keys sorted alphabetically, so URLs with the
  same effective filter but different parameter order produce identical
  ETags.

The fingerprint query is a single aggregated `SELECT` served by the new
`photos_user_id_updated_at_idx` index, so it runs in single-digit ms
even on libraries with hundreds of thousands of rows. When the ETag
matches the client's `If-None-Match`, the handler returns **304 Not
Modified** and skips the full `SELECT` and JSON serialization entirely.

Headers:

```
Cache-Control: private, no-cache
ETag: "<hash>"
Vary: Authorization
```

`private, no-cache` is deliberate — it tells the browser it MAY store
the response but MUST revalidate on every subsequent fetch, which is
exactly how we want the ETag flow to behave. Per-user data never ends
up in a shared proxy.

#### Migration 0034

`db/migrations/postgres/0034_photos_updated_at.sql` adds:

- `photos.updated_at TIMESTAMP NOT NULL DEFAULT NOW()` (backfilled from
  `created_at`).
- `touch_photos_updated_at` — `BEFORE UPDATE` trigger that sets
  `NEW.updated_at := NOW()` on any row mutation.
- `touch_photo_on_curation` — `AFTER INSERT OR UPDATE OR DELETE` trigger
  on `photo_curation` that bumps the related photo's `updated_at`.
- `photos_user_id_updated_at_idx` on `(user_id, updated_at DESC)` — makes
  the fingerprint `MAX(updated_at)` query a cheap index scan.

Triggers rather than application-level writes were chosen because every
mutation path (including schema migrations and manual SQL) must flip the
fingerprint; the DB is the only place where that guarantee is total.

---

## Configuration Summary

| Variable                         | Default      | Purpose |
|----------------------------------|--------------|---------|
| `EVENT_LOOP_CHECK_INTERVAL_MS`   | `2000`       | Phase 1 — lag sample interval |
| `EVENT_LOOP_LAG_THRESHOLD_MS`    | `500`        | Phase 1 — pressure threshold |
| `WORKER_PRESSURE_DELAY_MS`       | `1000`       | Phase 1 — per-job back-off under pressure |
| `HEIC_DECODE_CACHE_ENTRIES`      | `32`         | Phase 2 — max cached HEIC decodes |
| `HEIC_DECODE_CACHE_BYTES`        | `134217728`  | Phase 2 — byte budget for HEIC cache |
| `ML_RPC_TIMEOUT_MS`              | `60000`      | Phase 2 — timeout for worker-side ML RPCs |
| `ML_RPC_QUICK_TIMEOUT_MS`        | `15000`      | Phase 2 — timeout for request-path ML RPCs |

---

## What Could Be Done Later

The following ideas would each be worth their own design pass before
implementation, but none of them is needed for the current baseline to
feel good:

- **Adaptive worker concurrency.** Today the scan-worker concurrency is
  a fixed number tuned to the pressure threshold. A closed-loop
  controller (similar to TCP congestion control) could raise concurrency
  while lag stays well under the threshold and halve it the moment lag
  spikes. This would let small deployments use more of their hardware
  without manual tuning.
- **Server-push queue status (SSE or WebSocket).** The frontend
  currently polls `/photos/scan-status` every few seconds to show queue
  depth and per-stage progress. A server-push channel would eliminate
  the poll traffic entirely and make the UI feel snappier. It would
  also let us push "your new photo is ready" events the moment the
  last pipeline stage finishes.
- **Frontend virtualization + responsive `srcset`.** The photo grid
  still mounts a real DOM element per thumbnail. Virtualizing (e.g.
  with TanStack Virtual) plus emitting `<img srcset>` with the prewarmed
  320/480/800 widths would cut initial render time and let the browser
  pick the right resolution for the viewport — saving bandwidth on
  high-DPR screens and avoiding unnecessary upscaling on small ones.
- **Per-request metrics endpoint.** `/metrics` in Prometheus format
  exposing event-loop lag, DB slot utilisation, HEIC cache hit ratio,
  ML RPC timeout counts, and `/photos/index` ETag hit ratio would make
  it possible to spot regressions from a dashboard rather than from
  user reports.
- **Share the 304 flow with `/albums/:id/photos`** and the other list
  endpoints that are user-scoped and trigger-protected. The
  fingerprint helper (`getPhotoIndexFingerprint` /
  `photoIndexEtag`) is already structured to be reused.
- **Persisted HEIC decode cache on disk.** The LRU is purely in-memory
  and empty after a restart. A small on-disk cache keyed by
  `(sha256(path), mtimeMs)` would survive restarts for the price of a
  few hundred MB of thumbnails directory. The existing thumbnail cache
  would be a natural home.
- **Tune `photos` autovacuum.** The new `BEFORE UPDATE` trigger means
  `photos` sees a stream of UPDATEs even during read-heavy periods
  (favoriting, hiding, etc. all touch the row). If the dead-tuple
  ratio starts to grow on large libraries, per-table
  `autovacuum_vacuum_scale_factor` should be lowered.
