# `osm-admin` + `geo` — Deployment Notes

The `osm-admin` Encore service is the admin-facing API; the heavy
lifting (osm2pgsql, replication, reverse / POI queries) runs in a
separate container pair, `geo` + `geo-db`. This document captures the
deployment bits that the application code can't infer at runtime.

## Architecture in one paragraph

Each imported region (e.g. `europe/germany/bayern`) is realised as
**one PostgreSQL database** inside the `geo-db` container, named
`nom_<flattened-slug>`. The neighbouring `geo` container owns the
`osm2pgsql` and `osm2pgsql-replication` binaries plus a small Node
HTTP service. On `POST /import` the geo service downloads the
Geofabrik PBF, creates the database, imports it through a Lua-driven
Flex style that keeps only the three tables the runtime queries
(`osm_highways`, `osm_pois`, `osm_admin`), wires up replication, and
returns 202 immediately — the actual osm2pgsql work runs in the
background and the importer tick in `osm-admin` polls
`GET /imports/:postgresDb` for progress. Deleting a region =
`DELETE /regions/:postgresDb` against the geo service plus the DB-row
delete in `osm_region_imports`.

## Compose-side wiring

The `geo` + `geo-db` services are part of the main `docker-compose.yml`
and run as plain compose services — no special permissions, no Docker
socket mount. Operator-tunable knobs live under the `geo` service:

```yaml
services:
  geo-db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_PASSWORD: ${GEO_DB_PASSWORD:-postgres}
    volumes:
      - geo_db_data:/var/lib/postgresql/data

  geo:
    build: ./geo
    depends_on:
      geo-db: { condition: service_healthy }
    environment:
      GEO_DB_HOST: geo-db
      GEO_DB_PASSWORD: ${GEO_DB_PASSWORD:-postgres}
      GEO_SHARED_SECRET: ${GEO_SHARED_SECRET:-}
      GEO_OSM2PGSQL_CACHE_MB: ${GEO_OSM2PGSQL_CACHE_MB:-2000}
      GEO_OSM2PGSQL_PROCS: ${GEO_OSM2PGSQL_PROCS:-2}
    volumes:
      - geo_data:/data
```

The `app` container reaches the geo service via the compose default
network at `http://geo:8080` (overridable through `GEO_SERVICE_URL`).
The app no longer needs `/var/run/docker.sock` access; the `:568`
runtime user no longer needs to be in the host `docker` group; and
there is no longer a runtime-managed `osm-net` bridge network.

## Per-region database layout

The `osm_region_imports.postgres_db` column is the source of truth.
`osm-admin/region.service.ts::slugToPostgresDb` produces the name:

| Slug | `osm_region_imports.postgres_db` |
|---|---|
| `europe/germany/bayern` | `nom_europe_germany_bayern` |
| `europe/germany/bayern/oberbayern` | `nom_europe_germany_bayern_oberbayern` |
| `europe/austria` | `nom_europe_austria` |

Inside each DB the osm2pgsql Flex style (`geo/src/osm2pgsql.lua`)
creates three tables:

| Table | Use |
|---|---|
| `osm_highways` | Nearest-street lookup for the `road` / `house_number` parts of `/reverse`. |
| `osm_pois` | Radius candidates for `/pois`; also feeds the `tourism` / `amenity` / `building` parts of `/reverse`. |
| `osm_admin` | Containment lookup for the `country` / `state` / `city` parts of `/reverse`. |

Every table has a GIST index on `geom`; `osm_pois.tags` additionally
has a GIN index so the POI matcher's `tags ? 'historic'` predicate
plans well even on regions with millions of rows.

## Sharing a host with another deployment

When two fk-encore deployments share the same host (typical: a
`:test` instance alongside `:latest`), they need distinct container
names. The compose convention is:

```bash
# Production: empty suffix
COMPOSE_PROJECT_NAME=fk-encore
DEPLOY_NAME_SUFFIX=

# Test: scope every container + volume with `-test`
COMPOSE_PROJECT_NAME=fk-encore-test
DEPLOY_NAME_SUFFIX=-test
```

That gives `fk-encore-geo` / `fk-encore-geo-test`, each with its own
`geo_db_data` volume (compose namespaces volumes under
`COMPOSE_PROJECT_NAME`), so the two deployments stay fully
independent. No special OSM-side prefix is needed anymore — the old
`OSM_ADMIN_NAME_PREFIX` and `OSM_ADMIN_DOCKER_NETWORK` are gone.

## Tunable env variables

Read by the geo service unless noted:

