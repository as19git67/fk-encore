/**
 * Saying what kind of place an idea is, after the fact.
 *
 * The kind comes from the map, or from a guess when a shared link
 * brought a place the map does not know. Either can be wrong: a café
 * that is really a museum shop, a "Sehenswürdigkeit" that is a park.
 * The kind decides the symbol, the list it shows in and whether rain
 * matters, so the people planning can set it.
 *
 * One endpoint for the idea wherever it is, like the priority
 * (`idea-priority.ts`): on the list (the pool row) or on a day (the
 * stop). The stay length stays as it is — it may have been set by hand,
 * and it is edited on its own.
 *
 * A route is not offered either way: its kind belongs to its course
 * (§4.7), not to a label somebody picks.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanBlocks, tripPlanDays, tripPlanPool, tripPlanStops } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { DEFAULT_DWELL_MINUTES } from "./candidates";
import { loadPlan, type StoredPlan } from "./plan-store";

/** The kinds a person may pick: every kind the planner knows a stay length for. */
export const PICKABLE_CATEGORIES: ReadonlySet<string> = new Set(Object.keys(DEFAULT_DWELL_MINUTES));

const ROUTE = "route";

export interface SetIdeaCategoryRequest {
  planId: number;
  legIndex: number;
  osmRef: string;
  category: string;
}

export interface SetIdeaCategoryResponse {
  plan: StoredPlan;
}

export const setIdeaCategory = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/ideas/category", auth: true },
  async (req: SetIdeaCategoryRequest): Promise<SetIdeaCategoryResponse> => {
    const userId = requireUser();
    if (!PICKABLE_CATEGORIES.has(req.category)) {
      throw APIError.invalidArgument(`category must be one of ${[...PICKABLE_CATEGORIES].join(", ")}`);
    }
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);

    const poolRows = await db
      .select({ id: tripPlanPool.id, category: tripPlanPool.category })
      .from(tripPlanPool)
      .where(and(eq(tripPlanPool.leg_id, leg.id), eq(tripPlanPool.osm_ref, req.osmRef)));

    const dayIds = leg.days.map((d) => d.id);
    const stopRows = dayIds.length === 0 ? [] : await db
      .select({ id: tripPlanStops.id, category: tripPlanStops.category })
      .from(tripPlanStops)
      .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
      .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
      .where(and(inArray(tripPlanDays.id, dayIds), eq(tripPlanStops.osm_ref, req.osmRef)));

    if (poolRows.length === 0 && stopRows.length === 0) {
      throw APIError.notFound("diese Idee gibt es in diesem Aufenthalt nicht");
    }
    if ([...poolRows, ...stopRows].some((r) => r.category === ROUTE)) {
      throw APIError.failedPrecondition("eine Strecke bleibt eine Strecke");
    }

    for (const row of poolRows) {
      await db.update(tripPlanPool).set({ category: req.category }).where(eq(tripPlanPool.id, row.id));
    }
    for (const row of stopRows) {
      await db.update(tripPlanStops).set({ category: req.category }).where(eq(tripPlanStops.id, row.id));
    }

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while setting a category");
    return { plan: updated };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
