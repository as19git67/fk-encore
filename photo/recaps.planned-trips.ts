/**
 * What the planner knows about a trip the recap is guessing at (§8.7).
 *
 * A trip recap is built from photographs: a cluster of GPS-tagged
 * photos far from home becomes "Reise", and its title is derived — a
 * city name, a date range, at best a sentence from a language model.
 * That is the right method when nothing else is known.
 *
 * But something else often *is* known. A trip planned in this app has a
 * name somebody chose, dates somebody set and legs somebody named. When
 * the photos of a cluster fall inside such a trip, that trip is the
 * better answer to "what is this?" — and it costs one query, not a new
 * pipeline.
 *
 * Deliberately narrow: the plan supplies the **title, subtitle and a
 * back-reference**, nothing else. It does not decide which photos
 * belong to the recap, because the photos decide that themselves and
 * they are the honest evidence of where somebody actually was — a plan
 * is a statement of intent, and §8.7 is precisely about the difference.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import db from "../db/database";
import { tripPlanDays, tripPlanLegs, tripPlans } from "../db/schema";

export interface PlannedTrip {
  planId: number;
  title: string | null;
  /** Names of the legs, in order — "Tokio", "Kyoto", "Osaka". */
  legTitles: string[];
  /** First and last day of the trip, inclusive. */
  start: Date;
  end: Date;
}

/** Every dated trip this user owns, oldest first. */
export async function loadPlannedTrips(userId: number): Promise<PlannedTrip[]> {
  // The number of days is the count of day rows, not a column on the
  // leg: a leg's length is whatever was planned for it, and a leg that
  // was shortened afterwards has fewer rows rather than a stale number.
  const rows = await db
    .select({
      planId: tripPlans.id,
      title: tripPlans.title,
      legTitle: tripPlanLegs.title,
      position: tripPlanLegs.position,
      startDate: tripPlanLegs.start_date,
      dayCount: sql<number>`count(${tripPlanDays.id})::int`,
    })
    .from(tripPlans)
    .innerJoin(tripPlanLegs, eq(tripPlanLegs.plan_id, tripPlans.id))
    .leftJoin(tripPlanDays, eq(tripPlanDays.leg_id, tripPlanLegs.id))
    .where(and(eq(tripPlans.owner_id, userId), isNotNull(tripPlanLegs.start_date)))
    .groupBy(
      tripPlans.id,
      tripPlans.title,
      tripPlanLegs.id,
      tripPlanLegs.title,
      tripPlanLegs.position,
      tripPlanLegs.start_date,
    );

  const byPlan = new Map<number, {
    title: string | null;
    legs: { position: number; title: string | null; start: Date; end: Date }[];
  }>();

  for (const row of rows) {
    if (!row.startDate) continue;
    const start = parseDay(row.startDate);
    if (!start) continue;
    // A leg of n days ends on its (n-1)th day, and a leg with no days
    // still occupies the one it starts on.
    const end = new Date(start.getTime() + Math.max(0, (row.dayCount || 1) - 1) * 86_400_000);

    const entry = byPlan.get(row.planId) ?? { title: row.title, legs: [] };
    entry.legs.push({ position: row.position, title: row.legTitle, start, end });
    byPlan.set(row.planId, entry);
  }

  const trips: PlannedTrip[] = [];
  for (const [planId, entry] of byPlan) {
    const legs = [...entry.legs].sort((a, b) => a.position - b.position);
    trips.push({
      planId,
      title: entry.title,
      legTitles: legs.map((leg) => leg.title).filter((t): t is string => !!t && t.length > 0),
      start: legs.reduce((min, leg) => (leg.start < min ? leg.start : min), legs[0].start),
      end: legs.reduce((max, leg) => (leg.end > max ? leg.end : max), legs[0].end),
    });
  }
  return trips.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The planned trip a photo cluster belongs to, or null.
 *
 * "Belongs to" is generous on purpose — a day either side. People
 * photograph the drive there and the morning after they get back, and a
 * recap that stops at the plan's first and last day would leave those
 * out of the trip they obviously belong to.
 */
export function tripFor(
  cluster: { start: Date; end: Date },
  trips: readonly PlannedTrip[],
  graceDays = 1,
): PlannedTrip | null {
  const grace = graceDays * 86_400_000;
  const overlapping = trips.filter(
    (trip) =>
      cluster.start.getTime() <= trip.end.getTime() + grace &&
      cluster.end.getTime() >= trip.start.getTime() - grace,
  );
  if (overlapping.length === 0) return null;
  // Two plans over the same days is somebody's duplicate; the longer
  // one is the one with more of the trip in it.
  return overlapping.sort(
    (a, b) => (b.end.getTime() - b.start.getTime()) - (a.end.getTime() - a.start.getTime()),
  )[0];
}

/**
 * What to call a recap that has a plan behind it.
 *
 * The trip's own name wins — somebody typed it for exactly this. With
 * no name, the legs are the next best thing, because "Tokio · Kyoto ·
 * Osaka" says more than "Reise nach Tokio". Null means the plan has
 * nothing to add, and the photo-derived title stays.
 */
export function plannedTitle(trip: PlannedTrip): string | null {
  if (trip.title && trip.title.trim().length > 0) return trip.title.trim();
  if (trip.legTitles.length === 0) return null;
  if (trip.legTitles.length <= 3) return trip.legTitles.join(" · ");
  return `${trip.legTitles.slice(0, 3).join(" · ")} +${trip.legTitles.length - 3}`;
}

function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}
