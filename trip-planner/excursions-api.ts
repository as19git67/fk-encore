/**
 * Adding, changing and removing a day trip with a time window
 * (`excursions.ts`). Each call writes the day's list and re-plans the
 * trip, like a whole-day trip does (`day-anchor-edit.ts`): the day's
 * blocks follow from the hours, and only the planner cuts them.
 *
 * Reserved for the organiser (§6.2), like the rest of the frame.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanBlocks, tripPlanDays } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { parseMinutes } from "./fixpoints";
import { isIdeasTrip } from "./ideas-mode";
import { applyStopMoves } from "./stay-weather-api";
import { loadPlan, setDayAnchor, type StoredDay, type StoredLeg, type StoredPlan } from "./plan-store";
import { MAX_SEARCH_RADIUS_M } from "./search-reach";
import { replanAfterFrameChange, type PlanResponse } from "./plans";
import { excursionBlockId, excursionProblem, excursionTravel, type Excursion } from "./excursions";

export interface AddExcursionRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  lat: number;
  lon: number;
  /** "Seestadt". */
  label?: string;
  /** How far to look around it; omitted is the walking default. */
  radiusM?: number;
  /** When the group leaves the quarters, HH:MM. */
  departAt: string;
  /** When they start back from the destination, HH:MM. */
  returnAt: string;
  /**
   * The day is a whole-day trip and becomes this excursion: the whole
   * day's destination goes, and the spots planned there move into the
   * excursion's window rather than into the day at the quarters.
   */
  replaceDayTrip?: boolean;
}

export const addTripExcursion = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/excursions", auth: true },
  async (req: AddExcursionRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const { plan, leg, day } = await dayOf(req.planId, req.legIndex, req.dayIndex, userId);
    if (day.anchor && !req.replaceDayTrip) {
      throw APIError.failedPrecondition("dieser Tag ist schon ganz ein Ausflug");
    }
    const added: Excursion = {
      id: crypto.randomUUID().slice(0, 8),
      ...place(req.lat, req.lon),
      label: label(req.label),
      radiusM: radius(req.radiusM),
      ...hours(req.departAt, req.returnAt),
    };
    const list = [...stored(day), added];
    refuseProblem(list, leg);

    if (day.anchor) {
      await setDayAnchor(day.id, null);
      // What was planned for the whole day there belongs to the window
      // there now: renaming the block carries its stops across the
      // re-plan into the excursion's block (`carry-stops.ts`).
      const spots = day.blocks.find((b) => b.kind === "spots");
      if (spots) {
        await db.update(tripPlanBlocks)
          .set({ template_id: excursionBlockId(added.id) })
          .where(and(eq(tripPlanBlocks.day_id, day.id), eq(tripPlanBlocks.id, spots.rowId)));
      }
    }
    return await write(plan, day, list, userId);
  },
);

export interface UpdateExcursionRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  excursionId: string;
  departAt?: string;
  returnAt?: string;
  lat?: number;
  lon?: number;
  label?: string;
  radiusM?: number;
}

export const updateTripExcursion = api(
  {
    expose: true,
    method: "PATCH",
    path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/excursions/:excursionId",
    auth: true,
  },
  async (req: UpdateExcursionRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const { plan, leg, day } = await dayOf(req.planId, req.legIndex, req.dayIndex, userId);
    const list = stored(day);
    const at = list.findIndex((e) => e.id === req.excursionId);
    if (at < 0) throw APIError.notFound("diesen Ausflug gibt es an diesem Tag nicht");
    const old = list[at];
    if ((req.lat === undefined) !== (req.lon === undefined)) {
      throw APIError.invalidArgument("lat and lon must be given together");
    }
    list[at] = {
      ...old,
      ...(req.lat !== undefined && req.lon !== undefined ? place(req.lat, req.lon) : {}),
      ...(req.label !== undefined ? { label: label(req.label) } : {}),
      ...(req.radiusM !== undefined ? { radiusM: radius(req.radiusM) } : {}),
      ...hours(req.departAt ?? clock(old.departMinutes), req.returnAt ?? clock(old.returnMinutes)),
    };
    refuseProblem(list, leg);
    return await write(plan, day, list, userId);
  },
);

