/**
 * The forecast for a place and a stretch of days, cached (§7.2).
 *
 * Three rules, and each one is about not asking:
 *
 *   - **Once per day per place.** A city forecast does not change
 *     between two people opening the same trip. A cached day is reused
 *     until it is stale.
 *   - **Stale is six hours.** Long enough that a day of planning costs
 *     one request, short enough that "rain this afternoon" is not
 *     yesterday's opinion. Today is refreshed sooner than the rest,
 *     because a forecast for the day you are standing in is the one
 *     that changes and the one that matters.
 *   - **Beyond the horizon there is nothing.** Open-Meteo answers about
 *     sixteen days ahead. For a trip further out §7.2 wants climate
 *     normals, which are a different question to a different endpoint;
 *     until that exists the honest answer is no data rather than an
 *     invented average.
 *
 * Failure is never fatal. A plan is still a plan in the rain, and one
 * that refuses to open because a third party is down would be worse
 * than no weather at all.
 */

import log from "encore.dev/log";
import { addDays, daysBetween, isCalendarDate } from "./leg-dates";
import type { ForecastHour } from "./weather";
import {
  FORECAST_HORIZON_DAYS,
  getClimateClient,
  getWeatherClient,
  roundToGrid,
  WeatherUnavailableError,
} from "./weather-client";
import { readForecast, writeForecast } from "./weather-store";

/** How old a cached day may be before it is asked again. */
const STALE_MS = 6 * 60 * 60 * 1000;
/** The day you are standing in changes; ask more often. */
const STALE_TODAY_MS = 60 * 60 * 1000;

export interface ForecastDays {
  /** Hours per day, keyed by `YYYY-MM-DD`. Missing days are absent. */
  byDay: Map<string, ForecastHour[]>;
  /**
   * True when the fetch failed and what is here came from the cache
   * alone (possibly nothing). Reported so the screen can say "no
   * forecast" rather than "dry".
   */
  degraded: boolean;
}

/**
 * Hourly weather for `days` around a coordinate.
 *
 * The coordinate is rounded before anything else happens, so the
 * cache, the request and the privacy rule all use the same value.
 */
export async function forecastFor(
  at: { lat: number; lon: number },
  days: readonly string[],
  now: Date = new Date(),
): Promise<ForecastDays> {
  const lat = roundToGrid(at.lat);
  const lon = roundToGrid(at.lon);
  const today = toIsoDay(now);

  const wanted = days
    .filter((day) => isCalendarDate(day))
    .filter((day) => withinHorizon(day, today))
    .sort();
  if (wanted.length === 0) return { byDay: new Map(), degraded: false };

  const cached = await readForecast(lat, lon, wanted);
  const byDay = new Map<string, ForecastHour[]>();
  const missing: string[] = [];
  for (const day of wanted) {
    const hit = cached.get(day);
    if (hit && !isStale(hit.fetchedAt, day, today, now)) {
      byDay.set(day, hit.hours);
    } else {
      missing.push(day);
      // Kept as the fallback: a stale forecast beats none if the
      // fetch below fails.
      if (hit) byDay.set(day, hit.hours);
    }
  }
  if (missing.length === 0) return { byDay, degraded: false };

  // One request for the whole span, even when the gaps are scattered:
  // the API charges the same for a range as for a day, and a loop
  // would turn a two-week trip into fourteen requests.
  try {
    const forecast = await getWeatherClient()
      .forecast(lat, lon, missing[0], missing[missing.length - 1]);
    const fetched = groupByDay(forecast.hours);
    for (const [day, hours] of fetched) {
      if (wanted.includes(day)) byDay.set(day, hours);
    }
    await writeForecast(lat, lon, fetched, now.toISOString());
    return { byDay, degraded: false };
  } catch (err) {
    if (!(err instanceof WeatherUnavailableError)) throw err;
    log.info("weather: forecast unavailable, carrying on without it", {
      reason: err.message,
      days: missing.length,
    });
    return { byDay, degraded: true };
  }
}

function withinHorizon(day: string, today: string): boolean {
  const ahead = daysBetween(today, day);
  // Yesterday is not a forecast, and neither is next year.
  return ahead >= 0 && ahead <= FORECAST_HORIZON_DAYS;
}

function isStale(fetchedAt: string, day: string, today: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(fetchedAt);
  if (!Number.isFinite(age)) return true;
  return age > (day === today ? STALE_TODAY_MS : STALE_MS);
}

/**
 * Split the hours into days by their UTC date.
 *
 * Deliberately UTC and not the destination's clock: this is only how
 * the cache is filed. Which hours belong to which block is decided
 * later, where the offset is known (`hoursWithin`).
 */
function groupByDay(hours: readonly ForecastHour[]): Map<string, ForecastHour[]> {
  const byDay = new Map<string, ForecastHour[]>();
  for (const hour of hours) {
    const day = hour.time.slice(0, 10);
    if (!isCalendarDate(day)) continue;
    const list = byDay.get(day) ?? [];
    list.push(hour);
    byDay.set(day, list);
  }
  return byDay;
}

function toIsoDay(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** The days a leg covers, from its start date. */
export function daysOfLeg(startDate: string, dayCount: number): string[] {
  return Array.from({ length: dayCount }, (_, i) => addDays(startDate, i));
}

/** Climate guidance for a trip that is still outside the forecast horizon. */
export async function climateNormalFor(
  at: { lat: number; lon: number },
  month: number,
) {
  return getClimateClient().normal(roundToGrid(at.lat), roundToGrid(at.lon), month);
}
