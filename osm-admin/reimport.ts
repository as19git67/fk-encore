/**
 * Importing a ready region again, because the style learned something.
 *
 * osm2pgsql applies its Flex style on `--create` only. It never
 * migrates an existing database. So when a table joins the style — as
 * `osm_routes` did with the trip planner's waymarked ways (§4.7) — the
 * regions already on disk do not have it, and no amount of replication
 * gives it to them: `osm2pgsql-replication update` is an *append* of
 * the changes since the last sequence against the schema that is
 * there. The ways were never imported, so there is nothing to append.
 *
 * The only way is a fresh `--create`, which means dropping the region's
 * database and importing it again.
 *
 * ## Found, not guessed
 *
 * Which regions need it is asked of the region itself: geo reports
 * which of the style's tables each database has, and a non-empty
 * `missing` is the answer. Deriving it from an import date would need
 * a second list of "when did which table join the style" that nothing
 * would keep in step.
 *
 * ## What this deliberately does not do
 *
 * - **It does not re-download.** The PBF stays cached in the geo
 *   volume, so a re-import reuses the extract that is there — which
 *   also means it reproduces that extract's age. Fetching a fresh one
 *   is a separate decision and a separate gigabyte, so it is the
 *   operator's, not this function's.
 * - **It does not touch a region that is not ready.** Something being
 *   imported, blocked on disk or failed has a state of its own, and
 *   dropping its database underneath the worker would be a race.
 * - **It does not decide for the operator.** Listing is a separate
 *   call from doing, because "this will drop four databases and
 *   re-import them over the next hour" is a sentence somebody should
 *   read before it happens.
 */

import { eq, inArray } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getGeoClient, type GeoClient } from "./geo-client";
import { assertTransition, isRegionStatus, type RegionStatus } from "./state-machine";

/** The statuses a region may be re-imported from. */
const REIMPORTABLE: readonly RegionStatus[] = ["ready_running", "ready_stopped"];

export interface OutdatedRegion {
  slug: string;
  postgresDb: string;
  status: string;
  /** Style tables this region lacks — why it is on the list. */
  missing: string[];
}

export interface OutdatedRegionsResult {
  /** Regions an older style built, newest question first. */
  outdated: OutdatedRegion[];
  /** How many ready regions were asked. */
  checked: number;
  /**
   * Regions that could not be asked, with the reason — a geo service
   * that is down, a database that is gone. Reported rather than
   * silently counted as current (§15.3): "we could not tell" and
   * "nothing missing" are different answers.
   */
  unknown: { slug: string; reason: string }[];
}

export interface ReimportDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  now?: () => Date;
}

/**
 * Which ready regions an older style built.
 *
 * Read-only: nothing is dropped, nothing changes status.
 */
export async function outdatedRegions(
  deps: ReimportDeps = {},
): Promise<OutdatedRegionsResult> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();

  const rows = await db
    .select({
      slug: osmRegionImports.slug,
      postgresDb: osmRegionImports.postgres_db,
      status: osmRegionImports.status,
    })
    .from(osmRegionImports)
    .where(inArray(osmRegionImports.status, [...REIMPORTABLE]));

  const outdated: OutdatedRegion[] = [];
  const unknown: { slug: string; reason: string }[] = [];

  for (const row of rows) {
    try {
      const tables = await geo.regionTables(row.postgresDb);
      if (tables.missing.length > 0) {
        outdated.push({
          slug: row.slug,
          postgresDb: row.postgresDb,
          status: row.status,
          missing: tables.missing,
        });
      }
    } catch (err) {
      unknown.push({ slug: row.slug, reason: (err as Error).message ?? String(err) });
    }
  }

  return { outdated, checked: rows.length, unknown };
}

export interface ReimportedRegion {
  slug: string;
  missing: string[];
  /** True when the old database was dropped and the row set to import. */
  started: boolean;
  /** Why not, when it did not start. */
  reason?: string;
}

export interface ReimportResult {
  started: ReimportedRegion[];
  /** Regions that were checked and are already current. */
  skipped: number;
  unknown: { slug: string; reason: string }[];
}

/**
 * Drop and re-import every ready region an older style built.
 *
 * Order matters and is the whole of the error handling: the database
 * is dropped **first**, then the row goes to `importing`. Dropping
 * frees the disk the pre-check is about to ask for, and a drop that
 * fails leaves the row untouched — so the region stays ready and
 * usable rather than sitting in `importing` with a database the
 * importer would then refuse to replace.
 *
 * The importer worker takes it from there: it sees `importing`, finds
 * that geo knows no import for that database any more, and starts a
 * fresh one.
 */
export async function reimportOutdated(deps: ReimportDeps = {}): Promise<ReimportResult> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();
  const now = deps.now ?? (() => new Date());

  const found = await outdatedRegions(deps);
  const started: ReimportedRegion[] = [];

  for (const region of found.outdated) {
    const status = region.status;
    if (!isRegionStatus(status)) {
      started.push({
        slug: region.slug,
        missing: region.missing,
        started: false,
        reason: `unrecognised status ${status}`,
      });
      continue;
    }

    try {
      // First the drop — see above: it frees the disk and it is the
      // step that may fail without leaving anything half-done.
      assertTransition(status, "importing");
      await geo.dropRegion(region.postgresDb);
      await db
        .update(osmRegionImports)
        .set({ status: "importing", updated_at: now().toISOString() })
        .where(eq(osmRegionImports.slug, region.slug));
      started.push({ slug: region.slug, missing: region.missing, started: true });
    } catch (err) {
      started.push({
        slug: region.slug,
        missing: region.missing,
        started: false,
        reason: (err as Error).message ?? String(err),
      });
    }
  }

  return {
    started,
    skipped: found.checked - found.outdated.length,
    unknown: found.unknown,
  };
}
