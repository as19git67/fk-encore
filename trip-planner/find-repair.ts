/**
 * Finds that took a neighbour's OpenStreetMap entry, put right.
 *
 * Until the add-find lookup learnt to keep the entry a list row showed
 * (`pickMatch`), a find whose own entry the nearby search did not bring
 * back — or whose name differed by an accent — took the nearest entry
 * instead. The row kept the name the person added under, and gained the
 * neighbour's reference, category and hours: "Beispielkirche" stood on
 * the day as a café. The spot picker then showed the café as planned,
 * the place itself as not, and the day held a spot under a name the
 * picker never offered.
 *
 * The repair asks the region again around each find somebody added
 * (`origin = 'manual'`). It changes a row only on proof: the stored
 * entry is there and carries another name in every language, and an
 * entry within the same few metres carries exactly the row's name. Then
 * the row takes that entry's reference, category and hours, and a fixed
 * time pointing at the old reference follows. A row whose name no entry
 * carries stays as it is — a German name for a place OSM names only in
 * Catalan is not evidence of a wrong match.
 *
 * Every plan is looked at once (`constraints.findsRepaired`); finds
 * added since are matched right at the source.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import {
  tripPlanBlocks,
  tripPlanDays,
  tripPlanFixpoints,
  tripPlanLegs,
  tripPlanPool,
  tripPlanStops,
  tripPlans,
} from "../db/schema";
import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { isManualRef } from "./finds";

/** How far around a find the region is asked: the add-find lookup's own reach. */
export const REPAIR_RADIUS_M = 80;

/** Plans looked at per tick: the region is asked once per find. */
const PLANS_PER_TICK = 10;

type NamedSpot = Pick<GeoPoiSearchSpot, "osmRef" | "name" | "nameDe" | "nameEn">;

/** Case, accents and spacing aside: "Beispielkírche" is "beispielkirche". */
export function foldName(name: string | null | undefined): string | null {
  if (!name) return null;
  const folded = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("de")
    .replace(/\s+/g, " ")
    .trim();
  return folded.length > 0 ? folded : null;
}

/** True when one of the entry's names, in any language, is this one. */
export function carriesName(spot: NamedSpot, name: string | null | undefined): boolean {
  const wanted = foldName(name);
  if (!wanted) return false;
  return [spot.name, spot.nameDe, spot.nameEn].some((n) => foldName(n) === wanted);
}

/**
 * The entry a find should have had, or null to leave it alone.
 *
 * `taken` are the references the leg already holds elsewhere: a find
 * that would become a second copy of a place stays as it is.
 */
export function rightfulEntry<T extends NamedSpot>(
  find: { osmRef: string; name: string | null },
  nearby: readonly T[],
  taken: ReadonlySet<string>,
): T | null {
  if (isManualRef(find.osmRef) || !foldName(find.name)) return null;
  const stored = nearby.find((s) => s.osmRef === find.osmRef);
  if (!stored || carriesName(stored, find.name)) return null;
  const named = nearby.find((s) => s.osmRef !== find.osmRef && carriesName(s, find.name));
  if (!named || taken.has(named.osmRef)) return null;
  return named;
}

interface FindRow {
  table: "pool" | "stop";
  id: number;
  legId: number;
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
}

export interface RepairedFind {
  legId: number;
  name: string | null;
  from: string;
  to: string;
}

/**
 * Put right every mismatched find of one plan. Throws when the region
 * cannot be asked, so the plan is tried again on a later tick.
 */
