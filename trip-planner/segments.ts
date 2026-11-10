/**
 * A mode picked for one segment of a day (reise-planen-und-unterwegs.md,
 * stage 6): from a spot, or the start of the day, to the next spot.
 *
 * Read by the plan store, so the day times use the segment's minutes,
 * and written by `ways.ts`. A choice holds only while its two ends stand
 * next to each other: after a reorder it simply no longer matches a
 * segment, and comes back into force if the order does.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { tripPlanSegments } from "../db/schema";
import type { TransportMode } from "./travel";

type Db = typeof dbDefault;

/** The modes a way can be done in; ship and plane are journeys, not ways. */
export const WAY_MODES: readonly TransportMode[] = ["foot", "bike", "transit", "car"];
/** Where the day sets off from, as a segment's `fromRef`. */
export const DAY_START = "start";

export interface SegmentChoice {
  mode: TransportMode;
  minutes: number;
  distanceM: number;
}

export function segmentKey(fromRef: string, toRef: string): string {
  return `${fromRef}>${toRef}`;
}

/** The segment modes picked on a trip, by `segmentKey`. */
export async function loadSegmentChoices(planId: number, db: Db = dbDefault): Promise<Map<string, SegmentChoice>> {
  const rows = await db.select().from(tripPlanSegments).where(eq(tripPlanSegments.plan_id, planId));
  const out = new Map<string, SegmentChoice>();
  for (const row of rows) {
    if (!(WAY_MODES as readonly string[]).includes(row.mode)) continue;
    out.set(segmentKey(row.from_ref, row.to_ref), {
      mode: row.mode as TransportMode,
      minutes: row.minutes,
      distanceM: row.distance_m,
    });
  }
  return out;
}
