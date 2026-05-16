# `osm-admin` — Deployment Notes (Epic #383)

The `osm-admin` Encore service manages per-region Nominatim and Overpass
containers that back the POI detection pipeline. This document captures
the deployment bits that the application code can't infer at runtime.

## Architecture in one paragraph

Each region (e.g. `europe/germany/bayern`) is realised as **two
self-contained containers**: `nominatim-<slug-suffix>` (mediagis/nominatim,
bundled Postgres included) and `overpass-<slug-suffix>` (wiktorn/overpass-api).
Both store their data in **named Docker volumes**, which the daemon
creates on first use — there is no shared Postgres, no bind mounts to
manage. Importing a region = passing a Geofabrik PBF URL via env to the
container on its first start with an empty volume. Deleting a region =
`docker rm` on the two containers plus `docker volume rm` on their
volumes.

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
      NOMINATIM_PASSWORD: ${NOMINATIM_PASSWORD:-changeme}
    volumes:
      # In addition to the existing mounts:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - default
      - osm-net

networks:
  osm-net:
    driver: bridge
```

That is the **entire compose-side change** — no per-region services,
no shared Postgres, no named-volume declarations. Everything below is
created by `osm-admin` at runtime via dockerode.

### Docker socket access for non-root containers

The `fk-encore-app` container typically runs as the TrueNAS SCALE
"apps" user (`568:568`). The host's docker socket usually has mode
`660 root:docker`, so `568` can't read it out of the box. Two options:

- **Test sandbox** (quickest): override `user: "0:0"` on the `app`
  service so the Encore process can reach the socket.
- **Production**: look up the host's docker group GID and pass it via
  `group_add`:
  ```yaml
  group_add:
    - "${HOST_DOCKER_GID:-999}"
  ```
  Resolve `HOST_DOCKER_GID` on the host with
  `getent group docker | cut -d: -f3` and set it in `.env`.
  Typical values: **999** (TrueNAS SCALE 25.x, Debian, Ubuntu),
  **985** (Alpine). Always verify on your specific host — the default
  in the snippet is a fallback, not a guarantee.

> ⚠️ Mounting the docker socket grants root-equivalent access to the
> host. Acceptable for the self-hosted/private deployment model this
> project targets (see comments on issue #83). For multi-tenant
> deployments, use a remote Docker API endpoint over TLS instead.

## Per-region container layout

Each region the importer brings up appears on `osm-net` with
deterministic names so the router addresses them via Docker DNS without
any port mapping:

| Slug `europe/germany/bayern` | Container name | Volume name |
|---|---|---|
| Nominatim | `nominatim-europe-germany-bayern` | `fk-encore-osm-nominatim-europe-germany-bayern` |
| Overpass | `overpass-europe-germany-bayern` | `fk-encore-osm-overpass-europe-germany-bayern` |

Containers store their database under:
- Nominatim: `/var/lib/postgresql/16/main` (the bundled Postgres data
  directory)
- Overpass: `/db`

Both are mounted via Docker named volumes, so the data survives container
restarts and is removed only when the user explicitly deletes the region.

## Tuning env variables passed to the containers

The importer reads the following from its own environment when it
constructs container descriptors:

| Env | Meaning | Default |
|---|---|---|
| `NOMINATIM_PASSWORD` | Internal Postgres password inside the per-region nominatim container. Any value works; it never leaves the container. | `changeme` |
| `NOMINATIM_IMAGE` | Override the nominatim image tag (test-pinning, fork). | `mediagis/nominatim:5.0` |
| `OVERPASS_IMAGE` | Override the overpass image tag. The default is **not** an upstream image — see "Overpass PBF image" below. | `fk-encore-overpass-pbf:latest` |
| `NOMINATIM_IMPORT_STYLE` | Nominatim import profile (`full`, `address`, `street`, `admin`). `address` is plenty for POI detection and ~30 % faster than `full`. | `address` |

## Overpass PBF image

The upstream `wiktorn/overpass-api` image only ingests `.osm.bz2`
planet files. Geofabrik publishes those for top-level regions
(countries, Bundesländer) but **not** for sub-regions like
Regierungsbezirke (Oberbayern, Mittelfranken, …). Those are
PBF-only. Trying to feed a PBF to the upstream image fails with
`bunzip2: not a bzip2 file` and the container exit-loops.

To handle PBFs, the importer expects an extended image
`fk-encore-overpass-pbf:latest` on the host. It's a one-line
extension of the upstream image that installs `osmconvert` and lets
us point `OVERPASS_PLANET_PREPROCESS` at it.

Build it once on the host:

```bash
# Either: clone the repo and run a normal build
docker build -t fk-encore-overpass-pbf:latest osm-admin/overpass-pbf/

