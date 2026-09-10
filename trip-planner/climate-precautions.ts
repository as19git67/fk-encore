/**
 * Reading a leg's climate precautions (§7.2).
 *
 * Its own module for the same reason `vote-store.ts` is: the planner
 * needs the precautions and the endpoints need the planner. It also
 * holds the one rule that decides whether any of this applies at all —
 * **is this leg beyond the forecast horizon?** Inside it there is a
 * real forecast, day by day, and a monthly average has nothing to add
 * (§7.2: "Erst in den letzten zwei Wochen schaltet sich die echte
 * Vorhersage tageweise zu").
 *
 * A failure to reach the climate service is not an error here. The
 * precautions are a nicety; refusing to plan a trip because a
 * thirty-year average was unavailable would trade something valuable
 * for something optional.
 */

import log from "encore.dev/log";
import { FORECAST_HORIZON_DAYS } from "./weather-client";
import { climateNormalFor } from "./weather-service";
import {
  bufferDayIndex,
  precautionsFor,
  type ClimateNormalLike,
  type Precautions,
} from "./climate-plan";
import { daysBetween, isCalendarDate } from "./leg-dates";

export interface LegClimate {
  precautions: Precautions;
  /** Which day to leave empty, or null when none should be. */
  bufferDay: { dayIndex: number; reason: string } | null;
  /** The month the normal was read for, or null when none was. */
  month: number | null;
}

/**
 * Today, in UTC, as a calendar date.
 *
 * The horizon is a fortnight wide, so which side of midnight the server
 * stands on cannot change the answer — and a planner that read the
 * clock in three places would eventually read it three different ways.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Forget what was fetched. For tests, which change the client. */
export function clearClimateCache(): void {
  cache.clear();
}

/**
 * The normal for this place and month, from the cache or the service —
 * and never for longer than the plan can afford to wait.
 */
async function cachedNormal(
  at: { lat: number; lon: number },
  month: number,
): Promise<ClimateNormalLike> {
  // Two decimals is the grid the weather client rounds to anyway, so
  // two anchors in the same city share one entry.
  const key = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}:${month}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const normal = await Promise.race([
      climateNormalFor(at, month),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`climate normal took longer than ${CLIMATE_BUDGET_MS} ms`)),
          CLIMATE_BUDGET_MS,
        );
      }),
    ]);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, normal);
    return normal;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * How long the plan may wait for a thirty-year average.
 *
 * Much shorter than the weather client's own eight seconds, and on
 * purpose: this is a *precaution*, and a precaution that holds up the
 * thing it is a precaution for has its priorities backwards. A trip
 * with three legs would otherwise wait half a minute on a slow day for
 * something that only ever leaves one day empty.
 */
const CLIMATE_BUDGET_MS = 2_000;

/**
 * Normals already fetched, by grid point and month.
 *
 * A 1991–2020 average does not change while the process runs, and a
 * trip is planned again every time somebody adjusts the pace — so the
 * second re-plan should cost nothing. Bounded because a long-lived
 * process should not accumulate the whole world.
 */
const CACHE_LIMIT = 500;
const cache = new Map<string, ClimateNormalLike>();

const NOTHING: LegClimate = {
  precautions: { indoorShare: null, bufferDays: 0, reasons: [] },
  bufferDay: null,
  month: null,
};

/**
 * What this leg should prepare for, or nothing.
 *
 * `today` is passed in rather than read from the clock so the answer is
 * reproducible: the same leg planned twice in one session must not come
 * out differently because midnight passed in between.
 */
export async function climateForLeg(
  leg: { anchor: { lat: number; lon: number }; startDate: string | null; days: number },
  today: string = todayIso(),
): Promise<LegClimate> {
  if (leg.startDate === null || !isCalendarDate(leg.startDate)) return NOTHING;
  const ahead = daysBetween(today, leg.startDate);
  // Inside the fortnight the forecast owns the question, and behind us
  // there is nothing to prepare for at all.
  if (ahead <= FORECAST_HORIZON_DAYS) return NOTHING;

  const month = Number(leg.startDate.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) return NOTHING;

  try {
    const normal = await cachedNormal(leg.anchor, month);
    const precautions = precautionsFor(normal, leg.days);
    const index = bufferDayIndex(leg.days, precautions.bufferDays);
    return {
      precautions,
      month,
      bufferDay: index === null ? null : { dayIndex: index, reason: precautions.reasons.join(" ") },
    };
  } catch (err) {
    // Optional by nature: a trip is worth more than an average.
    log.warn("climate normal unavailable, planning without precautions", {
      reason: err instanceof Error ? err.message : String(err),
      month,
    });
    return NOTHING;
  }
}
