/**
 * Region importer — single-tick worker that drives `importing` rows to
 * either `ready_running` (when both per-region containers report healthy),
 * `blocked_disk` (preflight failure), or `failed` (anything else).
 *
 * Architecture: self-contained per-region containers. mediagis/nominatim
 * and wiktorn/overpass-api bundle their own data store, so each region
 * gets two long-running containers backed by named Docker volumes. The
 * containers run their own import on first start (empty volume + a
 * PBF_URL env var). We deliberately do not maintain a shared Postgres
 * for all regions — that would require patching the upstream images.
 *
 * Why ticks instead of a single long-running call: a full Nominatim
 * import takes 30 min – 3 h. We don't want to block a single HTTP
 * request for that long, and we want the tick to be safe to interrupt
 * (container restart). So each tick is short:
 *
 *   1. Pick the oldest `importing` row whose `updated_at` is older
 *      than `TICK_COOLDOWN_MS`.
 *   2. HEAD-probe PBF size if we don't have it yet, persist it.
 *   3. Disk pre-check (best effort): refuse if free < `pbfSize × 10`.
 *   4. ensureRunning both containers — idempotent, so subsequent ticks
 *      no-op on this step.
 *   5. waitHealthy with a single attempt. If both pass → ready_running.
 *      Otherwise bump `updated_at` (cooldown gate) and stay `importing`;
 *      the next tick re-probes.
 */

import { and, asc, eq, lt, or, isNull } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import {
  getDockerDriver,
  type ContainerDescriptor,
  type DockerDriver,
} from "./docker-driver";
import { probePbfSizeMb } from "./pbf-probe";
import { assertTransition, isRegionStatus, type RegionStatus } from "./state-machine";

/** Postgres footprint multiplier vs raw PBF size. Conservative side. */
const POSTGRES_EXPANSION_FACTOR = 10;
/** Minimum cooldown between consecutive ticks on the same row. */
const TICK_COOLDOWN_MS = 30_000;

export interface ImporterDeps {
  db?: typeof dbDefault;
  driver?: DockerDriver;
  /** Probe PBF size; override in tests to return a deterministic value. */
  probeSize?: (url: string) => Promise<number | null>;
  /** Free disk space in MB at the storage volume. Tests inject a value. */
  freeDiskMb?: () => Promise<number | null>;
  now?: () => Date;
  /** Container image tags. Defaults match the recommended self-host stack. */
  images?: {
    nominatim?: string;
    overpass?: string;
  };
}

export interface TickOutcome {
  /** Slug picked this tick, or null if nothing to do. */
  slug: string | null;
  /** Resulting status — "noop" when no row was picked, "waiting" when
   *  the containers are up but not yet healthy (row stays `importing`). */
  result: RegionStatus | "noop" | "waiting";
  /** Optional human-readable detail, e.g. the disk shortfall. */
  detail?: string;
}

/**
 * Process at most one importing row. Safe to call on a timer.
 */
export async function tickImporter(deps: ImporterDeps = {}): Promise<TickOutcome> {
  const db = deps.db ?? dbDefault;
  const driver = deps.driver ?? getDockerDriver();
  const probe = deps.probeSize ?? probePbfSizeMb;
  const freeDisk = deps.freeDiskMb ?? (async () => null);
  const now = deps.now ?? (() => new Date());
  const nominatimImage = deps.images?.nominatim ?? "mediagis/nominatim:5.0";
  const overpassImage = deps.images?.overpass ?? "wiktorn/overpass-api:latest";

  const cooldownCutoff = new Date(now().getTime() - TICK_COOLDOWN_MS).toISOString();

  const picked = await db
    .select()
    .from(osmRegionImports)
    .where(
      and(
        eq(osmRegionImports.status, "importing"),
        or(
          isNull(osmRegionImports.updated_at),
          lt(osmRegionImports.updated_at, cooldownCutoff),
        ),
      ),
    )
    .orderBy(asc(osmRegionImports.updated_at))
    .limit(1);
  const row = picked[0];
  if (!row) return { slug: null, result: "noop" };

  const slug = row.slug;
  const slugSafe = slugToContainerSuffix(slug);

  try {
    // Step 1: probe size (only if we don't already have one cached).
    let sizeMb = row.pbf_size_mb ?? null;
    if (sizeMb === null) {
      sizeMb = await probe(row.geofabrik_url);
      if (sizeMb !== null) {
        await db
          .update(osmRegionImports)
          .set({ pbf_size_mb: sizeMb, updated_at: now().toISOString() })
          .where(eq(osmRegionImports.slug, slug));
      }
    }

    // Step 2: disk pre-check (best effort — skipped when callers can't
    // measure free space).
    const free = await freeDisk();
    if (free !== null && sizeMb !== null) {
      const need = sizeMb * POSTGRES_EXPANSION_FACTOR;
      if (free < need) {
        const detail = `free=${free}MB need=${need}MB (sizeMb × ${POSTGRES_EXPANSION_FACTOR})`;
        await transition(db, slug, "importing", "blocked_disk", detail, now);
        return { slug, result: "blocked_disk", detail };
      }
    }

    // Step 3: persistent containers. Both are self-contained — the
    // image does its own import on first start with the PBF_URL env.
    // ensureRunning is idempotent: a no-op once the container is up.
    await driver.ensureRunning(nominatimDescriptor(slug, slugSafe, row.geofabrik_url, nominatimImage));
    await driver.ensureRunning(overpassDescriptor(slugSafe, row.geofabrik_url, overpassImage));

    // Step 4: probe health once. Long imports take many ticks; we don't
    // block on a giant timeout, we re-poll on the next tick.
    const nomHealthy = await driver.waitHealthy(
      `http://nominatim-${slugSafe}:8080/status`,
      { maxAttempts: 1 },
    );
    const ovHealthy = await driver.waitHealthy(
      `http://overpass-${slugSafe}/api/status`,
      { maxAttempts: 1 },
    );
    if (!nomHealthy || !ovHealthy) {
      // Stay in `importing`. Bump updated_at so the cooldown gates the
      // next tick (we don't want to probe more than once every 30 s).
      await db
        .update(osmRegionImports)
        .set({ updated_at: now().toISOString() })
        .where(eq(osmRegionImports.slug, slug));
      const detail = `nominatim_healthy=${nomHealthy} overpass_healthy=${ovHealthy}`;
      return { slug, result: "waiting", detail };
    }

    // Step 5: mark ready.
    await transition(db, slug, "importing", "ready_running", null, now, {
      imported_at: now().toISOString(),
      last_error: null,
    });
    return { slug, result: "ready_running" };
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    await transition(db, slug, "importing", "failed", detail, now);
    return { slug, result: "failed", detail };
  }
}

