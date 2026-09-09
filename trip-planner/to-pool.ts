/**
 * Putting a planned spot back in the pool (§8.4, §5).
 *
 * "Spot wischen → ersetzen oder **in den Vorrat zurück**" is one of the
 * two gestures §8.4 names, and it was the one with no way to perform
 * it: spots could go from the pool onto a day (`POST …/pool/place`) and
 * out of the pool for good (`POST …/pool/drop`), but a spot already on
 * a day could only be marked done, skipped, moved to another block —
 * or hidden, which is a different sentence entirely.
 *
 * The difference from hiding is the whole point (§5.1):
 *
 *   - **Back in the pool** means "not this afternoon". It stays in the
 *     running, comes back with a boost so it returns before an equally
 *     scored newcomer, and the planner may put it on tomorrow.
 *   - **Hidden** means "not this trip". The planner stops proposing it.
 *
 * What it does not do is re-plan the day around the gap. The traveller
 * took one spot out; filling the hole with something else in the same
 * gesture is redistribution, and §5 has that as a thing you ask for.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { recomputeDay } from "./move";
import { loadPlan, saveRedistribution, type StoredPlan } from "./plan-store";
import { DISPLACEMENT_BOOST } from "./redistribute";
import type { Candidate } from "./solver";

export interface ReturnToPoolRequest {
  planId: number;
  /** The stop being taken off the day, by row id. */
  stopId: number;
}

export interface ReturnToPoolResponse {
  plan: StoredPlan;
  /** What went back, for the sentence the screen shows. */
  name: string | null;
}

export const returnStopToPool = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/stops/to-pool", auth: true },
  async (req: ReturnToPoolRequest): Promise<ReturnToPoolResponse> => {
    const userId = requireUser();
    if (!Number.isInteger(req.stopId)) {
      throw APIError.invalidArgument("stopId must be a stop's row id");
    }

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const found = locate(plan, req.stopId);
    if (!found) throw APIError.notFound("stop not found in this plan");
    const { leg, day, stop } = found;

    if (stop.status !== "planned") {
      // A stop that is done or skipped is the beginning of the travel
      // diary (§5), not scheduling material. Moving it back into the
      // pool would quietly rewrite where the group has been.
      throw APIError.failedPrecondition(
        "dieser Spot ist schon abgehakt — was gewesen ist, bleibt im Tag stehen",
      );
    }

    const blocks = day.blocks.map((block) => ({
      ...block,
      stops: block.stops.filter((s) => s.rowId !== req.stopId).map((s) => ({ ...s })),
    }));
    // The walk either side of the gap has changed, so the day is
    // rewalked before it is written — a block that still counted the
    // old detour would be over budget for a spot nobody visits (§8.4).
    recomputeDay(blocks, leg.anchor, leg.mode);

    const returning: Candidate = {
      osmRef: stop.osmRef,
      name: stop.name,
      localName: stop.localName ?? null,
      wikipediaUrl: stop.wikipediaUrl ?? null,
      facadeAzimuth: stop.facadeAzimuth ?? null,
      kind: stop.kind ?? null,
      photoStop: stop.photoStop ?? false,
      origin: stop.origin ?? "search",
      lat: stop.lat,
      lon: stop.lon,
      category: stop.category,
      dwellMinutes: stop.dwellMinutes,
      // The same boost a displaced spot gets (§5): it was wanted enough
      // to be planned once, so it comes back ahead of an equally scored
      // newcomer rather than competing from scratch.
      score: stop.score + DISPLACEMENT_BOOST,
    };
    const pool = leg.pool.some((c) => c.osmRef === stop.osmRef)
      ? [...leg.pool]
      : [...leg.pool, returning];

    await saveRedistribution(plan.id, leg.id, day, blocks, pool);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while returning a spot to the pool");
    return { plan: updated, name: stop.name };
  },
);

function locate(plan: StoredPlan, stopId: number) {
  for (const leg of plan.legs) {
    for (const day of leg.days) {
      for (const block of day.blocks) {
        const stop = block.stops.find((s) => s.rowId === stopId);
        if (stop) return { leg, day, stop };
      }
    }
  }
  return null;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
