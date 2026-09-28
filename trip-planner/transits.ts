/**
 * Putting a journey between two legs (§22.7).
 *
 * The traveller says when the group sets off — date and time — and when
 * it arrives. Everything else follows from those two moments:
 *
 *   - **The leg before ends with the departure.** Its last day is the
 *     day of departure, and that day gets a `departure` at the base: the
 *     day is over when the group leaves, and whatever the leg had
 *     planned after it is not a day anybody has.
 *   - **The leg after begins with the arrival.** Its first day is the
 *     day of arrival, starting at the arrival time — the same late start
 *     a transfer has always given (§4.2). Every leg after it moves by
 *     the same number of days, so the gaps the travellers left survive.
 *   - **The journey in between is a leg of its own**, planned by
 *     `transit-leg.ts`.
 *
 * Refused rather than done half-way: a trip without dates (a moment
 * needs a day), a journey that arrives before it sets off, and a change
 * that would re-plan a day somebody has already begun.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { daysBetween, isCalendarDate } from "./leg-dates";
import { requireOrganiser } from "./plan-access";
import {
  insertLeg,
  loadPlan,
  replanPlan,
  setLegsAwaitingRegion,
  shiftLegsFrom,
  updateLegFrames,
  updateLegPlace,
  type CreateDayInput,
  type StoredPlan,
} from "./plan-store";
import {
  legRequestFromStored,
  planLegForTrip,
  validateMode,
  type LegRequest,
  type PlanResponse,
} from "./plans";
import { minutesOf } from "./transit-leg";
import type { TransportMode } from "./travel";

/** A journey longer than this is a leg of its own, not a journey. */
const MAX_TRANSIT_DAYS = 7;

export interface AddTransitRequest {
  planId: number;
  /** The leg the journey leaves from, by position; it goes to the next one. */
  afterLegIndex: number;
  /** The day and time the group sets off, as YYYY-MM-DD and HH:MM. */
  departDate: string;
  departAt: string;
  /** The day and time it arrives. */
  arriveDate: string;
  arriveAt: string;
  /** How it travels. The next leg's mode when absent. */
  mode?: TransportMode;
  /** What to call it. "Weiterreise nach <next leg>" when absent. */
  title?: string;
}

