/**
 * Persistence for visits (§6.4).
 *
 * What the device sends is an event, never a track: "X was at Y between
 * these two times", with the signals that made it believe so. The
 * position stays on the phone (§7.1), and this table is a travel diary
 * rather than a location history.
 */

import { and, asc, eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { tripPlanVisits, tripPlans } from "../db/schema";
import type { VisitSignal } from "./visits";

type Db = typeof dbDefault;

export interface StoredVisit {
  id: number;
  userId: number;
  /** The planned stop this confirms, or null for an unplanned stay. */
  stopId: number | null;
  osmRef: string | null;
  name: string | null;
  lat: number;
  lon: number;
  arrivedAt: string;
  leftAt: string | null;
  sources: VisitSignal[];
  confirmed: boolean;
  dismissed: boolean;
}

export interface RecordVisitInput {
  planId: number;
  userId: number;
  stopId?: number | null;
  osmRef?: string | null;
  name?: string | null;
  lat: number;
  lon: number;
  arrivedAt: string;
  leftAt?: string | null;
  sources: readonly VisitSignal[];
  confirmed: boolean;
}

/**
 * Write a visit, or fold it into the one already there.
 *
 * A device re-syncs, a request is retried, a geofence fires twice — the
 * same stay arrives more than once, and the diary must not grow a
 * duplicate each time. The unique index is on person, place and
 * arrival; a second report of the same stay updates it, which is also
 * how a stay that later gains a second signal gets confirmed.
 */
export async function recordVisit(
  input: RecordVisitInput,
  db: Db = dbDefault,
): Promise<StoredVisit> {
  const [row] = await db
    .insert(tripPlanVisits)
    .values({
      plan_id: input.planId,
      user_id: input.userId,
      stop_id: input.stopId ?? null,
      osm_ref: input.osmRef ?? null,
      name: input.name ?? null,
      lat: input.lat,
      lon: input.lon,
      arrived_at: input.arrivedAt,
      left_at: input.leftAt ?? null,
      sources: [...input.sources],
      confirmed: input.confirmed,
    })
    .onConflictDoUpdate({
      target: [
        tripPlanVisits.plan_id,
        tripPlanVisits.user_id,
        tripPlanVisits.osm_ref,
        tripPlanVisits.arrived_at,
      ],
      set: {
        left_at: input.leftAt ?? null,
        sources: [...input.sources],
        confirmed: input.confirmed,
        stop_id: input.stopId ?? null,
      },
    })
    .returning();

  await touchPlan(input.planId, db);
  return toStoredVisit(row);
}

/** Every visit of a plan, oldest first — the diary in order. */
export async function listVisits(
  planId: number,
  ownerId: number,
  db: Db = dbDefault,
): Promise<StoredVisit[] | null> {
  const [plan] = await db
    .select({ id: tripPlans.id })
    .from(tripPlans)
    .where(and(eq(tripPlans.id, planId), eq(tripPlans.owner_id, ownerId)))
    .limit(1);
  if (!plan) return null;

  const rows = await db
    .select()
    .from(tripPlanVisits)
    .where(eq(tripPlanVisits.plan_id, planId))
    .orderBy(asc(tripPlanVisits.arrived_at));
  return rows.map(toStoredVisit);
}

/**
 * Answer a suggestion: yes, or no.
 *
 * "No" is remembered rather than deleted. A stay the traveller has
 * already dismissed would otherwise be re-detected on the next sync and
 * offered again, which is exactly the nagging §6.4 is trying to avoid.
 */
export async function answerVisit(
  planId: number,
  userId: number,
  visitId: number,
  confirmed: boolean,
  db: Db = dbDefault,
): Promise<StoredVisit | null> {
  const [row] = await db
    .update(tripPlanVisits)
    .set({ confirmed, dismissed: !confirmed })
    .where(
      and(
        eq(tripPlanVisits.id, visitId),
        eq(tripPlanVisits.plan_id, planId),
        // A visit is the person's own: nobody answers for someone else.
        eq(tripPlanVisits.user_id, userId),
      ),
    )
    .returning();
  if (!row) return null;

  await touchPlan(planId, db);
  return toStoredVisit(row);
}

async function touchPlan(planId: number, db: Db): Promise<void> {
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
}

function toStoredVisit(row: typeof tripPlanVisits.$inferSelect): StoredVisit {
  return {
    id: row.id,
    userId: row.user_id,
    stopId: row.stop_id,
    osmRef: row.osm_ref,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    arrivedAt: row.arrived_at,
    leftAt: row.left_at,
    sources: (row.sources ?? []) as VisitSignal[],
    confirmed: row.confirmed,
    dismissed: row.dismissed,
  };
}
