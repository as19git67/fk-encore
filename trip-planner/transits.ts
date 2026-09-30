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
import { addDays, daysBetween, isCalendarDate, redateLegs } from "./leg-dates";
import { requireOrganiser } from "./plan-access";
import {
  insertLeg,
  loadPlan,
  replanPlan,
  setLegsAwaitingRegion,
  shiftLegsFrom,
  updateLegFrames,
  updateLegPlace,
  updateTransitLeg,
  type CreateDayInput,
  type PlanHome,
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
  /**
   * The leg the journey leaves from, by position; it goes to the next
   * one. Two ends may be home instead (§22.7): -1 is the journey from
   * home to the first leg, and the last leg's position with nothing
   * after it is the journey home. Both need the trip's home to be set.
   */
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

    const previous = req.afterLegIndex === -1 ? null : legAt(plan, req.afterLegIndex);
    const next = plan.legs.find((l) => l.position === req.afterLegIndex + 1) ?? null;
    if (!previous && !next) throw APIError.notFound("this trip has no legs");
    if ((!previous || !next) && !plan.home) {
      throw APIError.failedPrecondition(
        "für die Anreise und die Heimreise muss die Reise wissen, wo Zuhause ist",
      );
    }
    if (previous?.kind === "transit" || next?.kind === "transit") {
      throw APIError.failedPrecondition(
        previous && next
          ? "zwischen diesen beiden Etappen gibt es schon eine Weiterreise"
          : previous ? "die Heimreise gibt es schon" : "die Anreise gibt es schon",
      );
    }
    return await frameJourney(plan, userId, previous, next, req, null);
  },
);

export interface UpdateTransitRequest {
  planId: number;
  /** The journey itself, by position. */
  legIndex: number;
  departDate: string;
  departAt: string;
  arriveDate: string;
  arriveAt: string;
  /** How it travels. Unchanged when absent. */
  mode?: TransportMode;
  /** What to call it. Unchanged when absent. */
  title?: string;
}

/**
 * Change a journey in place (§22.7): new moments, a new mode.
 *
 * The same framing as adding one — the leg before ends with the new
 * departure, the leg after begins with the new arrival, later legs move
 * along — and the journey keeps its row, its position and its title.
 * Nothing is removed first, so a refusal leaves the journey as it was.
 */
export const updateTripTransit = api(
  { expose: true, method: "PATCH", path: "/trip-planner/plans/:planId/transits/:legIndex", auth: true },
  async (req: UpdateTransitRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Etappen ändern");

    const journey = legAt(plan, req.legIndex);
    if (journey.kind !== "transit") {
      throw APIError.failedPrecondition(`„${legName(journey)}" ist keine Weiterreise`);
    }
    const previous = plan.legs.find((l) => l.position === req.legIndex - 1) ?? null;
    const next = plan.legs.find((l) => l.position === req.legIndex + 1) ?? null;
    if (!previous && !next) throw APIError.notFound("this trip has no legs");
    if ((!previous || !next) && !plan.home) {
      throw APIError.failedPrecondition(
        "für die Anreise und die Heimreise muss die Reise wissen, wo Zuhause ist",
      );
    }
    return await frameJourney(plan, userId, previous, next, {
      ...req,
      mode: req.mode ?? journey.mode,
      title: req.title ?? journey.title ?? undefined,
    }, journey);
  },
);

/**
 * The part adding and changing share: validate the two moments, frame
 * both neighbours by them, plan the journey — everything before
 * anything is written — then write it all.
 */