| Env | Meaning | Default |
|---|---|---|
| `GEO_DB_HOST` / `GEO_DB_PORT` / `GEO_DB_USER` / `GEO_DB_PASSWORD` | Connection to `geo-db`. The container's default `postgres / postgres` is fine when the database isn't reachable from outside compose. | `geo-db` / `5432` / `postgres` / `postgres` |
| `GEO_DB_ADMIN_DB` | DB used for `CREATE DATABASE`. | `postgres` |
| `GEO_PORT` | HTTP listen port inside the container. | `8080` |
| `GEO_DATA_DIR` | Volume mount that holds the PBF cache (`pbf/`) and osm2pgsql flat-node files (`work/`). | `/data` |
| `GEO_SHARED_SECRET` | Optional bearer token enforced on every endpoint except `/health`. | _(empty)_ |
| `GEO_OSM2PGSQL_CACHE_MB` | `osm2pgsql --cache`. Raise to roughly the PBF size for fastest imports. | `2000` |
| `GEO_OSM2PGSQL_PROCS` | `osm2pgsql --number-processes`. | `2` |
| `GEO_REPLICATION_INTERVAL_MS` | Background replication-update loop interval (ms). | `3600000` (1 h) |
| `GEO_REPLICATION` | Set to `off` to disable the background replication loop entirely (e.g. during initial imports). | _(empty)_ |
| `OSM_ADMIN_DISK_PROBE_PATH` | _(osm-admin side)_ Path the importer probes via `statfs` for the disk pre-check. Point at the bind-mount that backs `geo_data` for accurate readings. | `/` |

## How a region is imported

A full Bayern-sized osm2pgsql import takes 10–30 min; the importer tick
in `osm-admin/encore.service.ts` polls instead of waiting:

1. Every 30 s the local-cron tick picks the oldest `importing` row
   that's outside the cooldown.
2. The tick calls `geo.getImportStatus(postgres_db)`. If nothing's
   known yet it posts `POST /import { slug, postgresDb, pbfUrl }` and
   stays `importing`. The geo service runs osm2pgsql in-process and
   updates its in-memory tracker.
3. Subsequent ticks see `state: "running"` and stay `importing`.
4. On `state: "ready"` the importer transitions the row to
   `ready_running`, persists `imported_at`, and backfills
   `poi_detection` jobs for every photo whose GPS falls in the region
   bbox.
5. On `state: "failed"` the row goes to `failed` with the geo
   service's error attached to `last_error`.

If the geo service restarts mid-flight, the in-memory tracker is
lost; the next status lookup falls back to
`reconcileImportStatus(postgresDb)` which checks whether the database
exists with all three runtime tables, in which case it's reported as
`ready` and no re-import happens.

## Region delete

`DELETE /osm/regions/:slug` in the admin UI:

1. Looks up `postgres_db` from `osm_region_imports`.
2. Calls `geo.dropRegion(postgresDb)` → the geo service terminates
   any open connections to the DB and runs `DROP DATABASE`.
3. Deletes the `osm_region_imports` row.

The geo-side drop is best-effort tolerated: if the geo service fails,
the DB row is still removed so the admin can clean up stuck entries
manually. Re-importing a previously-dropped region is idempotent.

## Disk-space budget

Rule of thumb the importer enforces before doing any work:

```
free_disk_mb ≥ pbf_size_mb × 10
```

The PostGIS footprint per region with the Flex style is typically
3–6× the raw PBF size; with the safety factor of 10 we never trip
mid-import. Rows that fail the pre-check land in status `blocked_disk`
and the admin UI surfaces the shortfall.

Rough reference (real osm2pgsql Flex imports of the three runtime
tables):

| Region | PBF (~MB) | geo-db footprint (~MB) |
|---|---|---|
| Hamburg | 80 | 250 |
| Bayern | 600 | 1 800 |
| Germany | 4 200 | 13 000 |
| Austria | 800 | 2 500 |
| France | 4 800 | 15 000 |

(Substantially smaller than the historical
nominatim+overpass-per-region setup, because the Flex style only keeps
the tables actually used by `/reverse` and `/pois`.)

## Auto-approve threshold

```
POI_REGION_AUTO_IMPORT_MAX_PBF_MB=1500
```

Regions whose probed PBF size is below this go straight to `importing`;
larger regions land in `pending_approval` and require an admin click.

## Replication

After a successful `osm2pgsql --create` the import path also runs
`osm2pgsql-replication init --server <region>-updates/` which records
the Geofabrik replication base URL in the database (table
`osm2pgsql_replication_status`).

From then on:

- A background loop inside the geo container (interval
  `GEO_REPLICATION_INTERVAL_MS`, default 1 h) iterates every `nom_*`
  database and runs `osm2pgsql-replication update`.
- The admin UI's "Refresh" button posts `POST /osm/regions/refresh`
  which calls the same code path via `POST /refresh { postgresDb }`.
- The new sequence number is persisted in
  `osm_region_imports.replication_seq`. `last_error` is cleared on
  success or set with the diagnostic on failure.

Both paths are idempotent: the in-database high-water mark dedupes
concurrent updates and re-runs.

## Status reference

| Status | Meaning |
|---|---|
| `pending_approval` | Region row exists but the admin hasn't clicked "Approve" yet. The importer ignores these. |
| `importing` | The importer tick is driving this row toward ready. May stay in this state for hours during a large import. |
| `ready_running` | The geo service has a complete PostGIS database for the region; reverse / POI lookups serve immediately. |
| `blocked_disk` | The disk pre-check failed. Free up space and the admin can re-approve. |
| `failed` | The geo service reported a failure (or the importer hit an unrecoverable error). `last_error` carries the detail. |
| `ready_stopped` | _Legacy._ Left over from the docker-driven era when individual region containers could be idle-stopped. `pickRegion` still treats it as serveable for backwards compatibility; nothing transitions into it anymore. |
