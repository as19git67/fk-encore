/**
 * Adding, changing and removing the cities of a trip (§4.2, §6.2).
 *
 * A trip has always been a list of legs — the solver, the store and the
 * pool were built that way, and `POST /trip-planner/plans` has taken up
 * to ten of them since the beginning. What was missing is everything
 * *after* the trip exists: no way to add the city you decided on later,
 * none to move an anchor when the hotel changed, none to drop a leg
 * that fell through. A twenty-day trip through Japan (§16) was
 * plannable in one request and immutable afterwards, which is not how
 * anybody plans twenty days.
 *
 * Three endpoints, and each keeps a promise the rest of the planner
 * already makes:
 *
 *   - **A leg added later is a leg like any other.** It goes through
 *     the same `planLegForTrip`, so it inherits the trip's pace, group,
 *     interests and longest walk, asks for its region the same way, and
 *     comes back framed-but-empty if that region is still importing
 *     (§4.3). Nothing here re-reads the constraints on its own.
 *   - **A transfer frames both ends** (§4.2). Arriving at 14:00 shortens
 *     the arrival day, and leaving at 09:30 puts a `departure` fixpoint
 *     on the last day of the leg you are leaving — so adding a city
 *     re-plans its predecessor too, because that day really did change.
 *   - **The frame belongs to the organiser** (§6.2). Everything else on
 *     a trip is open to everybody on it; the legs are the frame.
 *
 * What none of them do is touch a day somebody has begun. A leg with a
 * settled stop is a record of what happened, and the refusal names it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { isCalendarDate } from "./leg-dates";
import {
  insertLeg,
  loadPlan,
  removeLeg,
  replanPlan,
  setLegsAwaitingRegion,
  shiftLegsFrom,
  updateLegFrames,
  updateLegPlace,
  type CreateDayInput,
  type StoredPlan,
} from "./plan-store";
import {
  applyTransfers,
  legRequestFromStored,
  planLegForTrip,
  validateMode,
  type LegRequest,
  type PlanResponse,
  type TransferRequest,
} from "./plans";
import type { TransportMode } from "./travel";

/** Mirrors `plans.ts`; a trip may not grow past it by adding legs either. */
const MAX_LEGS = 10;
/**
 * How many days of a newly added leg are planned down to spots.
 *
 * Two, like a new trip — and for the same reason (§4.3). A leg added
 * for next month does not need eleven planned days; a leg added the
 * evening before needs the first one.
 */
const DEFAULT_DETAIL_DAYS = 2;

export interface AddLegRequest {
  planId: number;
  /** What to call it — usually the city. */
  title?: string;
  anchor: { lat: number; lon: number };
  anchorRadiusM?: number;
  mode?: TransportMode;
  days?: number;
  radiusM?: number;
  startDate?: string;
  dayStartsAt?: string;
  /**
   * Where in the trip it goes, counted from zero. Appended at the end
   * when absent, which is what "noch eine Stadt" almost always means.
   */
  position?: number;
  /** The journey into it, from the leg before (§4.2). */
  transfer?: TransferRequest;
}

