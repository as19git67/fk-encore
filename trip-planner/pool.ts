/**
 * The pool, as something you can act on (§5, §9.2).
 *
 * It has been data since the planner's first day and, until now, a list
 * you could only look at. That was defensible while nothing led into
 * it; with four ways in (§9.2) it stopped being defensible, because a
 * pile that only grows is not a pool, it is a backlog.
 *
 * Two verbs, and the split between them is the point:
 *
 *   - **Placing** a candidate is the traveller overruling the solver.
 *     The solver picks what fits a budget; a person picks what they
 *     want, and §8.4 is explicit that the app shows the consequence
 *     rather than preventing the gesture — the block goes red, nothing
 *     is refused.
 *   - **Dropping** one is saying "not this". No tombstone, no hidden
 *     list of banished spots: a re-plan may well find that museum
 *     again, because the leg really does still contain it, and a list
 *     nobody can see or undo would be worse than the honest repeat.
 *
 * Both are open to everybody on the trip. §6.2 reserves three rights to
 * the organiser and this is none of them — "Spots beitragen, bewerten,
 * Alternativen vorschlagen … darf jeder".
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { insertStop, MoveError } from "./move";
import {
  findInPool,
  loadPlan,
  removeFromPool,
  saveMovedDays,
  type StoredPlan,
} from "./plan-store";

export interface PlaceFromPoolRequest {
  planId: number;
  /** Which leg. A placement never crosses legs — see `moveTripStop`. */
  legIndex?: number;
  /** Which day of that leg, counted from zero within the leg. */
  dayIndex: number;
  /** Which block of that day. */
  blockId: string;
  /** The candidate, by its OSM reference — its handle in the pool. */
  osmRef: string;
  /** Where in the block, from zero. Past the end, or omitted, means last. */
  position?: number;
}

export interface PlaceFromPoolResponse {
  plan: StoredPlan;
  /**
   * Blocks now over their budget — the ones the app turns red (§8.4).
   * Reported, never refused.
   */
  overfullBlockIds: string[];
}

export const placeFromPool = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/pool/place", auth: true },
  async (req: PlaceFromPoolRequest): Promise<PlaceFromPoolResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);
    if (!day.detailed) {
      // A day at trip resolution has a frame and no stops (§4.3).
      // Dropping one in would half-plan it behind the traveller's back.
      throw APIError.failedPrecondition(
        "dieser Tag ist noch nicht ausgeplant — erst planen, dann Spots hineinsetzen",
      );
    }

    const candidate = await findInPool(leg.id, req.osmRef);
    if (!candidate) throw APIError.notFound("dieser Spot liegt nicht im Vorrat dieser Etappe");

    let placed;
    try {
      placed = insertStop({
        blocks: day.blocks,
        stop: {
          osmRef: candidate.osmRef,
          name: candidate.name,
          // The readable name and the one on the sign travel together
          // (§10.4), and so does the article: a placement must not be
          // the moment a spot loses what is known about it.
          localName: candidate.localName ?? null,
          wikipediaUrl: candidate.wikipediaUrl ?? null,
          lat: candidate.lat,
          lon: candidate.lon,
          category: candidate.category,
          dwellMinutes: candidate.dwellMinutes,
          // The score travels with the stop: a later redistribution
          // ranks what is on the day against what is in the pool, and a
          // stop with no score would be the first thing it dropped.
          score: candidate.score,
          // Travel is recomputed for the whole day the moment it lands,
          // so what goes in here is a placeholder, not an estimate.
          travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" },
          status: "planned",
          // Placed by hand, so it stays put: a redistribution that
          // moved it away would undo the one decision a person made
          // deliberately here (§5, §8.4).
          pinned: true,
          // §9.2: "Herkunft und Link bleiben erhalten". The pool row is
          // deleted a few lines further down, so if these did not come
          // with it, acting on a find would be the moment its reason
          // disappeared (migration 0167).
          note: candidate.note,
          sourceUrl: candidate.sourceUrl,
        },
        toBlockId: req.blockId,
        toPosition: req.position,
        anchor: leg.anchor,
        mode: leg.mode,
      });
    } catch (err) {
      if (err instanceof MoveError) throw APIError.invalidArgument(err.message);
      throw err;
    }

    await saveMovedDays(plan.id, [{ day, blocks: placed.blocks }]);
    // Out of the pool only once it is safely in a day: the pool is
    // where it lives until then, and losing it between the two writes
    // would lose it altogether.
    await removeFromPool(leg.id, req.osmRef);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while placing a spot");
    return { plan: updated, overfullBlockIds: placed.overfullBlockIds };
  },
);

export interface DropFromPoolRequest {
  planId: number;
  legIndex?: number;
  osmRef: string;
}

export interface DropFromPoolResponse {
  plan: StoredPlan;
  dropped: boolean;
}

export const dropFromPool = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/pool/drop", auth: true },
  async (req: DropFromPoolRequest): Promise<DropFromPoolResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const dropped = await removeFromPool(leg.id, req.osmRef);
    if (!dropped) throw APIError.notFound("dieser Spot liegt nicht im Vorrat dieser Etappe");

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while dropping a spot");
    return { plan: updated, dropped: true };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
