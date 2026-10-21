/**
 * Removing OSM regions nobody uses any more.
 *
 * A region is the biggest thing on the disk this app owns: its PostGIS
 * database in `geo_db_data`, its extract in `geo_data/pbf`, and its
 * share of the Valhalla tiles in `routing_data`. All three hang off the
 * region row. Removing the row (`remove` in region.service.ts) drops the
 * database; the geo service then clears the extract nobody owns
 * (geo/src/pbf-cache.ts), and the routing container sees the set of
 * extracts change and rebuilds its tiles without it
 * (routing/entrypoint.sh). So one sweep here frees all three.
 *
 * "Unused" is `last_used_at`, written by every region lookup
 * (`pickRegion`, `regionsIntersecting`): reverse geocoding a photo, POI
 * detection, every trip-planner search and route. Before that the
 * column was only diagnostic; migration 0265 starts the count afresh.
 * A row without it counts from its import, then from its creation.
 *
 * Two things are kept regardless of the date:
 *
 *   - a region a trip still needs: a leg whose `region_db` it is and
 *     whose start date lies ahead or no more than `TRIP_GRACE_DAYS`
 *     back, or an undated leg of a plan edited within the period. A
 *     trip booked a year ahead has its maps ready when it starts.
 *   - a region in `importing` or `pending_approval`: nothing to free
 *     yet, and an import in flight is not to be pulled from under
 *     itself.
 *
 * What goes is logged and kept on the settings row (`last_removed`), so
 * the admin page can say which regions went and why a trip somewhere
 * new now asks for its region again.
 */

import log from "encore.dev/log";
import { and, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import dbDefault from "../db/database";
import {
  osmRegionImports,
  osmRegionRetentionSettings,
  tripPlanLegs,
  tripPlans,
} from "../db/schema";
import type { GeoClient } from "./geo-client";
import { remove } from "./region.service";

/** Days are counted from midnight UTC; a day either way does not matter here. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest period that can be set — anything less would race the planner. */
export const MIN_IDLE_DAYS = 7;
export const DEFAULT_IDLE_DAYS = 180;

/** A trip that began this many days ago may still be under way. */
export const TRIP_GRACE_DAYS = 60;

/** Statuses whose database exists and may be removed. */
const REMOVABLE_STATUSES = ["ready_running", "ready_stopped", "failed"];

export interface RetentionSettings {
  enabled: boolean;
  idleDays: number;
  lastRunAt: string | null;
  lastRemoved: string[];
}

export interface RetentionDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  now?: () => Date;
}

export interface RegionUseRow {
  slug: string;
  postgresDb: string;
  status: string;
  lastUsedAt: string | null;
  importedAt: string | null;
  createdAt: string;
}

export interface RegionRetentionState {
  slug: string;
  /** What the period is counted from. */
  idleSince: string;
  /** When the sweep may remove it; null while a trip keeps it. */
  removeAfter: string | null;
  /** A trip still needs it. */
  keptForTrip: boolean;
  /** The sweep would remove it now. */
  due: boolean;
}

/**
 * The verdict on each removable region. Pure: rows, the databases trips
 * still need, the period and the time in, the decision out.
 */
export function retentionStates(input: {
  rows: readonly RegionUseRow[];
  tripDatabases: ReadonlySet<string>;
  idleDays: number;
  now: Date;
}): RegionRetentionState[] {
  const periodMs = input.idleDays * DAY_MS;
  return input.rows
    .filter((r) => REMOVABLE_STATUSES.includes(r.status))
    .map((r) => {
      const idleSince = r.lastUsedAt ?? r.importedAt ?? r.createdAt;
      const keptForTrip = input.tripDatabases.has(r.postgresDb);
      const removeAt = new Date(Date.parse(idleSince) + periodMs);
      return {
        slug: r.slug,
        idleSince: new Date(Date.parse(idleSince)).toISOString(),
        removeAfter: keptForTrip ? null : removeAt.toISOString(),
        keptForTrip,
        due: !keptForTrip && removeAt.getTime() <= input.now.getTime(),
      };
    })
    .sort((a, b) => a.idleSince.localeCompare(b.idleSince));
}