export async function repairPlanFinds(planId: number): Promise<RepairedFind[]> {
  const legs = await db
    .select({ id: tripPlanLegs.id, regionDb: tripPlanLegs.region_db })
    .from(tripPlanLegs)
    .where(eq(tripPlanLegs.plan_id, planId));
  const repaired: RepairedFind[] = [];

  for (const leg of legs) {
    const pool = await db
      .select({
        id: tripPlanPool.id, osmRef: tripPlanPool.osm_ref, name: tripPlanPool.name,
        lat: tripPlanPool.lat, lon: tripPlanPool.lon, origin: tripPlanPool.origin, extent: tripPlanPool.extent,
      })
      .from(tripPlanPool)
      .where(eq(tripPlanPool.leg_id, leg.id));
    const stops = await db
      .select({
        id: tripPlanStops.id, osmRef: tripPlanStops.osm_ref, name: tripPlanStops.name,
        lat: tripPlanStops.lat, lon: tripPlanStops.lon, origin: tripPlanStops.origin, extent: tripPlanStops.extent,
      })
      .from(tripPlanStops)
      .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
      .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
      .where(eq(tripPlanDays.leg_id, leg.id));

    const taken = new Set([...pool, ...stops].map((r) => r.osmRef));
    const finds: FindRow[] = [
      ...pool.map((r) => ({ ...r, table: "pool" as const, legId: leg.id })),
      ...stops.map((r) => ({ ...r, table: "stop" as const, legId: leg.id })),
    ].filter((r) => r.origin === "manual" && !r.extent && !isManualRef(r.osmRef));

    for (const find of finds) {
      const page = await getGeoClient().searchPois(leg.regionDb, {
        center: { lat: find.lat, lon: find.lon, radiusM: REPAIR_RADIUS_M },
        limit: 20,
      });
      const entry = rightfulEntry(find, page.spots, taken);
      if (!entry) continue;
      await repoint(find, entry);
      taken.delete(find.osmRef);
      taken.add(entry.osmRef);
      repaired.push({ legId: leg.id, name: find.name, from: find.osmRef, to: entry.osmRef });
    }
  }
  return repaired;
}

async function repoint(find: FindRow, entry: GeoPoiSearchSpot): Promise<void> {
  const facts = {
    osm_ref: entry.osmRef,
    opening_hours: entry.openingHours,
    kind: entry.kind,
    facade_azimuth: entry.facadeAzimuth,
    // The neighbour's article is not this place's; the next read finds its own.
    wikipedia_url: null,
    ...(entry.categories[0] ? { category: entry.categories[0] } : {}),
  };
  await db.transaction(async (tx) => {
    if (find.table === "pool") {
      await tx.update(tripPlanPool).set({ ...facts, unmatched: false }).where(eq(tripPlanPool.id, find.id));
    } else {
      await tx.update(tripPlanStops).set(facts).where(eq(tripPlanStops.id, find.id));
    }
    // A fixed time held by the old reference holds the place itself.
    const dayIds = tx
      .select({ id: tripPlanDays.id })
      .from(tripPlanDays)
      .where(eq(tripPlanDays.leg_id, find.legId));
    await tx
      .update(tripPlanFixpoints)
      .set({ spot_ref: entry.osmRef })
      .where(and(inArray(tripPlanFixpoints.day_id, dayIds), eq(tripPlanFixpoints.spot_ref, find.osmRef)));
  });
}

/** Tries for a plan whose region cannot be asked, before it is left alone. */
const MAX_ATTEMPTS = 5;

/**
 * The plans not looked at yet: no marker, or a count of failed tries
 * below the limit. `true` marks a plan done.
 */
async function plansToRepair(limit: number): Promise<number[]> {
  const marker = sql`${tripPlans.constraints} -> 'findsRepaired'`;
  const rows = await db
    .select({ id: tripPlans.id })
    .from(tripPlans)
    .where(or(
      isNull(marker),
      sql`(jsonb_typeof(${marker}) = 'number' AND (${marker})::int < ${MAX_ATTEMPTS})`,
    ))
    .orderBy(sql`coalesce((${marker})::text, '0')`, tripPlans.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

async function mark(planId: number, value: true | "failed"): Promise<void> {
  const marker = value === true
    ? sql`'true'::jsonb`
    : sql`to_jsonb(coalesce((${tripPlans.constraints} ->> 'findsRepaired')::int, 0) + 1)`;
  await db
    .update(tripPlans)
    .set({ constraints: sql`${tripPlans.constraints} || jsonb_build_object('findsRepaired', ${marker})` })
    .where(eq(tripPlans.id, planId));
}

/** The cron: a few plans per tick, each once. A plan whose region is down is tried again later. */
export async function tickFindRepair(limit: number = PLANS_PER_TICK): Promise<number> {
  let repaired = 0;
  for (const planId of await plansToRepair(limit)) {
    try {
      const fixed = await repairPlanFinds(planId);
      for (const f of fixed) log.info("trip find re-matched", { planId, legId: f.legId, from: f.from, to: f.to });
      repaired += fixed.length;
      await mark(planId, true);
    } catch (err) {
      log.warn("trip find repair failed", { planId, error: String(err) });
      await mark(planId, "failed");
    }
  }
  return repaired;
}
