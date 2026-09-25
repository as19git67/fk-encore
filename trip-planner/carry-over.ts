/**
 * What a day left behind (§5).
 *
 * The concept's rule for a redistribution is that nothing is deleted:
 * what no longer fits goes back to the pool, with a priority for the
 * days that follow. That rule fired only when somebody pressed
 * "umplanen". A day nobody replanned — the family wandered through the
 * town without the plan, as families do — kept its stops as "planned"
 * on a day that was over, and the next days had been planned without
 * them. Out of the first trial: "the planned spots feel lost".
 *
 * This is the same rule, applied to a day that has passed: every stop
 * still planned on it returns to the leg's pool with the displacement
 * boost, so it comes first when the next day is detailed or replanned.
 * Done and skipped stay where they are — they are the diary.
 *
 * Offered, never done on its own (§7.1): the app asks the morning
 * after, and this only runs when somebody said yes.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { loadPlan, saveRedistribution, type StoredPlan } from "./plan-store";
import { DISPLACEMENT_BOOST, stopToCandidate, type CurrentBlock } from "./redistribute";
import type { Candidate } from "./solver";

export interface CarryOverResult {
  blocks: CurrentBlock[];
  pool: Candidate[];
  /** What went back, best first — the sentence to show. */
  carried: Candidate[];
}

/**
 * The day's planned stops into the pool, boosted; the day keeps only
 * what is settled.
 *
 * Pinned stops go too: a pin holds a place in a block, and the block
 * is over. A stop the pool already knows is boosted rather than
 * doubled.
 */
export function carryOver(
  blocks: readonly CurrentBlock[],
  pool: readonly Candidate[],
): CarryOverResult {
  const carried: Candidate[] = [];
  const kept = blocks.map((block) => {
    const stops = block.stops.filter((stop) => {
      if (stop.status !== "planned") return true;
      carried.push(stopToCandidate(stop));
      return false;
    });
    return { ...block, stops, usedMinutes: 0 };
  });

  const byRef = new Map<string, Candidate>();
  for (const candidate of pool) byRef.set(candidate.osmRef, candidate);
  for (const candidate of carried) {
    const known = byRef.get(candidate.osmRef);
    const base = known && known.score > candidate.score ? known : candidate;
    byRef.set(candidate.osmRef, { ...base, score: base.score + DISPLACEMENT_BOOST });
  }
  const merged = [...byRef.values()].sort(byScoreThenRef);

  return {
    blocks: kept,
    pool: merged,
    carried: carried
      .map((c) => ({ ...c, score: c.score + DISPLACEMENT_BOOST }))
      .sort(byScoreThenRef),
  };
}

function byScoreThenRef(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.osmRef < b.osmRef ? -1 : a.osmRef > b.osmRef ? 1 : 0;
}

export interface CarryOverRequestBody {
  planId: number;
  /** Which leg. The first one by default (§4.2). */
  legIndex?: number;
  /** The day that is over, counted from zero within the leg. */
  dayIndex: number;
}

export interface CarryOverResponseBody {
  plan: StoredPlan;
  carried: { osmRef: string; name: string | null }[];
}

export const carryOverDay = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/days/carry-over",
    auth: true,
  },
  async (req: CarryOverRequestBody): Promise<CarryOverResponseBody> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("not logged in");
    requirePermission(auth, "photos.view");
    const userId = parseInt(auth.userID, 10);

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    const result = carryOver(day.blocks, leg.pool);
    if (result.carried.length > 0) {
      await saveRedistribution(plan.id, leg.id, day, result.blocks, result.pool);
    }

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while carrying over");
    return {
      plan: updated,
      carried: result.carried.map((c) => ({ osmRef: c.osmRef, name: c.name })),
    };
  },
);