/** The region databases a trip still needs (see the header). */
export async function tripRegionDatabases(
  idleDays: number,
  deps: RetentionDeps = {},
): Promise<Set<string>> {
  const db = deps.db ?? dbDefault;
  const now = (deps.now ?? (() => new Date()))();
  const graceDate = new Date(now.getTime() - TRIP_GRACE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const editedSince = new Date(now.getTime() - idleDays * DAY_MS).toISOString();
  const rows = await db
    .selectDistinct({ regionDb: tripPlanLegs.region_db })
    .from(tripPlanLegs)
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(
      or(
        and(isNotNull(tripPlanLegs.start_date), gte(tripPlanLegs.start_date, graceDate)),
        and(isNull(tripPlanLegs.start_date), gte(tripPlans.updated_at, editedSince)),
      ),
    );
  return new Set(rows.map((r) => r.regionDb));
}

export async function loadRetentionSettings(deps: RetentionDeps = {}): Promise<RetentionSettings> {
  const db = deps.db ?? dbDefault;
  const [row] = await db
    .select()
    .from(osmRegionRetentionSettings)
    .where(eq(osmRegionRetentionSettings.id, 1))
    .limit(1);
  if (!row) {
    return { enabled: true, idleDays: DEFAULT_IDLE_DAYS, lastRunAt: null, lastRemoved: [] };
  }
  return {
    enabled: row.enabled,
    idleDays: row.idle_days,
    lastRunAt: row.last_run_at,
    lastRemoved: row.last_removed ?? [],
  };
}

export async function saveRetentionSettings(
  input: { enabled: boolean; idleDays: number },
  deps: RetentionDeps = {},
): Promise<RetentionSettings> {
  const db = deps.db ?? dbDefault;
  if (!Number.isInteger(input.idleDays) || input.idleDays < MIN_IDLE_DAYS) {
    throw new RangeError(`idleDays must be a whole number of at least ${MIN_IDLE_DAYS}`);
  }
  const updatedAt = (deps.now ?? (() => new Date()))().toISOString();
  await db
    .insert(osmRegionRetentionSettings)
    .values({ id: 1, enabled: input.enabled, idle_days: input.idleDays, updated_at: updatedAt })
    .onConflictDoUpdate({
      target: osmRegionRetentionSettings.id,
      set: { enabled: input.enabled, idle_days: input.idleDays, updated_at: updatedAt },
    });
  return loadRetentionSettings(deps);
}

/** Every removable region with its verdict under the current settings. */
export async function regionRetention(
  deps: RetentionDeps = {},
): Promise<{ settings: RetentionSettings; regions: RegionRetentionState[] }> {
  const db = deps.db ?? dbDefault;
  const now = (deps.now ?? (() => new Date()))();
  const settings = await loadRetentionSettings(deps);
  const rows = await db
    .select({
      slug: osmRegionImports.slug,
      postgresDb: osmRegionImports.postgres_db,
      status: osmRegionImports.status,
      lastUsedAt: osmRegionImports.last_used_at,
      importedAt: osmRegionImports.imported_at,
      createdAt: osmRegionImports.created_at,
    })
    .from(osmRegionImports)
    .where(inArray(osmRegionImports.status, REMOVABLE_STATUSES));
  const tripDatabases = await tripRegionDatabases(settings.idleDays, { ...deps, now: () => now });
  return {
    settings,
    regions: retentionStates({ rows, tripDatabases, idleDays: settings.idleDays, now }),
  };
}

export interface RetentionPassResult {
  ran: boolean;
  removed: string[];
  failed: { slug: string; reason: string }[];
}

/**
 * One sweep: remove every region whose period ran out. Does nothing
 * while the sweep is switched off. A region that cannot be removed is
 * reported and tried again next time; it does not stop the others.
 */
export async function runRetentionPass(deps: RetentionDeps = {}): Promise<RetentionPassResult> {
  const db = deps.db ?? dbDefault;
  const now = (deps.now ?? (() => new Date()))();
  const { settings, regions } = await regionRetention({ ...deps, now: () => now });
  if (!settings.enabled) return { ran: false, removed: [], failed: [] };

  const removed: string[] = [];
  const failed: { slug: string; reason: string }[] = [];
  for (const region of regions.filter((r) => r.due)) {
    try {
      // Read again right before: a lookup since the list was made has
      // moved the date, and that use wins.
      const [row] = await db
        .select({ lastUsedAt: osmRegionImports.last_used_at, status: osmRegionImports.status })
        .from(osmRegionImports)
        .where(eq(osmRegionImports.slug, region.slug))
        .limit(1);
      if (!row || !REMOVABLE_STATUSES.includes(row.status)) continue;
      if (row.lastUsedAt && Date.parse(row.lastUsedAt) > Date.parse(region.idleSince)) continue;

      if (await remove(region.slug, { db, geo: deps.geo })) {
        removed.push(region.slug);
        log.info("removed idle OSM region", {
          slug: region.slug,
          idleSince: region.idleSince,
          idleDays: settings.idleDays,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ slug: region.slug, reason });
      log.warn("could not remove idle OSM region", { slug: region.slug, reason });
    }
  }

  await db
    .insert(osmRegionRetentionSettings)
    .values({ id: 1, last_run_at: now.toISOString(), last_removed: removed })
    .onConflictDoUpdate({
      target: osmRegionRetentionSettings.id,
      // A sweep that removed nothing keeps the last list: it is the
      // answer to "where did my region go", however long ago.
      set: removed.length > 0
        ? { last_run_at: now.toISOString(), last_removed: removed }
        : { last_run_at: now.toISOString() },
    });

  return { ran: true, removed, failed };
}
