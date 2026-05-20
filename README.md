# FK-Encore

**FK-Encore** is a self-hosted platform for managing the digital life of a
household — **photos**, **documents**, and **personal finance** in one place,
with AI-powered organization, collaborative curation, and natural-language
search. It is built on [Encore.ts](https://encore.dev) for the backend and a
Vue 3 single-page application for the frontend, orchestrated together with
specialized Python microservices for machine-learning workloads.

## Overview

FK-Encore turns a family's scattered digital records into a searchable,
collaborative archive across three domains:

- **Photos** — uploaded images are automatically analyzed for faces, points of
  interest, semantic content, visual similarity, and quality. Albums become
  collaborative spaces where multiple users (and the AI itself) vote on
  favorites.
- **Documents** — PDFs are OCR'd, classified into a custom taxonomy by a local
  LLM, tagged against German income-tax sections, and made searchable by both
  full text and meaning.
- **Finance** — bank accounts are synced over FinTS/HBCI, transactions are
  imported and deduplicated, and an LLM suggests tags for categorization.

It is philosophically closer to a curation tool than a cloud-storage clone:
self-hosted, privacy-first (all ML runs locally — no third-party APIs),
photo-only for media (no video), and tuned for German-language search,
tax categories, and banking.

## Key features

### Photo management
- Web upload with JPEG, PNG, GIF, WebP, and automatic HEIC → JPEG conversion
- Hash-based and ML-based duplicate detection (DINOv2) with a review workflow
- On-the-fly resizing via query parameter
- Intelligent thumbnail focus point derived from detected faces and POIs
- AI-based quality score for every photo

### Document management
- Streaming PDF upload with automatic text extraction — `pdf-parse` for digital
  PDFs, Tesseract OCR fallback for scanned documents
- AI classification into a custom taxonomy (category, title, sender, summary,
  tags) by a **local** Llama LLM — no document ever leaves the host
- German income-tax tagging: multi-label assignment to tax sections
  (Anlage N / KAP / V / …) with confidence scores and a hardlinked `_steuer`
  folder view for assembling a tax return
- Hybrid search — lexical full-text (PostgreSQL `tsvector`) and semantic search
  (pgvector / HNSW over multilingual-e5 embeddings) fused by reciprocal rank
- Inbox dropbox: unclassified PDFs land in `_inbox` and a background worker
  relocates them into the right category tree once classified
- Per-group visibility and access control

### Personal finance
- Bank-account integration over **FinTS/HBCI** with the German TAN/2FA
  challenge flow
- Automated statement sync plus a manual dropbox watcher for MT940 / CSV
  imports; SEPA field extraction and SHA-256 transaction de-duplication
- Manual bookings and per-transaction tagging, with AI tag suggestions from
  the local LLM
- Row-level multi-account access control (read/write per user)
- Daily JSON export snapshots for disaster recovery (credentials never
  exported), with rotation
- Portfolio/holdings aggregation and transaction anomaly detection

### AI / machine learning (all local)
- **Face recognition & clustering** – InsightFace (`buffalo_l`) with
  distance-based clustering, named people, merging, and per-face ignore
- **POI detection** – a self-hosted PostGIS database per OSM region (one DB in
  the `geo-db` container, populated by `osm2pgsql` from Geofabrik PBFs and
  refreshed hourly), matched against a photo's DINOv2 embedding to identify
  concrete points of interest (Brandenburger Tor, Marienplatz, …) with a
  Wikipedia link and a Wikimedia Commons reference image
- **Document classification & embeddings** – local Llama-3.2-3B (GGUF) plus a
  multilingual-e5 sentence-transformer
- **Semantic image search** – OpenCLIP embeddings
- **Visual similarity** – DINOv2 embeddings, plus a hybrid CLIP + DINOv2 mode
- **Photo quality scoring** – AI score with detail metrics, used for AI-driven
  album voting

### Search
- Natural-language photo search in German with query parsing and decomposition
  (location + date + semantic content combined automatically)
- GPS radius search in kilometers; POI, city/country, and date-range search
- Hybrid lexical + semantic document search

### Collaborative albums & sharing
- Shared albums with read/write access per user
- Anonymous voting ("3 / 5 favorites") and AI-as-participant quality voting
- Multiple view modes per album: All / Favorites / Consensus / Custom
- Public album share links with email-based guest accounts, threaded photo
  comments, and per-guest event notifications

### Notifications & real-time
- Activity feed of album events (photos added, shares, likes, comments) with
  unread badge tracking
- WebSocket real-time delivery with channel subscriptions and reconnect replay
- Web Push (VAPID) browser notifications with per-type preferences

### Authentication & access control
- Password login (bcrypt) and **WebAuthn / FIDO2 passkeys** with multi-passkey
  support
- Token-based password reset via email
- Granular role-based access control with custom roles and a large permission
  catalog (photos, documents, finance, OSM admin, data management, …)
- Rate limiting on auth endpoints
- Dedicated, opt-in `photos.purge` permission for the destructive "delete all
  photo data" action (not granted to Admin by default — see
  [`docs/purge.md`](./docs/purge.md))

## Architecture