export const addTripTransit = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/transits", auth: true },
  async (req: AddTransitRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Etappen ändern");

    const previous = legAt(plan, req.afterLegIndex);
    const next = plan.legs.find((l) => l.position === req.afterLegIndex + 1);
    if (!next) {
      throw APIError.failedPrecondition("nach dieser Etappe kommt keine mehr — wohin soll die Weiterreise gehen?");
    }
    if (previous.kind === "transit" || next.kind === "transit") {
      throw APIError.failedPrecondition("zwischen diesen beiden Etappen gibt es schon eine Weiterreise");
    }
    if (!previous.startDate || !next.startDate) {
      throw APIError.failedPrecondition(
        "eine Weiterreise hat ein Datum — erst der Reise Daten geben, dann die Weiterreise anlegen",
      );
    }

    const departMinutes = requireTime(req.departAt, "departAt");
    const arriveMinutes = requireTime(req.arriveAt, "arriveAt");
    requireDate(req.departDate, "departDate");
    requireDate(req.arriveDate, "arriveDate");
    const span = daysBetween(req.departDate, req.arriveDate);
    if (span < 0 || (span === 0 && arriveMinutes <= departMinutes)) {
      throw APIError.invalidArgument("die Ankunft muss nach der Abfahrt liegen");
    }
    if (span + 1 > MAX_TRANSIT_DAYS) {
      throw APIError.invalidArgument(
        `eine Weiterreise dauert höchstens ${MAX_TRANSIT_DAYS} Tage — länger ist es eine eigene Etappe`,
      );
    }
    const previousDays = daysBetween(previous.startDate, req.departDate) + 1;
    if (previousDays < 1) {
      throw APIError.invalidArgument(
        `die Abfahrt liegt vor dem ersten Tag von „${legName(previous)}" (${previous.startDate})`,
      );
    }

    // What the two neighbours become. Both are re-planned, so neither
    // may hold a day somebody has begun.
    for (const leg of [previous, next]) {
      const settled = firstSettledStop(leg);
      if (settled) {
        throw APIError.failedPrecondition(
          `„${settled}" auf „${legName(leg)}" ist schon abgehakt — die Weiterreise würde `
            + "einen begonnenen Tag neu planen",
        );
      }
    }

    const nextTitle = next.title ?? next.anchorLabel ?? `Etappe ${next.position + 1}`;
    const previousRequest = previousLegRequest(previous, previousDays, req.departAt, nextTitle);
    const nextRequest: LegRequest = {
      ...legRequestFromStored(next),
      startDate: req.arriveDate,
      transfer: { arriveAt: req.arriveAt },
    };
    const mode = validateMode(req.mode ?? next.mode);
    const transitRequest: LegRequest = {
      kind: "transit",
      title: req.title?.trim() || `Weiterreise nach ${nextTitle}`,
      anchor: next.anchor,
      anchorLabel: next.anchorLabel ?? next.title ?? undefined,
      origin: {
        lat: previous.anchor.lat,
        lon: previous.anchor.lon,
        label: previous.anchorLabel ?? previous.title ?? null,
      },
      mode,
      days: span + 1,
      startDate: req.departDate,
      transit: { departAt: req.departAt, arriveAt: req.arriveAt },
    };

    // Everything planned before anything is written: a refusal half-way
    // would leave a trip with one neighbour changed and no journey.
    const detailedOf = (leg: StoredPlan["legs"][number]) => leg.days.filter((d) => d.detailed).length;
    const plannedPrevious = await planLegForTrip(plan, previousRequest, {
      detailDays: detailedOf(previous),
      firstDayStartMinutes: previous.arriveMinutes,
    });
    const plannedNext = await planLegForTrip(plan, nextRequest, {
      detailDays: detailedOf(next),
      firstDayStartMinutes: arriveMinutes,
    });
    const plannedTransit = await planLegForTrip(plan, transitRequest, { detailDays: span + 1 });

    await replanPlan(req.planId, plan.constraints, [
      { legId: previous.id, days: [...plannedPrevious.leg.days] as CreateDayInput[], pool: [...plannedPrevious.leg.pool] },
      { legId: next.id, days: [...plannedNext.leg.days] as CreateDayInput[], pool: [...plannedNext.leg.pool] },
    ]);
    await setLegsAwaitingRegion([
      { legId: previous.id, awaiting: plannedPrevious.pending !== null },
      { legId: next.id, awaiting: plannedNext.pending !== null },
    ]);
    await updateLegPlace(req.planId, next.id, { arriveMinutes });

    // The next leg and every one after it move by the same number of
    // days: the gaps the travellers left between cities survive.
    const shift = daysBetween(next.startDate, req.arriveDate);
    if (shift !== 0) {
      await updateLegFrames(req.planId, plan.legs
        .filter((l) => l.position > previous.position && l.startDate)
        .map((l) => ({ legId: l.id, startDate: addDaysTo(l.startDate as string, shift) })));
    }

    const position = previous.position + 1;
    await shiftLegsFrom(req.planId, position);
    await insertLeg(req.planId, position, plannedTransit.leg);

    const updated = await loadPlan(req.planId, userId);
    if (!updated) throw APIError.internal("plan vanished while it was being written");
    return {
      plan: updated,
      pendingRegions: plannedTransit.pending
        ? [{ ...plannedTransit.pending, legIndex: position, legTitle: transitRequest.title ?? null }]
        : [],
    };
  },
);

/**
 * The leg being left, as it will be: ending on the day of departure,
 * with the departure as that day's last word. Fixpoints on days it no
 * longer has go with them, and an earlier departure (a transfer set
 * before there was a journey) gives way to this one.
 */
function previousLegRequest(
  leg: StoredPlan["legs"][number],
  days: number,
  departAt: string,
  nextTitle: string,
): LegRequest {
  const stored = legRequestFromStored(leg);
  const lastDay = days - 1;
  return {
    ...stored,
    days,
    fixpoints: [
      ...(stored.fixpoints ?? []).filter((f) => f.dayIndex < days && f.kind !== "departure"),
      {
        dayIndex: lastDay,
        label: `Weiterreise nach ${nextTitle}`,
        at: departAt,
        kind: "departure",
        // The journey sets off from the base: the day ends there, and
        // the way to it is the day's own last walk.
        lat: leg.anchor.lat,
        lon: leg.anchor.lon,
        travelMinutes: 0,
      },
    ],
    dayAnchors: (stored.dayAnchors ?? []).filter((a) => a.dayIndex < days),
  };
}

function addDaysTo(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

function requireTime(text: string, label: string): number {
  const minutes = minutesOf(text);
  if (minutes === null) throw APIError.invalidArgument(`${label} must be HH:MM, got '${text}'`);
  return minutes;
}

function requireDate(text: string, label: string): void {
  if (typeof text !== "string" || !isCalendarDate(text)) {
    throw APIError.invalidArgument(`${label} must be YYYY-MM-DD, got '${text}'`);
  }
}

function legAt(plan: StoredPlan, legIndex: number): StoredPlan["legs"][number] {
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  return leg;
}

function legName(leg: StoredPlan["legs"][number]): string {
  return leg.title ?? `Etappe ${leg.position + 1}`;
}

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

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
