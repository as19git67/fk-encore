/**
 * Region importer — single-tick worker that drives `importing` rows to
 * either `ready_running` (success), `blocked_disk` (preflight failure),
 * or `failed` (anything else).
 *
 * Sequence per tick:
 *
 *   1. Pick the oldest `importing` row whose last touch is older than
 *      a small cooldown (avoids the same row being retried in a tight
 *      loop). At most one row per tick — keeps Postgres + Docker load
 *      predictable.
 *   2. HEAD-probe the PBF URL to learn the size; persist on the row.
 *   3. Disk pre-check: refuse if free space < `pbfSize × 10` (Nominatim
 *      Postgres typically expands 5–10× the input). On refusal the row
 *      goes to `blocked_disk`.
 *   4. Run the one-shot import container via the docker driver.
 *   5. Bring up the persistent `nominatim-<slug>` and `overpass-<slug>`
 *      containers; mark ready when both report running.
 *
 * Steps 4/5 currently delegate to the `InMemoryDockerDriver`, so the
 * state machine runs end-to-end without a real Docker engine. The real
 * dockerode driver lands in a follow-up slice and slots in via
 * `setDockerDriver`.
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
  /** Resulting status (or "noop" when no row was picked). */
  result: RegionStatus | "noop";
  /** Optional human-readable detail, e.g. the disk shortfall. */
  detail?: string;
}

/**
 * Process at most one importing row. Safe to call on a timer.
 *
 * Returns an outcome describing what happened so callers (admin UI,
 * tests) can show progress.
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

  // Pick the oldest importing row whose last update is older than the
  // cooldown. `updated_at` doubles as a poor man's lease — the row is
  // touched at each transition so a stuck tick can't be re-picked
  // within the cooldown window.
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
    // Step 1: probe size + persist.
    const sizeMb = await probe(row.geofabrik_url);
    if (sizeMb !== null) {
      await db
        .update(osmRegionImports)
        .set({ pbf_size_mb: sizeMb, updated_at: now().toISOString() })
        .where(eq(osmRegionImports.slug, slug));
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

    // Step 3: one-shot import container.
    const importDesc: ContainerDescriptor = {
      name: `nominatim-import-${slugSafe}`,
      image: nominatimImage,
      env: {
        PBF_URL: row.geofabrik_url,
        NOMINATIM_PASSWORD: process.env.NOMINATIM_PASSWORD ?? "changeme",
        // Nominatim picks up the target DB via DSN injected by the
        // real driver. For the in-memory driver these are ignored.
        POSTGRES_DB: row.postgres_db,
      },
    };
    const exit = await driver.runOneShot(importDesc);
    if (exit !== 0) {
      const detail = `import container exit=${exit}`;
      await transition(db, slug, "importing", "failed", detail, now);
      return { slug, result: "failed", detail };
    }

    // Step 4: persistent containers.
    await driver.ensureRunning({
      name: `nominatim-${slugSafe}`,
      image: nominatimImage,
      env: { POSTGRES_DB: row.postgres_db },
      healthcheckUrl: `http://nominatim-${slugSafe}:8080/status`,
    });
    await driver.ensureRunning({
      name: `overpass-${slugSafe}`,
      image: overpassImage,
      env: { OVERPASS_META: "yes" },
      healthcheckUrl: `http://overpass-${slugSafe}/api/status`,
    });

    // Step 5: mark ready + record completion time.
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