export interface RemoveExcursionRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  excursionId: string;
}

export const removeTripExcursion = api(
  {
    expose: true,
    method: "DELETE",
    path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/excursions/:excursionId",
    auth: true,
  },
  async (req: RemoveExcursionRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const { plan, day } = await dayOf(req.planId, req.legIndex, req.dayIndex, userId);
    const list = stored(day);
    if (!list.some((e) => e.id === req.excursionId)) {
      throw APIError.notFound("diesen Ausflug gibt es an diesem Tag nicht");
    }
    // Its spots go back to the ideas with the re-plan (`carry-stops.ts`).
    return await write(plan, day, list.filter((e) => e.id !== req.excursionId), userId);
  },
);

export interface MoveExcursionRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  /** The time-window excursion to move; omitted moves the whole-day trip. */
  excursionId?: string;
  toDayIndex: number;
}

/**
 * An excursion, or a whole-day trip, goes to another day of the stay
 * and takes its spots along. A window lands on the other day's list
 * and the re-plan finds its block there (`carry-stops.ts`). A whole
 * day swaps its spots with the other day's, so what was planned at the
 * quarters stays at the quarters, and then the destination moves.
 * A spot with a fixed time belongs to its day: such an excursion is
 * refused until the time is changed.
 */
export const moveTripExcursion = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/move-excursion",
    auth: true,
  },
  async (req: MoveExcursionRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const { plan, leg, day } = await dayOf(req.planId, req.legIndex, req.dayIndex, userId);
    if (req.toDayIndex === req.dayIndex) throw APIError.invalidArgument("der Ausflug ist schon an diesem Tag");
    const to = leg.days.find((d) => d.dayIndex === req.toDayIndex);
    if (!to) throw APIError.notFound(`day ${req.toDayIndex} not found in leg ${req.legIndex}`);
    const fixed = (blockIds: (id: string) => boolean): boolean =>
      day.blocks.some((b) => blockIds(b.id)
        && b.stops.some((s) => s.status === "planned" && day.fixpoints.some((f) => f.spotRef === s.osmRef)));

    if (req.excursionId !== undefined) {
      const list = stored(day);
      const moving = list.find((e) => e.id === req.excursionId);
      if (!moving) throw APIError.notFound("diesen Ausflug gibt es an diesem Tag nicht");
      if (to.anchor) throw APIError.failedPrecondition("dieser Tag ist schon ganz ein Ausflug");
      if (fixed((id) => id === excursionBlockId(moving.id))) {
        throw APIError.failedPrecondition("ein Spot des Ausflugs hat eine feste Zeit; die bleibt an ihrem Tag");
      }
      const target = [...stored(to), moving];
      refuseProblem(target, leg);
      await db.update(tripPlanDays).set({ excursions: target }).where(eq(tripPlanDays.id, to.id));
      return await write(plan, day, list.filter((e) => e.id !== moving.id), userId);
    }

    if (!day.anchor) throw APIError.failedPrecondition("dieser Tag ist kein ganztägiger Ausflug");
    if (to.anchor) throw APIError.failedPrecondition("dieser Tag ist schon ganz ein Ausflug");
    if ((to.excursions ?? []).length > 0) {
      throw APIError.failedPrecondition("an diesem Tag gibt es schon Ausflüge mit Zeitfenster");
    }
    if (fixed(() => true) || to.blocks.some((b) =>
      b.stops.some((s) => s.status === "planned" && to.fixpoints.some((f) => f.spotRef === s.osmRef)))) {
      throw APIError.failedPrecondition("ein Spot an einem der Tage hat eine feste Zeit; die bleibt an ihrem Tag");
    }
    const refs = (d: StoredDay) => d.blocks.flatMap((b) => b.stops)
      .filter((s) => s.status === "planned").map((s) => s.osmRef);
    await applyStopMoves(plan, leg, [
      ...refs(day).map((osmRef) => ({ osmRef, toDayIndex: to.dayIndex })),
      ...refs(to).map((osmRef) => ({ osmRef, toDayIndex: day.dayIndex })),
    ]);
    await setDayAnchor(to.id, day.anchor);
    await setDayAnchor(day.id, null);
    const written = await loadPlan(plan.id, userId);
    if (!written) throw APIError.internal("plan vanished while moving a day trip");
    return await replanAfterFrameChange(written, userId);
  },
);

