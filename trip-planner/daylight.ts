/**
 * When the light is good, for a day of a trip (§7.3).
 *
 * Deliberately the smallest of the four ways §7.3 lets light into the
 * plan: **a hint, and nothing else.** It reorders no block, moves no
 * spot and adds no ranking bonus. The other three all change what the
 * planner does, and the concept is explicit that a minute-precise light
 * window inside a plan built from half-day blocks is only defensible
 * while it stays a note — an appointment you can miss exists once
 * somebody accepts a suggestion, and then they wanted it.
 *
 * Everything here is arithmetic on rows the plan already has: the sun
 * from `sun.ts`, the building's orientation from the column the import
 * filled in. No request leaves the house, nothing is cached, and it
 * works with the network off (§3.9).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { spotLight, type FacadeLight } from "./light";
import { loadPlan } from "./plan-store";
import { lightWindows, type HorizonProfile, type LightWindow } from "./sun";

export interface DayLightRequest {
  planId: number;
  /** Which leg, counted from zero. Defaults to the first. */
  legIndex?: number;
  /** Which day of that leg, counted from zero within the leg. */
  dayIndex: number;
  /**
   * The offset of the *destination's* clock from UTC, in minutes —
   * what a clock at the spot would read. It has to be passed in: a
   * coordinate does not carry its time zone, and deriving one from the
   * longitude would be wrong across most of Europe and all of China.
   */
  utcOffsetMinutes?: number;
  /** Optional precomputed terrain profile, sampled clockwise from north. */
  horizon?: HorizonProfile;
}

export interface SpotLightHint {
  osmRef: string;
  /** The window worth naming for this spot, or null when the day has none. */
  best: LightWindow | null;
  /**
   * How the sun meets the building then — null when OpenStreetMap has
   * no outline for it, which is most spots. Not a failure: the screen
   * then says when the light is good without claiming what it lights.
   */
  facade: FacadeLight | null;
}

export interface DayLightResponse {
  /**
   * The calendar date this answers for, or null when the trip has no
   * dates yet (§4.3). Light needs a day; a trip that has not been
   * placed in the year gets no windows rather than today's by accident.
   */
  day: string | null;
  /** The day's windows at the leg's anchor, in clock order. */
  windows: LightWindow[];
  /** Per planned stop of that day, best window first. */
  spots: SpotLightHint[];
}

export const dayLight = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/light", auth: true },
  async (req: DayLightRequest): Promise<DayLightResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    const offset = validateOffset(req.utcOffsetMinutes);
    const date = leg.startDate === null ? null : addDays(leg.startDate, day.dayIndex);
    if (date === null) return { day: null, windows: [], spots: [] };

    const windows = lightWindows(leg.anchor, date, offset, req.horizon ?? []);
    const stops = day.blocks.flatMap((block) => block.stops);

    return {
      day: date,
      windows,
      spots: stops.map((stop) => {
        // Each spot gets the sun over *its* coordinate. Within a city
        // the difference is seconds, but it costs nothing and spares
        // the next reader wondering whether it was cheated.
        const own = lightWindows(stop, date, offset, req.horizon ?? []);
        const [best] = spotLight(stop, own, stop.facadeAzimuth);
        return {
          osmRef: stop.osmRef,
          best: best?.window ?? null,
          facade: best?.facade ?? null,
        };
      }),
    };
  },
);

/**
 * A time-zone offset a clock could actually show.
 *
 * The real range is −12:00 to +14:00; anything outside it is a caller
 * sending seconds or milliseconds by mistake, and silently accepting
 * that would put the golden hour in the middle of the night.
 */
function validateOffset(minutes: number | undefined): number {
  if (minutes === undefined) return 0;
  if (!Number.isFinite(minutes) || minutes < -12 * 60 || minutes > 14 * 60) {
    throw APIError.invalidArgument("utcOffsetMinutes must be between -720 and 840");
  }
  return Math.round(minutes);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