async function frameJourney(
  planAsLoaded: StoredPlan,
  userId: number,
  /** The leg being left, or null for the journey from home. */
  previousAsLoaded: StoredPlan["legs"][number] | null,
  /** The leg being reached, or null for the journey home. */
  nextAsLoaded: StoredPlan["legs"][number] | null,
  req: {
    planId: number;
    departDate: string;
    departAt: string;
    arriveDate: string;
    arriveAt: string;
    mode?: TransportMode;
    title?: string;
  },
  existing: StoredPlan["legs"][number] | null,
): Promise<PlanResponse> {
  let plan = planAsLoaded;
  let previous = previousAsLoaded;
  let next = nextAsLoaded;
  // A trip without dates gets them from the journey: the day it
  // arrives is the first place's first day, the day it sets off the
  // last place's last day (§22.7). Nobody should have to date a city
  // by hand before saying when they leave home.
  if (plan.legs.every((l) => !l.startDate)) {
    requireDate(req.departDate, "departDate");
    requireDate(req.arriveDate, "arriveDate");
    const dated = await dateTripFromJourney(plan, userId, previous, next, req);
    plan = dated.plan;
    previous = dated.previous;
    next = dated.next;
  }
  if ((previous && !previous.startDate) || (next && !next.startDate)) {
    throw APIError.failedPrecondition(
      "eine Weiterreise hat ein Datum — erst der Reise Daten geben, dann die Weiterreise anlegen",
    );
  }
  const home = plan.home;
  if ((!previous || !next) && !home) throw APIError.internal("a journey to or from home needs a home");

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
  const previousDays = previous ? daysBetween(previous.startDate as string, req.departDate) + 1 : 0;
  if (previous && previousDays < 1) {
    throw APIError.invalidArgument(
      `die Abfahrt liegt vor dem ersten Tag von „${legName(previous)}" (${previous.startDate})`,
    );
  }

  // Everything re-planned here must not hold a day somebody has begun.
  const touched = [previous, existing, next].filter((l): l is StoredPlan["legs"][number] => l !== null);
  for (const leg of touched) {
    const settled = firstSettledStop(leg);
    if (settled) {
      throw APIError.failedPrecondition(
        `„${settled}" auf „${legName(leg)}" ist schon abgehakt — die Weiterreise würde `
          + "einen begonnenen Tag neu planen",
      );
    }
  }

  const homeLabel = home?.label ?? "Zuhause";
  const nextTitle = next ? next.title ?? next.anchorLabel ?? `Etappe ${next.position + 1}` : homeLabel;
  const previousTitle = previous
    ? previous.title ?? previous.anchorLabel ?? `Etappe ${previous.position + 1}`
    : homeLabel;
  const previousRequest = previous
    ? previousLegRequest(previous, previousDays, req.departAt, nextTitle)
    : null;
  const nextRequest: LegRequest | null = next
    ? { ...legRequestFromStored(next), startDate: req.arriveDate, transfer: { arriveAt: req.arriveAt } }
    : null;
  const mode = validateMode(req.mode ?? next?.mode ?? previous?.mode);
  const title = req.title?.trim()
    || (!previous ? `Anreise nach ${nextTitle}` : !next ? `Heimreise von ${previousTitle}` : `Weiterreise nach ${nextTitle}`);
  const origin = previous
    ? { lat: previous.anchor.lat, lon: previous.anchor.lon, label: previous.anchorLabel ?? previous.title ?? null }
    : { lat: (home as PlanHome).lat, lon: (home as PlanHome).lon, label: homeLabel };
  const destination = next
    ? { anchor: next.anchor, label: next.anchorLabel ?? next.title ?? null }
    : { anchor: { lat: (home as PlanHome).lat, lon: (home as PlanHome).lon }, label: homeLabel };
  const transitRequest: LegRequest = {
    kind: "transit",
    title,
    anchor: destination.anchor,
    anchorLabel: destination.label ?? undefined,
    origin,
    mode,
    days: span + 1,
    startDate: req.departDate,
    transit: { departAt: req.departAt, arriveAt: req.arriveAt },
  };

  // Everything planned before anything is written: a refusal half-way
  // would leave a trip with one neighbour changed and no journey.
  const detailedOf = (leg: StoredPlan["legs"][number]) => leg.days.filter((d) => d.detailed).length;
  const plannedPrevious = previous && previousRequest
    ? await planLegForTrip(plan, previousRequest, {
      detailDays: detailedOf(previous),
      firstDayStartMinutes: previous.arriveMinutes,
    })
    : null;
  const plannedNext = next && nextRequest
    ? await planLegForTrip(plan, nextRequest, {
      detailDays: detailedOf(next),
      firstDayStartMinutes: arriveMinutes,
    })
    : null;
  const plannedTransit = await planLegForTrip(plan, transitRequest, { detailDays: span + 1 });

  const rewrites: Array<{ legId: number; days: CreateDayInput[]; pool: typeof plannedTransit.leg.pool }> = [];
  const awaiting: Array<{ legId: number; awaiting: boolean }> = [];
  if (previous && plannedPrevious) {
    rewrites.push({ legId: previous.id, days: [...plannedPrevious.leg.days] as CreateDayInput[], pool: [...plannedPrevious.leg.pool] });
    awaiting.push({ legId: previous.id, awaiting: plannedPrevious.pending !== null });
  }
  if (next && plannedNext) {
    rewrites.push({ legId: next.id, days: [...plannedNext.leg.days] as CreateDayInput[], pool: [...plannedNext.leg.pool] });
    awaiting.push({ legId: next.id, awaiting: plannedNext.pending !== null });
  }
  if (existing) {
    rewrites.push({ legId: existing.id, days: [...plannedTransit.leg.days] as CreateDayInput[], pool: [...plannedTransit.leg.pool] });
    awaiting.push({ legId: existing.id, awaiting: plannedTransit.pending !== null });
  }
  await replanPlan(req.planId, plan.constraints, rewrites);
  await setLegsAwaitingRegion(awaiting);

  if (next) {
    await updateLegPlace(req.planId, next.id, { arriveMinutes });
    // The next leg and every one after it move by the same number of
    // days: the gaps the travellers left between cities survive.
    const shift = daysBetween(next.startDate as string, req.arriveDate);
    if (shift !== 0) {
      await updateLegFrames(req.planId, plan.legs
        .filter((l) => l.position >= next.position && l.startDate)
        .map((l) => ({ legId: l.id, startDate: addDaysTo(l.startDate as string, shift) })));
    }
  }

  let position: number;
  if (existing) {
    position = existing.position;
    await updateTransitLeg(req.planId, existing.id, {
      title,
      mode,
      origin,
      anchor: destination.anchor,
      anchorLabel: destination.label,
      startDate: req.departDate,
      departMinutes,
      endMinutes: arriveMinutes,
    });
  } else {
    position = previous ? previous.position + 1 : 0;
    await shiftLegsFrom(req.planId, position);
    await insertLeg(req.planId, position, plannedTransit.leg);
  }

  const updated = await loadPlan(req.planId, userId);
  if (!updated) throw APIError.internal("plan vanished while it was being written");
  return {
    plan: updated,
    pendingRegions: plannedTransit.pending
      ? [{ ...plannedTransit.pending, legIndex: position, legTitle: title }]
      : [],
  };
}