export const addTripLeg = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs", auth: true },
  async (req: AddLegRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Etappen ändern");

    if (plan.legs.length >= MAX_LEGS) {
      throw APIError.failedPrecondition(
        `eine Reise hat höchstens ${MAX_LEGS} Etappen — das ist ein Leben, keine Reise`,
      );
    }
    const position = validatePosition(req.position, plan.legs.length);
    const previous = position > 0 ? legAt(plan, position - 1) : null;

    // A transfer reaches back into the leg before it, so the two are
    // prepared together and the predecessor is re-planned with the
    // departure the transfer puts on its last day.
    const incoming: LegRequest = {
      title: req.title,
      anchor: req.anchor,
      anchorRadiusM: req.anchorRadiusM,
      mode: req.mode,
      days: req.days,
      radiusM: req.radiusM,
      startDate: req.startDate,
      dayStartsAt: req.dayStartsAt,
      transfer: req.transfer,
    };
    const prepared = previous
      ? applyTransfers([legRequestFromStored(previous), incoming])
      : applyTransfers([incoming]);
    const arriving = prepared[prepared.length - 1];

    if (req.startDate !== undefined && !isCalendarDate(req.startDate)) {
      throw APIError.invalidArgument(`startDate must be YYYY-MM-DD, got '${req.startDate}'`);
    }

    const planned = await planLegForTrip(plan, arriving.request, {
      detailDays: DEFAULT_DETAIL_DAYS,
      firstDayStartMinutes: arriving.firstDayStartMinutes,
    });

    // Only a departure time reaches back into the previous leg — and
    // only then is it re-planned. Testing "has fixpoints" instead would
    // fire for a leg that simply has a dentist's appointment on it, and
    // then refuse the whole addition once that day had begun.
    const replanPrevious = previous !== null && Boolean(req.transfer?.departAt)
      ? prepared[0]
      : null;
    if (replanPrevious && previous) {
      const settled = firstSettledStop(previous);
      if (settled) {
        throw APIError.failedPrecondition(
          `„${settled}" auf „${legName(previous)}" ist schon abgehakt — die Abfahrtszeit `
            + "würde einen begonnenen Tag neu planen. Ohne `transfer.departAt` geht es.",
        );
      }
    }

    await shiftLegsFrom(req.planId, position);
    await insertLeg(req.planId, position, planned.leg);

    if (replanPrevious && previous) {
      const before = await planLegForTrip(plan, replanPrevious.request, {
        detailDays: previous.days.filter((d) => d.detailed).length,
      });
      await replanPlan(req.planId, plan.constraints, [{
        legId: previous.id,
        days: [...before.leg.days] as CreateDayInput[],
        pool: [...before.leg.pool],
      }]);
      await setLegsAwaitingRegion([
        { legId: previous.id, awaiting: before.pending !== null },
      ]);
    }

    return {
      plan: await reload(req.planId, userId),
      droppedBlocks: planned.dropped.map((d) => ({ ...d, legIndex: position })),
      pendingRegions: planned.pending
        ? [{ ...planned.pending, legIndex: position, legTitle: req.title ?? null }]
        : [],
    };
  },
);

export interface UpdateLegRequest {
  planId: number;
  /** Which leg, by its position in the trip — how every endpoint here addresses one. */
  legIndex: number;
  title?: string;
  /** Moving the base: the hotel changed, or the pin was off. */
  anchor?: { lat: number; lon: number };
  /** Null to say the base is an address again rather than a zone. */
  anchorRadiusM?: number | null;
  mode?: TransportMode;
  days?: number;
  radiusM?: number;
  /** `null` takes the date off this leg. */
  startDate?: string | null;
  dayStartsAt?: string;
}