| Component            | Role                                                           |
|----------------------|----------------------------------------------------------------|
| `app` (Encore.ts)    | Main application – REST API + static frontend SPA              |
| `frontend`           | Vue 3 + PrimeVue + Pinia SPA (served under `/app/`)            |
| `postgres`           | PostgreSQL 18 + `pgvector` – main application DB and the embeddings DB |
| `insightface`        | Python – face detection & embeddings (InsightFace `buffalo_l`) |
| `embedding_service`  | Python – CLIP + DINOv2 image embeddings                        |
| `llm_service`        | Python – local Llama classifier + multilingual-e5 text embeddings (documents + finance) |
| `geo`                | Node – owns `osm2pgsql` + `osm2pgsql-replication`, serves reverse-geocoding and POI lookups |
| `geo-db`             | PostGIS 16 – one database per imported OSM region              |

All machine learning runs in these local services — no photo, document, or
bank statement is ever sent to a third-party API.

See [`FEATURE_COMPARISON.md`](./FEATURE_COMPARISON.md) for a detailed
feature-by-feature comparison against Immich,
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full deployment guide, and
[`docs/osm-admin-deployment.md`](./docs/osm-admin-deployment.md) for the geo /
POI subsystem.

## Prerequisites

- [Encore CLI](https://encore.dev)
  - macOS: `brew install encoredev/tap/encore`
  - Linux: `curl -L https://encore.dev/install.sh | bash`
  - Windows: `iwr https://encore.dev/install.ps1 | iex`
- [Docker](https://www.docker.com/) (with Compose v2) – required for PostgreSQL
  and the ML services
- Node.js 20+
- At least **8 GB of RAM** for the ML models (16 GB recommended when running
  OSM region imports alongside the ML services)

## Running locally

Run the full stack (backend + frontend + ML services) via Docker Compose:

```bash
cp docker-compose.env.example .env
# edit .env – at minimum set ADMIN_PASSWORD, WATCHTOWER_TOKEN,
# GEO_DB_PASSWORD, and DEPLOY_DATA_ROOT
docker compose up -d
```

The application is then reachable at <http://localhost:8080>.

A single `docker-compose.yml` covers both production and any additional
deployments (e.g. a PR-image test stack alongside prod on the same host). The
deployment-specific values (container-name suffix, image tag, host ports,
volume bind paths, …) all flow from the env-file. To run a second deployment:

```bash
cp docker-compose.env.test.example .env.test
# edit .env.test as needed
docker compose --env-file .env.test up -d
```

That stack uses port 18080 by default, image tag `:test`, and container names
with a `-test` suffix; compose's project namespace keeps its volumes (including
the `geo-db` PostGIS data) separate from production's. See
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full env reference.

For active backend development, use the Encore CLI directly from the project
root:

```bash
encore run
```

While `encore run` is active, open <http://localhost:9400/> to access the
Encore [local developer dashboard](https://encore.dev/docs/observability/dev-dash)
with traces, architecture diagrams, and the service catalog.

Start the frontend dev server separately:

```bash
npm run dev:frontend
```

## Deployment

The recommended deployment is the Docker Compose stack described above and in
[`DEPLOYMENT.md`](./DEPLOYMENT.md). The `app` container serves both the frontend
SPA under `/app/` and all API endpoints on the same origin (no reverse-proxy
rewrite required); requests to `/` redirect to `/app/`. It does **not** run
standalone — it depends on the `postgres`, `insightface`, `embedding_service`,
`llm_service`, `geo` and `geo-db` services from the Compose stack.

Health endpoints:
- `GET /healthz` → `{ "status": "ok" }`
- `GET /health` → same payload (alias)

Run a local container smoke test (health + redirect + SPA index):

```bash
bash scripts/container-smoke-test.sh fk-encore:smoke
```

Service images are built and published to GHCR by the `docker-image-*.yml`
GitHub Actions workflows; on a server, Watchtower pulls updated images
automatically. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full environment
variable reference and host-setup notes.

## Testing

Run the backend test suite with infrastructure set up automatically by Encore:

```bash
encore test
```

This uses [Vitest](https://vitest.dev/) under the hood. Infrastructure (test
databases, Pub/Sub, etc.) is provisioned in test mode before the runner starts.
See the [Encore testing docs](https://encore.dev/docs/ts/develop/testing) for
details.

## Pre-commit / pre-push hooks

The repo ships with [husky](https://typicode.github.io/husky/) hooks that run
the same checks the CI build runs, so a green commit/push means a green CI
build. They install automatically via `npm install` (the root `prepare`
script).

| Hook         | What it runs                                                                  | Typical time |
|--------------|-------------------------------------------------------------------------------|--------------|
| `pre-commit` | `node scripts/check-sfc.mjs` + `vue-tsc --noEmit -p frontend/tsconfig.app.json` | 5–20 s       |
| `pre-push`   | `npm --prefix frontend run build` (full vue-tsc + vite build)                  | 30–60 s      |

`scripts/check-sfc.mjs` runs `@vue/compiler-sfc` over every `*.vue` file — it
catches Vue template parse errors that `vue-tsc` is too permissive to report
(e.g. multi-line attribute expressions that vite later refuses).

Bypass locally with `git commit --no-verify` / `git push --no-verify` only when
truly necessary; CI runs the same checks anyway.

## License

MPL-2.0
