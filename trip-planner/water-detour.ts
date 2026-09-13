/**
 * Asking whether a lake is in the way (§4.5, §14).
 *
 * The seam between the geo service, which knows where the water is, and
 * `travel.ts`, which knows what to do about it. Nothing here decides
 * anything: it fetches, hands the answer to `detourAroundWater`, and
 * turns a failure into "no detour".
 *
 * **Failure is the old behaviour, not an error.** Geo being unreachable
 * means the estimate is the straight-line one it always was — wrong
 * across a lake, but wrong in the way the planner has always been.
 * Refusing to plan a trip because a lake could not be measured would
 * trade a bad estimate for no trip at all.
 *
 * Asked **once per day trip**, not per hop. The spots of one day are
 * normally on one side of whatever is in the way, and the query that
 * matters is the one the day is built on: the drive from the quarters
 * to where the day happens. A probe per hop would multiply a hundred
 * queries into a planning run to correct estimates that are almost
 * always already right.
 */

import log from "encore.dev/log";
import { getGeoClient } from "../osm-admin/geo-client";
import { detourAroundWater, type Coordinate, type WaterDetour } from "./travel";

export const NO_DETOUR: WaterDetour = { extraM: 0, around: null };

export async function waterDetourBetween(
  regionDb: string | null | undefined,
  from: Coordinate,
  to: Coordinate,
): Promise<WaterDetour> {
  if (!regionDb) return NO_DETOUR;
  try {
    const crossing = await getGeoClient().waterCrossing(regionDb, from, to);
    return detourAroundWater(crossing);
  } catch (err) {
    // Logged rather than swallowed: the estimate silently reverting to
    // the straight line is exactly the kind of quiet wrongness this
    // whole thing exists to end, and somebody reading the logs should
    // be able to see it happen.
    log.warn("water crossing lookup failed, estimating without it", {
      regionDb,
      error: (err as Error).message,
    });
    return NO_DETOUR;
  }
}
