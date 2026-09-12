/**
 * Putting a hard time on a day, and taking it off again (§4.4).
 *
 * The mechanism has been there from the start: a fixpoint spans the
 * frame of a day, a departure is computed **backwards** from the train,
 * and the blocks fill what is left. What was missing is the way to say
 * one — fixpoints could only be given when a trip was created, so the
 * last day of a trip had no departure unless somebody thought of it
 * months in advance, and the afternoon kept promising hours the group
 * spends on a platform.
 *
 * Two calls, and both re-plan the trip afterwards. That is not a
 * flourish: a fixpoint changes how many minutes each block has, and a
 * day whose frame moved but whose spots did not is a day that no longer
 * adds up. The re-plan is the same one a settings change runs, so what
 * survives — the legs, the dates, everybody's own finds — is the same
 * list.
 *
 * Reserved for the organiser (§6.2): the frame is one of the three
 * rights held back, and "der letzte Zug geht um 17:45" is the frame in
 * its purest form.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { addFixpoint, loadPlan, removeFixpoint } from "./plan-store";
import type { FixpointKind } from "./fixpoints";
import { MIN_BUFFER_MINUTES } from "./fixpoints";
import { replanAfterFrameChange, type PlanResponse } from "./plans";

export interface AddFixpointRequest {
  planId: number;
  legIndex?: number;
  /** Which day of the leg, counted from zero. */
  dayIndex: number;
  /** "Letzter Zug", "Führung Alhambra", "Check-in". */
  label: string;
  /** "17:45", in the destination's own clock. */
  at: string;
  /**
   * Defaults to "appointment" — the kind you come back from. After a
   * departure the day is over, which is why the two cannot be one type
   * (§4.4).
   */
  kind?: FixpointKind;
  /** How long it occupies. Zero for a departure. */
  durationMinutes?: number;
  /** The way there from wherever the day has reached. */
  travelMinutes?: number;
  /** Margin in front of it. Defaults to 20, never below 5. */
  bufferMinutes?: number;
  /**
   * Where it happens, when that is known — the station, the airport,
   * the theatre (§4.4).
   *
   * More than a label: a fixpoint at one end of the day *moves* the
   * day's route (`day-ends.ts`). An arrival is where the first block
   * sets off from, a departure where the last one has to finish, so an
   * evening before the last train ends at the platform instead of at a
   * hotel nobody goes back to. Both are optional; without them the day
   * begins and ends at the accommodation, as it always did.
   */
  lat?: number;
  lon?: number;
}

export interface RemoveFixpointRequest {
  planId: number;
  /** The fixpoint's row id, as the plan reports it. */
  fixpointId: number;
}

export const addTripFixpoint = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/fixpoints", auth: true },
  async (req: AddFixpointRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Feste Zeiten");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    const label = req.label.trim();
    if (!label) throw APIError.invalidArgument("label is required");
    if (label.length > 120) {
      throw APIError.invalidArgument("label may be at most 120 characters");
    }

    const kind: FixpointKind = req.kind === "departure" ? "departure" : "appointment";
    await addFixpoint(day.id, {
      id: `${day.id}-${Date.now()}`,
      label,
      kind,
      startMinutes: parseTimeOfDay(req.at),
      // A departure is an instant — the train leaving takes no time,
      // and a duration on one would plan an evening behind it (§4.4).
      durationMinutes: kind === "departure" ? 0 : minutes(req.durationMinutes, "durationMinutes", 0),
      travelMinutes: minutes(req.travelMinutes, "travelMinutes", 0),
      bufferMinutes: buffer(req.bufferMinutes),
      ...place(req.lat, req.lon),
    });

    // Re-planned from the trip as it is *now*: the re-planner reads each
    // leg back as the request that would produce it, fixpoints included,
    // and a snapshot taken before the write would frame the day around
    // the times it used to have — and delete the new one on the way.
    const written = await loadPlan(req.planId, userId);
    if (!written) throw APIError.internal("plan vanished while setting a fixed time");
    return await replanAfterFrameChange(written, userId);
  },
);

export const removeTripFixpoint = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/fixpoints/remove",
    auth: true,
  },
  async (req: RemoveFixpointRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Feste Zeiten");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const removed = await removeFixpoint(req.planId, userId, req.fixpointId);
    if (!removed) throw APIError.notFound("diese feste Zeit gehört nicht zu dieser Reise");

    // The day gets its minutes back, so it is planned again — the blocks
    // the fixpoint had shortened are wider now, and leaving them as they
    // are would keep a train nobody catches in the arithmetic. From the
    // trip as it is now, for the same reason as above.
    const remaining = await loadPlan(req.planId, userId);
    if (!remaining) throw APIError.internal("plan vanished while removing a fixed time");
    return await replanAfterFrameChange(remaining, userId);
  },
);

/**
 * The coordinate, or nothing at all.
 *
 * Half of one is refused rather than stored: a latitude without a
 * longitude is not a place with a gap in it, it is a bug, and keeping
 * it would put a day's start somewhere off the coast of Africa.
 */
function place(lat: number | undefined, lon: number | undefined): { lat: number; lon: number } | Record<string, never> {
  if (lat === undefined && lon === undefined) return {};
  if (lat === undefined || lon === undefined) {
    throw APIError.invalidArgument("lat and lon must be given together");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
  return { lat, lon };
}

/** "17:45" → 1065. Anything else is refused rather than guessed. */
function parseTimeOfDay(value: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw APIError.invalidArgument('at must be a time of day like "17:45"');
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutes(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 12 * 60) {
    throw APIError.invalidArgument(`${field} must be between 0 and 720 minutes`);
  }
  return value;
}

/**
 * Never below the floor, whatever the caller asks for: a traveller who
 * sets the margin to nothing has not decided to run for the train, they
 * have decided not to think about it (§4.4).
 */
function buffer(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value > 12 * 60) {
    throw APIError.invalidArgument("bufferMinutes must be between 5 and 720");
  }
  return Math.max(MIN_BUFFER_MINUTES, value);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