export const updateTripLeg = api(
  {
    expose: true,
    method: "PATCH",
    path: "/trip-planner/plans/:planId/legs/:legIndex",
    auth: true,
  },
  async (req: UpdateLegRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Etappen ändern");

    const leg = legAt(plan, req.legIndex);

    // Which of the two kinds of change is this? Moving the anchor,
    // changing the mode, the length or the radius changes what the days
    // can hold; a name and a date do not. Only the first kind throws
    // the solver's work away, and only it is refused on a begun leg.
    const replans = req.anchor !== undefined
      || req.mode !== undefined
      || req.days !== undefined
      || req.radiusM !== undefined
      || req.anchorRadiusM !== undefined
      || req.dayStartsAt !== undefined;

    if (replans) {
      const settled = firstSettledStop(leg);
      if (settled) {
        throw APIError.failedPrecondition(
          `„${settled}" ist schon abgehakt — eine begonnene Etappe wird nicht neu geplant. `
            + "Der Name und das Datum lassen sich trotzdem ändern.",
        );
      }
    }

    if (req.startDate !== undefined) {
      if (req.startDate !== null && !isCalendarDate(req.startDate)) {
        throw APIError.invalidArgument(`startDate must be YYYY-MM-DD, got '${req.startDate}'`);
      }
      // This leg only: shifting the whole trip is what
      // `PATCH …/settings` is for, and a leg moved on its own is how a
      // gap between two cities appears.
      await updateLegFrames(req.planId, [{ legId: leg.id, startDate: req.startDate }]);
    }
    if (req.mode !== undefined) {
      await updateLegFrames(req.planId, [{ legId: leg.id, mode: validateMode(req.mode) }]);
    }
    if (req.title !== undefined) {
      await updateLegPlace(req.planId, leg.id, { title: req.title.trim() || null });
    }

    if (!replans) return { plan: await reload(req.planId, userId) };

    const reloaded = await reload(req.planId, userId);
    const stored = legAt(reloaded, req.legIndex);
    const request: LegRequest = {
      ...legRequestFromStored(stored),
      anchor: req.anchor ?? stored.anchor,
      anchorRadiusM: req.anchorRadiusM === undefined
        ? (stored.anchorRadiusM ?? undefined)
        : (req.anchorRadiusM ?? undefined),
      mode: req.mode ?? stored.mode,
      days: req.days ?? stored.days.length,
      radiusM: req.radiusM ?? (stored.radiusM ?? undefined),
      dayStartsAt: req.dayStartsAt ?? legRequestFromStored(stored).dayStartsAt,
      // Fixpoints belong to days; a leg that just got shorter must not
      // carry a fixpoint on a day it no longer has.
      fixpoints: (legRequestFromStored(stored).fixpoints ?? [])
        .filter((f) => f.dayIndex < (req.days ?? stored.days.length)),
    };

    const planned = await planLegForTrip(reloaded, request, {
      detailDays: Math.max(1, stored.days.filter((d) => d.detailed).length),
    });

    // The row itself carries the anchor and the radius; the re-plan
    // writes days and pool. Both, or the next re-plan would quietly go
    // back to the old anchor.
    await updateLegPlace(req.planId, leg.id, {
      anchor: req.anchor,
      anchorRadiusM: req.anchorRadiusM,
      radiusM: req.radiusM,
      regionDb: planned.leg.regionDb,
      dayStartMinutes: planned.leg.dayStartMinutes,
    });
    await replanPlan(req.planId, reloaded.constraints, [{
      legId: leg.id,
      days: [...planned.leg.days] as CreateDayInput[],
      pool: [...planned.leg.pool],
    }]);
    // Moving an anchor can move a leg out of an imported region and
    // into one that is not there yet — and back again.
    await setLegsAwaitingRegion([{ legId: leg.id, awaiting: planned.pending !== null }]);

    return {
      plan: await reload(req.planId, userId),
      droppedBlocks: planned.dropped.map((d) => ({ ...d, legIndex: req.legIndex })),
      pendingRegions: planned.pending
        ? [{ ...planned.pending, legIndex: req.legIndex, legTitle: stored.title }]
        : [],
    };
  },
);

export interface RemoveLegRequest {
  planId: number;
  legIndex: number;
}

export const removeTripLeg = api(
  {
    expose: true,
    method: "DELETE",
    path: "/trip-planner/plans/:planId/legs/:legIndex",
    auth: true,
  },
  async (req: RemoveLegRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Etappen ändern");

    const leg = legAt(plan, req.legIndex);
    if (plan.legs.length === 1) {
      throw APIError.failedPrecondition(
        "das ist die einzige Etappe — eine Reise ohne Etappe gibt es nicht. "
          + "Die ganze Reise löschen geht über die Reiseliste.",
      );
    }
    // The days of this leg go with it, and so does its pool — including
    // whatever somebody added by hand. Saying so is the caller's job;
    // this refuses only what cannot be undone by re-adding the city.
    const settled = firstSettledStop(leg);
    if (settled) {
      throw APIError.failedPrecondition(
        `„${settled}" ist schon abgehakt — eine begonnene Etappe wird nicht gelöscht. `
          + "Sie ist die Aufzeichnung dessen, was stattgefunden hat.",
      );
    }

    await removeLeg(req.planId, leg.id);
    return { plan: await reload(req.planId, userId) };
  },
);

// MARK: - Shared bits

function legAt(plan: StoredPlan, legIndex: number): StoredPlan["legs"][number] {
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  return leg;
}

/** What to call a leg in a sentence, when it may have no name. */
function legName(leg: StoredPlan["legs"][number]): string {
  return leg.title ?? `Etappe ${leg.position + 1}`;
}

/** The first stop of this leg anybody has settled, by name. */
function firstSettledStop(leg: StoredPlan["legs"][number]): string | null {
  for (const day of leg.days) {
    for (const block of day.blocks) {
      for (const stop of block.stops) {
        if (stop.status !== "planned") return stop.name ?? stop.osmRef;
      }
    }
  }
  return null;
}

function validatePosition(position: number | undefined, legCount: number): number {
  if (position === undefined) return legCount;
  if (!Number.isInteger(position) || position < 0 || position > legCount) {
    throw APIError.invalidArgument(`position must be between 0 and ${legCount}`);
  }
  return position;
}

async function reload(planId: number, userId: number): Promise<StoredPlan> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.internal("plan vanished while it was being written");
  return plan;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
