# FK-Encore

**FK-Encore** is a self-hosted photo management platform with AI-powered
organization, collaborative album curation, and natural-language search. It is
built on [Encore.ts](https://encore.dev) for the backend and a Vue 3 single-page
application for the frontend, orchestrated together with specialized Python
microservices for machine learning workloads.

## Overview

FK-Encore turns a private photo library into a searchable, collaborative
archive. Uploaded images are automatically analyzed for faces, landmarks,
semantic content, visual similarity, and quality. Albums become collaborative
spaces where multiple users (and the AI itself) can vote on favorites, with
multiple view modes such as *All*, *Favorites*, *Consensus*, and custom
selections.

The project is philosophically closer to a curation tool than a Google Photos
clone: it is photo-only (no video), optimized for shared events and family
libraries, and tuned for German-language search with intelligent query
decomposition.

## Key features

### Photo management
- Web upload with JPEG, PNG, GIF, WebP, and automatic HEIC → JPEG conversion
- Hash-based and ML-based duplicate detection (DINOv2) with a review workflow
- On-the-fly resizing via query parameter
- Intelligent thumbnail focus point derived from detected faces and landmarks
- AI-based quality score for every photo

### AI / machine learning
- **Face recognition & clustering** – InsightFace (`buffalo_l`) with distance-based
  clustering, named people, merging, and per-face ignore
- **Landmark detection** – Grounding DINO for churches, bridges, towers, and
  other points of interest
- **Semantic search** – OpenCLIP embeddings
- **Visual similarity** – DINOv2 embeddings, plus a hybrid CLIP + DINOv2 mode
- **Photo quality scoring** – AI score with detail metrics, used for
  AI-driven album voting

### Search
- Natural-language search in German with query parsing and decomposition
  (location + date + semantic content combined automatically)
- GPS radius search in kilometers
- Landmark search, city/country search, and date-range search

### Collaborative albums
- Shared albums with read/write access per user
- Anonymous voting ("3 / 5 favorites")
- AI as album participant – quality-based voting
- Multiple view modes per album: All / Favorites / Consensus / Custom
- Hide photos, favorite photos per user and per album

### Authentication & access control
- Password login (bcrypt) and **WebAuthn / FIDO2 passkeys** with multi-passkey
  support
- Token-based password reset via email
- Granular RBAC with 19+ permissions and custom roles
- Rate limiting on auth endpoints
- Dedicated, opt-in `photos.purge` permission for the destructive
  "delete all photo data" action (not granted to Admin by default —
  see [`docs/purge.md`](./docs/purge.md))

### Storage & infrastructure
- Encore `SQLDatabase` (PostgreSQL) with Drizzle ORM
- Encore object storage buckets for photos
- Dedicated PostgreSQL with `pgvector` for embeddings
- OpenAPI specification generated from Encore.ts
- Modular microservice architecture: 3 specialized ML services

## Architecture

| Component            | Role                                             |
|----------------------|--------------------------------------------------|
| `app` (Encore.ts)    | Main application – REST API + static frontend    |
| `frontend`           | Vue 3 + PrimeVue + Pinia SPA (served under `/app/`) |
| `insightface-service` | Python – face detection & embeddings            |
| `embedding_service`  | Python – CLIP and DINOv2 embeddings              |
| `landmark-service`   | Python – Grounding DINO landmark detection       |
| `embedding_postgres` | PostgreSQL + pgvector for vector search          |

See [`FEATURE_COMPARISON.md`](./FEATURE_COMPARISON.md) for a detailed
feature-by-feature comparison against Immich, and
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full deployment guide.

## Prerequisites

- [Encore CLI](https://encore.dev)
  - macOS: `brew install encoredev/tap/encore`
  - Linux: `curl -L https://encore.dev/install.sh | bash`
  - Windows: `iwr https://encore.dev/install.ps1 | iex`
- [Docker](https://www.docker.com/) (with Compose v2) – required for local
  PostgreSQL and the ML services
- Node.js 20+
- At least **8 GB of RAM** for the ML models

## Running locally

Run the full stack (backend + frontend + ML services) via Docker Compose:

```bash
cp docker-compose.env.example .env
# edit .env – at minimum set ADMIN_PASSWORD
docker compose up -d
```

The application is then reachable at <http://localhost:8080>.

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

### Docker runtime

The container runs a single `encore run` process that serves both the frontend
SPA under `/app/` and all API endpoints on the same origin (no reverse proxy
rewrite required). Requests to `/` are redirected to `/app/`.

Health endpoints:
- `GET /healthz` → `{ "status": "ok" }`
- `GET /health` → same payload (alias)

Run a local container smoke test (health + redirect + SPA index):

```bash
bash scripts/container-smoke-test.sh fk-encore:smoke
```

### Self-hosting (single container)

```bash
docker run -d --name my-encore-app -p 8080:8080 \
  -e ADMIN_EMAIL=abc@example.com \
  -e ADMIN_NAME=abc \
  -e ADMIN_PASSWORD=secret7! \
  -e RP_NAME="My Encore App" \
  -e RP_ORIGIN=http://localhost:8080 \
  -e ENABLE_LOCAL_FACES=true \
  -e INSIGHTFACE_SERVICE_URL=http://localhost:8000 \
  -e FACE_DISTANCE_THRESHOLD=0.45 \
  -v /path/to/photos:/mnt/data/photos \
  -v /path/to/db:/mnt/data/db \
  fk-encore
```

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the recommended Docker Compose
deployment and the full list of environment variables.

## Testing

Run the backend test suite with infrastructure set up automatically by Encore:

```bash
encore test
```

This uses [Vitest](https://vitest.dev/) under the hood. Infrastructure (test
databases, Pub/Sub, etc.) is provisioned in test mode before the runner starts.
See the [Encore testing docs](https://encore.dev/docs/ts/develop/testing) for
details.

## License

MPL-2.0
