/**
 * Sending one day of a leg somewhere else, and calling it back (§4.5).
 *
 * The base with day trips out of it — three days in an Airbnb in San
 * Gimignano, one of them in Pisa — is one leg with one set of quarters.
 * Modelling it as three legs would promise three hotels, three transfer
 * days and three pools nothing slips between, which is the opposite of
 * what the traveller means.
 *
 * Both calls re-plan the trip afterwards, for the same reason the
 * fixpoint calls do: a day trip changes which pool the day is built
 * from and how many minutes its blocks have, and a day whose
 * destination moved but whose spots did not is a day that no longer
 * adds up.
 *
 * Reserved for the organiser (§6.2), like the rest of the frame.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { parseMinutes } from "./fixpoints";
import { loadPlan, setDayAnchor } from "./plan-store";
import { MAX_SEARCH_RADIUS_M } from "./search-reach";
import { replanAfterFrameChange, type PlanResponse } from "./plans";

export interface SetDayAnchorRequest {
  planId: number;
  legIndex?: number;
  /** Which day of the leg, counted from zero. */
  dayIndex: number;
  /**
   * Where the day happens. Both together, or neither: passing no
   * coordinate at all clears the day trip and the day goes back to the
   * quarters.
   */
  lat?: number;
  lon?: number;
  /** What to call it on the day card — "Pisa". */
  label?: string;
  /**
   * How far to look around it. Omitted falls back to the leg's radius,
   * which follows the transport mode (`search-reach.ts`).
   */
  radiusM?: number;
  /**
   * When the group leaves the quarters, as HH:MM.
   *
   * The drive is an estimate and always will be without a routing
   * engine (§12). Naming the hours is the traveller's way of saying
   * what they already know better than any estimate could — and then
   * the day is planned from what they said, not from the guess.
   */
  departAt?: string;
  /** When they start back from the destination, as HH:MM. */
  returnAt?: string;
}

export const setTripDayAnchor = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/days/anchor",
    auth: true,
  },
  async (req: SetDayAnchorRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Ausflüge");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    await setDayAnchor(day.id, anchorOf(req));

    // From the trip as it is now: the re-planner reads each leg back as
    // the request that would produce it, day trips included, and a
    // snapshot taken before the write would plan around the place the
    // day used to happen in.
    const written = await loadPlan(req.planId, userId);
    if (!written) throw APIError.internal("plan vanished while setting a day trip");
    return await replanAfterFrameChange(written, userId);
  },
);

/** The day trip the request describes, or null to call the day home. */
function anchorOf(req: SetDayAnchorRequest) {
  if (req.lat === undefined && req.lon === undefined) return null;
  if (req.lat === undefined || req.lon === undefined) {
    throw APIError.invalidArgument("lat and lon must be given together");
  }
  if (!Number.isFinite(req.lat) || req.lat < -90 || req.lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${req.lat}`);
  }
  if (!Number.isFinite(req.lon) || req.lon < -180 || req.lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${req.lon}`);
  }
  if (req.radiusM !== undefined) {
    if (!Number.isFinite(req.radiusM) || req.radiusM <= 0) {
      throw APIError.invalidArgument("radiusM must be a positive number");
    }
    if (req.radiusM > MAX_SEARCH_RADIUS_M) {
      throw APIError.invalidArgument(`radiusM may be at most ${MAX_SEARCH_RADIUS_M} m`);
    }
  }
  const label = req.label?.trim();
  if (label && label.length > 120) {
    throw APIError.invalidArgument("label may be at most 120 characters");
  }
  const departMinutes = timeOfDay(req.departAt, "departAt");
  const returnMinutes = timeOfDay(req.returnAt, "returnAt");
  if (departMinutes !== null && returnMinutes !== null && returnMinutes <= departMinutes) {
    throw APIError.invalidArgument("returnAt must be later than departAt");
  }
  return {
    lat: req.lat,
    lon: req.lon,
    label: label || null,
    radiusM: req.radiusM === undefined ? null : Math.round(req.radiusM),
    departMinutes,
    returnMinutes,
  };
}

/** An hour the traveller typed, or nothing — never a silent zero. */
function timeOfDay(text: string | undefined, field: string): number | null {
  if (text === undefined || text.trim() === "") return null;
  const minutes = parseMinutes(text);
  if (minutes === null) {
    throw APIError.invalidArgument(`${field} must be a time of day as HH:MM, got '${text}'`);
  }
  return minutes;
}

function requireUser(): number {
  const auth = getAuthData();
  requirePermission(auth, "photos.view");
  return Number(auth!.userID);
}
