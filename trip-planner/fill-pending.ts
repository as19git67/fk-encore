/**
 * Filling in a trip once its maps arrive (§4.3, §15.3).
 *
 * A trip planned for a place with no imported OpenStreetMap region is
 * saved rather than refused: the days get their frame — blocks with
 * budgets, fixpoints — and no spots, and the import is asked for. That
 * half worked. The other half did not: nothing ever filled those days
 * in. The import finished hours later, the region went `ready_running`,
 * and the trip sat there empty until somebody found
 * `POST …/plans/:planId/plan` by hand.
 *
 * So this is the missing half, and it is deliberately **in
 * trip-planner rather than in the importer**. The importer's job is to
 * get a region ready; knowing which trips were waiting for it is the
 * planner's business, and a cross-service call in the other direction
 * would make the import's success depend on the planner being up.
 *
 * The trigger is a timer rather than an event for the same reason it is
 * a cheap one: a multi-hour import does not care about a quarter of an
 * hour, and a worker that owns its own schedule cannot be broken by a
 * notification that was never sent.
 *
 * What it will not do is touch a trip somebody has begun, or one whose
 * other legs are still waiting — the same two rules the manual endpoint
 * keeps, for the same reasons.
 */

import log from "encore.dev/log";
import { pickRegion } from "../osm-admin/region-router";
import { legsAwaitingRegion, loadPlan, planOwner } from "./plan-store";
import { fillPendingPlan } from "./plans";

export interface FillOutcome {
  planId: number;
  result: "filled" | "still-waiting" | "begun" | "gone" | "failed";
  detail?: string;
}

/**
 * One pass: every trip with a leg still waiting for its region.
 *
 * Answers what it did per plan rather than a count, so the log line
 * after an import says which trip came alive — that is the sentence
 * somebody reads when they wonder whether the wait is over.
 */
export async function fillWaitingPlans(): Promise<FillOutcome[]> {
  const waiting = await legsAwaitingRegion();
  if (waiting.length === 0) return [];

  const planIds = [...new Set(waiting.map((leg) => leg.planId))];
  const outcomes: FillOutcome[] = [];
  for (const planId of planIds) {
    try {
      outcomes.push(await fillOne(planId));
    } catch (err) {
      // One trip whose region search failed must not stop the rest:
      // the next tick tries again, and the flag is still set.
      outcomes.push({ planId, result: "failed", detail: (err as Error).message });
    }
  }
  return outcomes;
}

async function fillOne(planId: number): Promise<FillOutcome> {
  const ownerId = await planOwner(planId);
  if (ownerId === null) return { planId, result: "gone" };
  const plan = await loadPlan(planId, ownerId);
  if (!plan) return { planId, result: "gone" };

  // Every leg, not only the waiting ones: re-planning rewrites the
  // whole trip, so a trip whose second city is still missing would
  // come back with the second city empty again — and the first one
  // needlessly re-planned.
  for (const leg of plan.legs) {
    if (!(await pickRegion(leg.anchor.lat, leg.anchor.lon))) {
      return { planId, result: "still-waiting" };
    }
  }

  const settled = firstSettledStop(plan);
  if (settled) {
    // Somebody is travelling on the frame. Re-planning would rewrite a
    // day that already happened; the flag stays set and says so.
    return { planId, result: "begun", detail: settled };
  }

  await fillPendingPlan(plan, ownerId);
  return { planId, result: "filled" };
}

function firstSettledStop(plan: Awaited<ReturnType<typeof loadPlan>>): string | null {
  if (!plan) return null;
  for (const leg of plan.legs) {
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) {
          if (stop.status !== "planned") return stop.name ?? stop.osmRef;
        }
      }
    }
  }
  return null;
}

/** The tick the scheduler calls. Logs only when something happened. */
export async function tickFillPending(): Promise<FillOutcome[]> {
  const outcomes = await fillWaitingPlans();
  for (const outcome of outcomes) {
    if (outcome.result === "still-waiting") continue;
    log.info("[trip-planner] pending trip", {
      planId: outcome.planId,
      result: outcome.result,
      detail: outcome.detail,
    });
  }
  return outcomes;
}
