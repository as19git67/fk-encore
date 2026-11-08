/**
 * Saying how much an idea matters (ideas plan, stage 3).
 *
 * One endpoint for the idea wherever it is: still on the list (the pool
 * row) or already on a day (the stop). The same place is never both,
 * because placing it moves the row; the change follows the place.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanBlocks, tripPlanDays, tripPlanPool, tripPlanStops } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { loadPlan, type StoredPlan } from "./plan-store";
import { isPriority, priorityOf, rescored, type IdeaPriority } from "./priority";

export interface SetIdeaPriorityRequest {
  planId: number;
  legIndex: number;
  osmRef: string;
  priority: IdeaPriority;
}

export interface SetIdeaPriorityResponse {
  plan: StoredPlan;
}

export const setIdeaPriority = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/ideas/priority", auth: true },
  async (req: SetIdeaPriorityRequest): Promise<SetIdeaPriorityResponse> => {
    const userId = requireUser();
    if (!isPriority(req.priority)) throw APIError.invalidArgument("priority must be must, want or maybe");
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);

    let changed = 0;
    const [row] = await db
      .select({ id: tripPlanPool.id, score: tripPlanPool.score, priority: tripPlanPool.priority })
      .from(tripPlanPool)
      .where(and(eq(tripPlanPool.leg_id, leg.id), eq(tripPlanPool.osm_ref, req.osmRef)));
    if (row) {
      await db.update(tripPlanPool)
        .set({ priority: req.priority, score: rescored(row.score, priorityOf(row.priority), req.priority) })
        .where(eq(tripPlanPool.id, row.id));
      changed += 1;
    }

    const dayIds = leg.days.map((d) => d.id);
    if (dayIds.length > 0) {
      const stops = await db
        .select({ id: tripPlanStops.id })
        .from(tripPlanStops)
        .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
        .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
        .where(and(inArray(tripPlanDays.id, dayIds), eq(tripPlanStops.osm_ref, req.osmRef)));
      for (const stop of stops) {
        await db.update(tripPlanStops)
          .set({ priority: req.priority })
          .where(eq(tripPlanStops.id, stop.id));
        changed += 1;
      }
    }
    if (changed === 0) throw APIError.notFound("diese Idee gibt es in diesem Aufenthalt nicht");

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while setting a priority");
    return { plan: updated };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
