/**
 * The weather for a day of a trip (§7.2).
 *
 * Like the light before it, this **reports and changes nothing**. It
 * says what the sky is expected to do over each block and which spots
 * would mind, and it stops there. The reordering §7.2 asks for — indoor
 * spots forward, outdoor ones back, the budget shrinking in the wet,
 * a whole rainy day swapped for a dry one — all change what the
 * planner does, and each deserves its own change with its own tests
 * rather than arriving as a side effect of fetching a forecast.
 *
 * What it does carry is the number those changes will use:
 * `budgetFactor`, computed and returned, applied nowhere yet.
 *
 * **No forecast is a valid answer.** Beyond about sixteen days there
 * is none to be had (§7.2 wants climate normals there, which is a
 * different question), and Open-Meteo can be down. Both come back as
 * `available: false` rather than as a dry, mild day — the difference
 * between "we do not know" and "it will be fine" is the whole of
 * §15.3.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan } from "./plan-store";
import { shelterOf, type Shelter } from "./shelter";
import { hoursWithin, summarise, type BlockWeather } from "./weather";
import { forecastFor } from "./weather-service";

export interface DayForecastRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
  /** The destination's offset from UTC in minutes — see the light endpoint. */
  utcOffsetMinutes?: number;
}

export interface BlockForecast {
  blockId: string;
  label: string;
  /** Null when the forecast does not cover this block. */
  weather: BlockWeather | null;
}

export interface SpotShelter {
  osmRef: string;
  shelter: Shelter;
}

export interface DayForecastResponse {
  /** The calendar date, or null for a trip with no dates yet (§4.3). */
  day: string | null;
  /**
   * False when there is no forecast: beyond the horizon, or the
   * service could not be reached. Never dressed up as good weather.
   */
  available: boolean;
  /** The whole day, for the one line a day card shows. */
  overall: BlockWeather | null;
  blocks: BlockForecast[];
  /** Which of the day's spots mind the wet (§7.2). */
  spots: SpotShelter[];
}

export const dayForecast = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/weather", auth: true },
  async (req: DayForecastRequest): Promise<DayForecastResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    const offset = validateOffset(req.utcOffsetMinutes);
    // The shelter verdict needs no forecast and no date: it is a
    // property of the spot, and worth answering even for a trip
    // nobody has placed in the year yet.
    const spots = day.blocks
      .flatMap((block) => block.stops)
      .map((stop) => ({ osmRef: stop.osmRef, shelter: shelterOf(stop.category, stop.kind) }));

    const date = leg.startDate === null ? null : addDays(leg.startDate, day.dayIndex);
    if (date === null) {
      return { day: null, available: false, overall: null, blocks: [], spots };
    }

    const { byDay } = await forecastFor(leg.anchor, [date]);
    const hours = byDay.get(date) ?? [];

    const blocks: BlockForecast[] = day.blocks.map((block) => ({
      blockId: block.id,
      label: block.label,
      weather: block.startMinutes === null
        // A block written before the frame time was kept has no place
        // on the clock, so no hours can be assigned to it. Guessing an
        // hour would put the traveller somewhere they were never
        // planned to be.
        ? null
        : summarise(hoursWithin(
          hours,
          date,
          block.startMinutes,
          block.startMinutes + block.budgetMinutes,
          offset,
        )),
    }));

    return {
      day: date,
      available: hours.length > 0,
      overall: summarise(hours),
      blocks,
      spots,
    };
  },
);

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
