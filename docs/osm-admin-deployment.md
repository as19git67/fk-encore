# `osm-admin` — Deployment Notes (Epic #383)

The `osm-admin` Encore service manages per-region Nominatim and Overpass
containers that back the upcoming POI detection pipeline. This document
captures the deployment bits that the application code can't infer at
runtime.

## Activating the dockerode driver

The active container driver is process-local and defaults to
`InMemoryDockerDriver` (no Docker socket needed, status transitions are
simulated). The real dockerode-backed driver is opt-in via env:

```
OSM_ADMIN_DOCKER_DRIVER=dockerode
OSM_ADMIN_DOCKER_NETWORK=osm-net
```

When `OSM_ADMIN_DOCKER_DRIVER=dockerode`, the service talks to the host
Docker daemon via the standard unix socket. **The osm-admin container
must therefore bind-mount `/var/run/docker.sock`**:

```yaml
services:
  app:
    # … existing config …
    environment:
      OSM_ADMIN_DOCKER_DRIVER: dockerode
      OSM_ADMIN_DOCKER_NETWORK: osm-net
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - default
      - osm-net

networks:
  osm-net:
    driver: bridge
```

> ⚠️ Mounting the docker socket grants root-equivalent access to the
> host. This is acceptable for the self-hosted/private deployment model
> the project targets (see the investigation comments on issue #83).
> For multi-tenant deployments, prefer a remote Docker API endpoint
> over TLS — `new Dockerode({ host, port, ca, cert, key })` — or run
> the importer outside of Docker entirely.

## Per-region container layout

Each region the importer brings up appears on the `osm-net` Docker
network with deterministic names so the upcoming router can address
them via Docker DNS without any port mapping:

| Slug `europe/germany/bayern` | Container name |
|---|---|
| Long-running Nominatim API | `nominatim-europe-germany-bayern` |
| Long-running Overpass API | `overpass-europe-germany-bayern` |
| One-shot import (transient) | `nominatim-import-europe-germany-bayern` |

The shared Postgres for the per-region Nominatim DBs is **not** the
main application Postgres — it's a separate container so a runaway
Nominatim import can't lock up the photo metadata DB. A minimal
template:

```yaml
  osm-postgres:
    image: postgis/postgis:16-3.4
    container_name: osm-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: nominatim
      POSTGRES_PASSWORD: ${NOMINATIM_PASSWORD:-changeme}
      POSTGRES_DB: postgres
    volumes:
      - osm_postgres_data:/var/lib/postgresql/data
    networks:
      - osm-net

volumes:
  osm_postgres_data:

networks:
  osm-net:
    driver: bridge
```

The Nominatim containers are passed `POSTGRES_DB=nom_<sanitised_slug>`
by the importer (column `osm_region_imports.postgres_db`). Each region
gets its own database inside the shared Postgres instance.

## Disk-space budget

Rule of thumb the importer enforces before doing any work:

```
free_disk_mb ≥ pbf_size_mb × 10
```

The Nominatim Postgres footprint per region is typically 5–10× the raw
PBF size; with the safety factor of 10 we never trip mid-import. Rows
that fail the pre-check land in status `blocked_disk` and the admin UI
surfaces the shortfall.

Quick reference (from real Geofabrik extracts as of 2024):

| Region | PBF (~MB) | Postgres footprint (~MB) |
|---|---|---|
| Bayern | 600 | 5 000 |
| Germany | 4 200 | 35 000 |
| Austria | 800 | 6 500 |
| France | 4 800 | 40 000 |

## Auto-approve threshold

```
POI_REGION_AUTO_IMPORT_MAX_PBF_MB=1500
```

Regions whose probed PBF size is below this go straight to `importing`;
larger regions land in `pending_approval` and require an admin click.
The default (1.5 GB) covers most Bundesländer / regional extracts but
keeps full-country imports behind manual approval.

## Healthchecks

Each region container exposes an HTTP status endpoint that the importer
polls before flipping the row to `ready_running`:

| Container | URL |
|---|---|
| `nominatim-<slug>` | `http://nominatim-<slug>:8080/status` |
| `overpass-<slug>` | `http://overpass-<slug>/api/status` |

The poll budget is 300 attempts × 2 s = 10 minutes per container. A
Nominatim cold start (first response after import) typically takes
60–90 s; the budget covers slow disks comfortably.

## Idle-stop sweeper (future slice)

A sweeper in `osm-admin` will stop region containers after 30 min of
inactivity (`POI_REGION_IDLE_STOP_MINUTES=30`) and start them on
demand. Cold-start a stopped Nominatim container takes ~3–5 s — fine
for the background POI worker, fast enough that the round-trip is
invisible for an on-demand admin lookup.

This isn't wired up yet; until it is, `ready_running` containers stay
up indefinitely.