# Or: inline build without a repo checkout
docker build -t fk-encore-overpass-pbf:latest - <<'EOF'
FROM wiktorn/overpass-api:latest
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmctools \
  && rm -rf /var/lib/apt/lists/*
EOF
```

The image is ~350 MB (upstream + osmctools), build takes ~30 s.
Subsequent rebuilds use Docker's layer cache.

A follow-up slice will auto-build this image at first use via
dockerode, so this manual step disappears. Until then, the importer
will fail with "no such image" for sub-regional Geofabrik extracts
if the image isn't pre-built — the auto-pull path can't help because
this image is not on any registry.

## Disk-space budget

Rule of thumb the importer enforces before doing any work:

```
free_disk_mb ≥ pbf_size_mb × 10
```

Postgres footprint per region is typically 5–10× the raw PBF size; with
the safety factor of 10 we never trip mid-import. Rows that fail the
pre-check land in status `blocked_disk` and the admin UI surfaces the
shortfall.

Quick reference (from real Geofabrik extracts as of 2024):

| Region | PBF (~MB) | Combined nominatim+overpass volumes (~MB) |
|---|---|---|
| Hamburg | 80 | 700 |
| Bayern | 600 | 5 500 |
| Germany | 4 200 | 38 000 |
| Austria | 800 | 7 000 |
| France | 4 800 | 42 000 |

## Auto-approve threshold

```
POI_REGION_AUTO_IMPORT_MAX_PBF_MB=1500
```

Regions whose probed PBF size is below this go straight to `importing`;
larger regions land in `pending_approval` and require an admin click.
The default (1.5 GB) covers most Bundesländer / regional extracts but
keeps full-country imports behind manual approval.

## Healthchecks and the import tick

A full Nominatim import takes 30 min – 3 h depending on region size. The
importer does **not** wait for that in a single call. Instead:

1. Every 30 s the local-cron tick picks the oldest `importing` row
   that's outside the cooldown.
2. `ensureRunning` is called for the two containers — idempotent, so
   a no-op once they're up.
3. A single-shot health probe runs against
   - Nominatim: `http://nominatim-<slug>:8080/status`
   - Overpass: `http://overpass-<slug>/api/status`
4. If both pass → `ready_running`. Otherwise the row stays `importing`
   and the next tick (≥ 30 s later) re-probes.

For a cold-start of a stopped region (router's `ensureReady`) the
budget is `60 attempts × 1 s = 60 s` because the data is already
imported; only Postgres needs to spin up.

## Region delete cleanup (current state)

`DELETE /osm/regions/:slug` currently only removes the DB row. The
follow-up cleanup slice extends it to stop+remove the two containers
and drop the two named volumes. Until then, deleting a region leaves
its containers and volumes behind — they have to be cleaned up manually
with `docker rm` + `docker volume rm`.

## Idle-stop sweeper (future slice)

A sweeper in `osm-admin` will stop region containers after 30 min of
inactivity (`POI_REGION_IDLE_STOP_MINUTES=30`) and start them on
demand. Cold-start a stopped Nominatim container takes ~5–15 s — fine
for the background POI worker, fast enough that the round-trip is
invisible for an on-demand admin lookup.

This isn't wired up yet; until it is, `ready_running` containers stay
up indefinitely.
