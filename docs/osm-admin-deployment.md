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
OSM_ADMIN_NAME_PREFIX=             # optional, see "Sharing a host with another deployment" below
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

## Sharing a host with another deployment

Container and volume names are global on the host's Docker daemon. If
two fk-encore deployments share the same host (typical: a `:test`
instance alongside `:latest`), each must scope its OSM resources or
they'd collide on a `name already in use` error and could even drop
each other's data when "Entfernen" is clicked on either side.

Solution: pick a distinct `OSM_ADMIN_NAME_PREFIX` per deployment.

```yaml
services:
  # Production: keep the historical (empty) prefix so existing
  # `fk-encore-osm-…` volumes stay intact across the upgrade.
  app:
    environment:
      OSM_ADMIN_DOCKER_NETWORK: osm-net
      # OSM_ADMIN_NAME_PREFIX: ""    # default; explicit for clarity

  # Test: scope all OSM resources with `test-`.
  app-test:
    environment:
      OSM_ADMIN_DOCKER_NETWORK: test-osm-net
      OSM_ADMIN_NAME_PREFIX: "test-"
```

Resulting names with `OSM_ADMIN_NAME_PREFIX="test-"`:

| Slug `europe/germany/bayern` | Container | Volume |
|---|---|---|
| Nominatim | `test-nominatim-europe-germany-bayern` | `test-fk-encore-osm-nominatim-europe-germany-bayern` |
| Overpass | `test-overpass-europe-germany-bayern` | `test-fk-encore-osm-overpass-europe-germany-bayern` |

The Docker network is **not** auto-prefixed — it's a separate env
(`OSM_ADMIN_DOCKER_NETWORK`). Pick a distinct value per deployment and
declare each network with `name: …` in its compose file so Compose
doesn't add its own project prefix on top:

```yaml
networks:
  test-osm-net:
    name: test-osm-net   # don't let compose prefix it
    driver: bridge
```

Switching prefixes on an existing deployment renames the resources
the importer expects but doesn't migrate the actual containers or
volumes. Plan the change with the legacy "Entfernen" cleanup or
re-import the affected regions.

### Bringing the stack down cleanly

Because the per-region Nominatim/Overpass containers are spawned by
osm-admin at runtime (via dockerode), they are not part of
`docker-compose.yml`. A plain `docker compose down` leaves them
running and then fails to remove the OSM bridge network with:

```
Network test-osm-net  Resource is still in use
```

Run the helper first, passing the same prefix that's in your env-file
(empty for prod, `test-` for the test stack), then bring the rest
down:

```bash
./scripts/host/osm-down.sh test-          # stop + remove test region containers
docker compose --env-file .env.test down  # now this succeeds
```

The helper is idempotent and a no-op if no matching region containers
exist. Use `--dry-run` to preview the targets without touching them.

## Tuning env variables passed to the containers

The importer reads the following from its own environment when it
constructs container descriptors:

| Env | Meaning | Default |
|---|---|---|
| `NOMINATIM_PASSWORD` | Internal Postgres password inside the per-region nominatim container. Any value works; it never leaves the container. | `changeme` |
| `NOMINATIM_IMAGE` | Override the nominatim image tag (test-pinning, fork). | `mediagis/nominatim:5.0` |
| `OVERPASS_IMAGE` | Override the overpass image tag. | `wiktorn/overpass-api:latest` |
| `NOMINATIM_IMPORT_STYLE` | Nominatim import profile (`full`, `address`, `street`, `admin`). `address` is plenty for POI detection and ~30 % faster than `full`. | `address` |
| `OSM_ADMIN_DISK_PROBE_PATH` | Path the importer probes via `statfs` for the disk pre-check. Default `/` reflects the app container's overlay (close enough for typical hosts). For an exact reading of the docker data root, bind-mount it read-only and point this env at the mount. | `/` |

## How Overpass ingests Geofabrik PBFs

The upstream `wiktorn/overpass-api` entrypoint downloads the planet
to `/db/planet.osm.bz2` (filename hardcoded regardless of actual
format) and then `eval`s `$OVERPASS_PLANET_PREPROCESS` standalone —
no stdin redirect, no file arg. The downstream `init_osm3s.sh` then
reads `/db/planet.osm.bz2` expecting bz2-compressed OSM XML.

Geofabrik publishes `.osm.bz2` only for top-level regions
(countries, Bundesländer). Sub-regional extracts (Regierungsbezirke
etc.) are PBF-only. To support both, the importer sets a preprocess
that converts the file in place using the `osmium-tool` binary
already bundled in the upstream image (the entrypoint itself calls
`osmium fileinfo …` on the same file):

```bash
mv /db/planet.osm.bz2 /db/planet.input.pbf \
  && osmium cat -O -f osm.bz2 -o /db/planet.osm.bz2 /db/planet.input.pbf \
  && rm /db/planet.input.pbf
```

After the preprocess, the file at `/db/planet.osm.bz2` is genuine
bz2 OSM XML and the rest of the entrypoint proceeds unchanged. No
custom image needed.

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