async function write(plan: StoredPlan, day: StoredDay, list: readonly Excursion[], userId: number): Promise<PlanResponse> {
  await db.update(tripPlanDays)
    .set({ excursions: list.map(({ id, lat, lon, label, radiusM, departMinutes, returnMinutes }) =>
      ({ id, lat, lon, label, radiusM, departMinutes, returnMinutes })) })
    .where(eq(tripPlanDays.id, day.id));
  // From the trip as it is now: the re-planner reads each leg back as
  // the request that would produce it, excursions included.
  const written = await loadPlan(plan.id, userId);
  if (!written) throw APIError.internal("plan vanished while changing a day trip");
  return await replanAfterFrameChange(written, userId);
}

function stored(day: StoredDay): Excursion[] {
  return (day.excursions ?? []).map(({ id, lat, lon, label, radiusM, departMinutes, returnMinutes }) =>
    ({ id, lat, lon, label, radiusM, departMinutes, returnMinutes }));
}

function refuseProblem(list: readonly Excursion[], leg: StoredLeg): void {
  const problem = excursionProblem(list, (e) => excursionTravel(leg.anchor, e, leg.mode));
  if (problem) throw APIError.invalidArgument(problem);
}

async function dayOf(
  planId: number,
  legIndex: number,
  dayIndex: number,
  userId: number,
): Promise<{ plan: StoredPlan; leg: StoredLeg; day: StoredDay }> {
  await requireOrganiser(planId, userId, "Ausflüge");
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  if (!isIdeasTrip(plan.constraints)) {
    throw APIError.failedPrecondition("Ausflüge mit Zeitfenster gibt es nur auf einer Reise aus Ideen");
  }
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  if (leg.kind === "transit") throw APIError.failedPrecondition("eine Weiterreise hat keine Ausflüge");
  const day = leg.days.find((d) => d.dayIndex === dayIndex);
  if (!day) throw APIError.notFound(`day ${dayIndex} not found in leg ${legIndex}`);
  return { plan, leg, day };
}

function place(lat: number, lon: number): { lat: number; lon: number } {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw APIError.invalidArgument(`lat out of range: ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw APIError.invalidArgument(`lon out of range: ${lon}`);
  return { lat, lon };
}

function label(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (trimmed && trimmed.length > 120) throw APIError.invalidArgument("label may be at most 120 characters");
  return trimmed || null;
}

function radius(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) throw APIError.invalidArgument("radiusM must be a positive number");
  if (value > MAX_SEARCH_RADIUS_M) throw APIError.invalidArgument(`radiusM may be at most ${MAX_SEARCH_RADIUS_M} m`);
  return Math.round(value);
}

function hours(departAt: string, returnAt: string): { departMinutes: number; returnMinutes: number } {
  const departMinutes = parseMinutes(departAt ?? "");
  const returnMinutes = parseMinutes(returnAt ?? "");
  if (departMinutes === null) throw APIError.invalidArgument(`departAt must be a time of day as HH:MM, got '${departAt}'`);
  if (returnMinutes === null) throw APIError.invalidArgument(`returnAt must be a time of day as HH:MM, got '${returnAt}'`);
  if (returnMinutes <= departMinutes) throw APIError.invalidArgument("returnAt must be later than departAt");
  return { departMinutes, returnMinutes };
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function requireUser(): number {
  const auth = getAuthData();
  requirePermission(auth, "photos.view");
  return Number(auth!.userID);
}