/**
 * Container descriptor for the long-running Nominatim instance. The
 * named volume holds the bundled Postgres data dir; on first start
 * with an empty volume the image's init script downloads the PBF and
 * imports it. On subsequent starts the existing DB is reused.
 */
export function nominatimDescriptor(
  slug: string,
  slugSafe: string,
  pbfUrl: string,
  image: string,
): ContainerDescriptor {
  return {
    name: `nominatim-${slugSafe}`,
    image,
    env: {
      PBF_URL: pbfUrl,
      NOMINATIM_PASSWORD: process.env.NOMINATIM_PASSWORD ?? "changeme",
      IMPORT_STYLE: process.env.NOMINATIM_IMPORT_STYLE ?? "address",
      // Replication URL used by the upcoming refresh endpoint; ignored
      // by the initial import. The mediagis image accepts it via env.
      REPLICATION_URL: replicationUrlFor(pbfUrl),
      REGION_SLUG: slug,
    },
    volumes: [
      // Named docker volume: docker auto-creates it on first run.
      // Path inside the container is the bundled pg16 data dir.
      {
        hostPath: `fk-encore-osm-nominatim-${slugSafe}`,
        containerPath: "/var/lib/postgresql/16/main",
      },
    ],
  };
}

/**
 * Container descriptor for the long-running Overpass instance. Same
 * import-on-empty-volume pattern as Nominatim.
 */
export function overpassDescriptor(
  slugSafe: string,
  pbfUrl: string,
  image: string,
): ContainerDescriptor {
  // wiktorn/overpass-api's bundled preprocess pipeline is hardcoded
  // for OSM XML compressed with bzip2; the image ships neither
  // osmconvert nor osmium so we can't expand a PBF on the fly. Geofabrik
  // publishes the equivalent `.osm.bz2` next to every `.osm.pbf` (~2–3×
  // larger but no preprocessing tooling needed) — point overpass at
  // that variant so the default `bunzip2 -cd` pipeline just works.
  const bz2Url = bz2UrlFor(pbfUrl);
  return {
    name: `overpass-${slugSafe}`,
    image,
    env: {
      OVERPASS_META: "yes",
      OVERPASS_MODE: "init",
      OVERPASS_PLANET_URL: bz2Url,
      OVERPASS_DIFF_URL: replicationUrlFor(pbfUrl),
    },
    volumes: [
      { hostPath: `fk-encore-osm-overpass-${slugSafe}`, containerPath: "/db" },
    ],
  };
}

/**
 * Sibling URL of a Geofabrik `.osm.pbf` — same path, `.osm.bz2`
 * extension. Used because Overpass-API's official image expects
 * OSM XML bz2 and lacks the tooling to convert a PBF.
 */
function bz2UrlFor(pbfUrl: string): string {
  return pbfUrl.replace(/-latest\.osm\.pbf$/, "-latest.osm.bz2");
}

/**
 * Turn `…/bayern-latest.osm.pbf` into `…/bayern-updates/`. Geofabrik
 * publishes minutely-diff streams under that path; the refresh worker
 * (next slice) consumes them.
 */
function replicationUrlFor(pbfUrl: string): string {
  return pbfUrl.replace(/-latest\.osm\.pbf$/, "-updates/");
}

async function transition(
  db: typeof dbDefault,
  slug: string,
  from: RegionStatus,
  to: RegionStatus,
  errorDetail: string | null,
  now: () => Date,
  extra: Partial<{ imported_at: string; last_error: string | null }> = {},
): Promise<void> {
  if (isRegionStatus(from) && isRegionStatus(to)) assertTransition(from, to);
  await db
    .update(osmRegionImports)
    .set({
      status: to,
      updated_at: now().toISOString(),
      last_error: errorDetail,
      ...extra,
    })
    .where(eq(osmRegionImports.slug, slug));
}

/**
 * Replace anything outside `[a-z0-9-]` with `-`. The container name
 * cannot contain `/` (Geofabrik slug) or unprintables.
 */
export function slugToContainerSuffix(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
