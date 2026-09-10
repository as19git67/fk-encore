/**
 * Getting a place's horizon profile, computing it when nobody has (§7.3).
 *
 * Its own module for the reason `climate-precautions.ts` is one: the
 * light endpoints need the profile and would otherwise each grow their
 * own copy of the "cached? then compute, but not for too long" dance.
 *
 * Three rules, and each is about not asking:
 *
 *   - **Once per place, forever.** The ground does not move. A profile
 *     has no expiry; the only reason to recompute is a better sampler,
 *     and that is a migration, not a timeout.
 *   - **A hundred-metre grid.** Two spots on the same square see the
 *     same ridge. Rounding is also what keeps this table from being
 *     about people rather than places.
 *   - **Never at the cost of the answer.** A light window without
 *     terrain is what the planner has always shown; a light window that
 *     arrives ten seconds late is not shown at all. The lookup gets a
 *     budget, and a miss simply means a free horizon this time.
 */

import log from "encore.dev/log";
import { and, eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { horizonProfiles } from "../db/schema";
import { getElevationClient } from "./elevation-client";
import {
  profileFrom,
  samplePoints,
  type Coordinate,
  type HorizonPoint,
} from "./horizon";

type Db = typeof dbDefault;

/**
 * The grid a place is snapped to, in degrees.
 *
 * 0.001° is about 110 m north-south — roughly the height model's own
 * pixel, so a finer grid would store two rows that sampled the same
 * ground.
 */
export const PLACE_GRID_DEGREES = 0.001;

/**
 * How long a light answer may wait for terrain.
 *
 * Deliberately short: several hundred sampled points is one or two
 * requests, and if they have not come back by then the honest thing is
 * a free horizon rather than a spinner.
 */
const HORIZON_BUDGET_MS = 3_000;

export function roundToPlace(value: number): number {
  return Math.round(value / PLACE_GRID_DEGREES) * PLACE_GRID_DEGREES;
}

function key(at: Coordinate): Coordinate {
  return { lat: roundToPlace(at.lat), lon: roundToPlace(at.lon) };
}

/** The stored profile for this place, or null when there is none yet. */
export async function readHorizon(
  at: Coordinate,
  db: Db = dbDefault,
): Promise<HorizonPoint[] | null> {
  const place = key(at);
  const [row] = await db
    .select()
    .from(horizonProfiles)
    .where(and(
      eq(horizonProfiles.lat, place.lat),
      eq(horizonProfiles.lon, place.lon),
    ))
    .limit(1);
  return row ? ((row.profile ?? []) as HorizonPoint[]) : null;
}

/**
 * Compute the profile for this place and store it.
 *
 * The spot's own height comes from the same fan: the first request
 * carries the place itself as its first point, so the height everything
 * is measured against is read from the same model as the ridge it is
 * compared with. Mixing two models here would produce a systematic
 * offset and a horizon that is wrong by a constant.
 */
export async function computeHorizon(
  at: Coordinate,
  db: Db = dbDefault,
): Promise<HorizonPoint[]> {
  const place = key(at);
  const samples = samplePoints(place);
  const heights = await getElevationClient()
    .elevations([place, ...samples.map((sample) => sample.coordinate)]);

  const [spotElevation, ...sampleElevations] = heights;
  if (spotElevation === null || spotElevation === undefined) {
    throw new Error("the height model does not know this place");
  }

  const profile = profileFrom(spotElevation, samples, sampleElevations);
  await db
    .insert(horizonProfiles)
    .values({
      lat: place.lat,
      lon: place.lon,
      elevation_m: spotElevation,
      profile,
    })
    .onConflictDoUpdate({
      target: [horizonProfiles.lat, horizonProfiles.lon],
      set: { elevation_m: spotElevation, profile, computed_at: new Date().toISOString() },
    });
  return profile;
}

/**
 * The profile for this place: stored, freshly computed, or none.
 *
 * Never throws. Every caller is asking so that a light window can be
 * cut a little more honestly, and none of them is willing to fail over
 * it — §7.3's window was computed without terrain for months and was
 * still worth showing.
 */
export async function horizonFor(at: Coordinate, db: Db = dbDefault): Promise<HorizonPoint[]> {
  try {
    const stored = await readHorizon(at, db);
    if (stored !== null) return stored;
    return await withBudget(computeHorizon(at, db));
  } catch (err) {
    // Note that a *timeout* is not a wasted trip: the computation runs
    // on and stores its row, so the next reader of this place finds it
    // waiting. Only this one answer goes without terrain.
    log.info("horizon unavailable, assuming a free horizon", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * The stored profile, or a free horizon — but never a computation.
 *
 * For the planner. Ordering a block by the light (§7.3, way 1) is worth
 * a lookup and not worth a wait: the height model is a third party, and
 * a family adjusting the pace of their trip must not sit through a
 * fetch so that two stops can swap places. The profile arrives by the
 * other door — the day screen asks for the light, `horizonFor` computes
 * it once, and every plan after that has it.
 */
export async function storedHorizon(at: Coordinate, db: Db = dbDefault): Promise<HorizonPoint[]> {
  try {
    return (await readHorizon(at, db)) ?? [];
  } catch (err) {
    log.info("horizon lookup failed, assuming a free horizon", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function withBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`horizon took longer than ${HORIZON_BUDGET_MS} ms`)),
          HORIZON_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
