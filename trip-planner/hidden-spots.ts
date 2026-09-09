/**
 * "Not this one, and not next time either" (§5, §20.5).
 *
 * §5 is emphatic that a spot taken off a day goes back into the pool
 * rather than into the bin, and that rule is right for the case it was
 * written for: the afternoon is full, this one waits for tomorrow.
 * It is the wrong answer for the other case, which testing turned up —
 * the search proposes a place that is simply not wanted, and putting it
 * back in the pool means meeting it again on the next re-plan, and the
 * one after that.
 *
 * The row itself cannot be deleted: it belongs to the region database
 * and comes back from every search. So the **answer** is what gets
 * kept, exactly as §20.5 sketches for the idea pool — "remembers a
 * 'no' instead of deleting it".
 *
 * Three decisions worth stating:
 *
 *   - **Per trip, not per leg.** A place the family turned down in
 *     Lisbon is not wanted on the second Lisbon day either, and a trip
 *     is the unit people think in.
 *   - **Reversible, and visible.** A hidden spot is listed by name and
 *     comes back with one tap. A "no" you cannot take back is a
 *     deletion wearing a friendlier word.
 *   - **It applies to the planner, not to the map.** Searching for a
 *     place by name or looking at what is nearby still finds it: those
 *     answer "what is there", and hiding answers "what should be
 *     proposed".
 *
 * A find somebody brought in by hand needs none of this — it exists
 * because a person added it, so removing it from the pool removes it
 * for good (`POST …/pool/drop`).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { recomputeDay } from "./move";
import {
  hideSpot,
  listHiddenSpots,
  loadPlan,
  purgeSpot,
  saveRedistribution,
  unhideSpot,
  type HiddenSpot,
  type StoredPlan,
} from "./plan-store";

export interface HideSpotRequest {
  planId: number;
  /** The spot, by its OSM reference — its handle everywhere else too. */
  osmRef: string;
}

export interface HideSpotResponse {
  plan: StoredPlan;
  hidden: HiddenSpot[];
  /** True when the spot was on a day, not only in the pool. */
  wasPlanned: boolean;
}

export interface HiddenSpotsResponse {
  hidden: HiddenSpot[];
}

export const hideTripSpot = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/spots/hide", auth: true },
  async (req: HideSpotRequest): Promise<HideSpotResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const osmRef = req.osmRef.trim();
    if (!osmRef) throw APIError.invalidArgument("osmRef is required");

    const known = findSpot(plan, osmRef);
    if (!known) throw APIError.notFound("dieser Spot gehört nicht zu dieser Reise");
    if (known.manual) {
      // A find somebody brought in themselves is theirs to delete, and
      // deleting it is enough — the search cannot bring back something
      // it never proposed. Hiding it would leave a "no" behind for a
      // spot nobody will ever be offered again.
      throw APIError.failedPrecondition(
        "dieser Spot wurde selbst hinzugefügt — er lässt sich aus dem Vorrat entfernen, "
        + "ausblenden muss man ihn nicht",
      );
    }

    await hideSpot(plan.id, osmRef, known.name, userId);
    const { dayIds } = await purgeSpot(plan.id, osmRef);

    // Every day that lost a stop is rewalked: the walk either side of
    // the gap has changed, and a day still describing the old one is
    // wrong in a way nobody notices until they stand there (§8.4).
    if (dayIds.length > 0) {
      const withDays = await loadPlan(plan.id, userId);
      if (!withDays) throw APIError.internal("plan vanished while hiding a spot");
      for (const leg of withDays.legs) {
        for (const day of leg.days) {
          if (!dayIds.includes(day.id)) continue;
          const blocks = day.blocks.map((b) => ({ ...b, stops: [...b.stops] }));
          recomputeDay(blocks, leg.anchor, leg.mode);
          await saveRedistribution(withDays.id, leg.id, day, blocks, leg.pool);
        }
      }
    }

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while hiding a spot");
    return {
      plan: updated,
      hidden: await listHiddenSpots(plan.id),
      wasPlanned: dayIds.length > 0,
    };
  },
);

export const unhideTripSpot = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/spots/unhide", auth: true },
  async (req: HideSpotRequest): Promise<HiddenSpotsResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const undone = await unhideSpot(plan.id, req.osmRef.trim());
    if (!undone) throw APIError.notFound("dieser Spot ist nicht ausgeblendet");

    // Deliberately no re-plan: bringing a spot back into the running is
    // not the same as putting it on a day, and re-planning somebody's
    // trip as a side effect of undoing a mistake would be the larger
    // surprise (§7.1).
    return { hidden: await listHiddenSpots(plan.id) };
  },
);

export const listTripHiddenSpots = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/hidden", auth: true },
  async (req: { planId: number }): Promise<HiddenSpotsResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return { hidden: await listHiddenSpots(plan.id) };
  },
);

/**
 * The spot as this trip knows it: its name, and whether a person put it
 * there.
 */
function findSpot(
  plan: StoredPlan,
  osmRef: string,
): { name: string | null; manual: boolean } | null {
  for (const leg of plan.legs) {
    const candidate = leg.pool.find((c) => c.osmRef === osmRef);
    if (candidate) return { name: candidate.name, manual: candidate.origin !== "search" };
    for (const day of leg.days) {
      for (const block of day.blocks) {
        const stop = block.stops.find((s) => s.osmRef === osmRef);
        // A planned stop has lost its pool row and with it the record of
        // where it came from. Treating it as a search result is the
        // safe reading: hiding it is reversible, and refusing to hide
        // something the search will keep proposing is not.
        if (stop) return { name: stop.name, manual: false };
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