/**
 * Give an undated trip its dates from the journey, and read it back.
 *
 * From home, the arrival day is the first place's first day. From a
 * place, the departure day is that place's last day, and the trip's
 * first day is counted back from there over the places before it —
 * an undated trip has no journeys yet, so every leg is a place.
 */
async function dateTripFromJourney(
  plan: StoredPlan,
  userId: number,
  previous: StoredPlan["legs"][number] | null,
  next: StoredPlan["legs"][number] | null,
  req: { departDate: string; arriveDate: string },
): Promise<{
  plan: StoredPlan;
  previous: StoredPlan["legs"][number] | null;
  next: StoredPlan["legs"][number] | null;
}> {
  const legs = [...plan.legs].sort((a, b) => a.position - b.position);
  let firstDay: string;
  if (!previous) {
    firstDay = req.arriveDate;
  } else {
    const before = legs.filter((l) => l.position < previous.position);
    const daysBefore = before.reduce((sum, l) => sum + Math.max(1, l.days.length), 0);
    firstDay = addDays(req.departDate, -(daysBefore + Math.max(1, previous.days.length) - 1));
  }
  await updateLegFrames(plan.id, redateLegs(
    legs.map((l) => ({ legId: l.id, startDate: null, days: l.days.length })),
    firstDay,
  ));
  const dated = await loadPlan(plan.id, userId);
  if (!dated) throw APIError.internal("plan vanished while it was being dated");
  return {
    plan: dated,
    previous: previous ? dated.legs.find((l) => l.id === previous.id) ?? null : null,
    next: next ? dated.legs.find((l) => l.id === next.id) ?? null : null,
  };
}

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
