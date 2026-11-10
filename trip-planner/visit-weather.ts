/**
 * The weather at a visit (reise-planen-und-unterwegs.md, stage 5).
 *
 * Taken once, when a visit is recorded, from the forecast the planner
 * already caches for the place, and kept on the visit row: a day
 * afterwards the forecast for it is gone (`forgetForecastsBefore`),
 * and "it was sunny at the tower" is what the diary wants to say.
 *
 * Only the rounded place goes out, as for every forecast (§7.2), and
 * nothing is looked up for a visit further back than the forecast
 * reaches: there is no forecast for yesterday.
 */

import log from "encore.dev/log";
import type { ForecastHour } from "./weather";
import { forecastFor } from "./weather-service";

export interface VisitWeather {
  temperatureC: number;
  precipitationMm: number;
  /** Percent of the sky. */
  cloudCover: number;
}

/** An hour further away than this from the arrival says nothing about it. */
const NEAREST_HOUR_MS = 90 * 60_000;

/** The hour nearest to `at`, or null when none is close enough. */
export function weatherAt(hours: readonly ForecastHour[], at: Date): VisitWeather | null {
  let best: ForecastHour | null = null;
  let distance = Infinity;
  for (const hour of hours) {
    const d = Math.abs(Date.parse(hour.time) - at.getTime());
    if (Number.isFinite(d) && d < distance) {
      best = hour;
      distance = d;
    }
  }
  if (!best || distance > NEAREST_HOUR_MS) return null;
  return {
    temperatureC: best.temperatureC,
    precipitationMm: best.precipitationMm,
    cloudCover: best.cloudCover,
  };
}

/**
 * The weather at `arrivedAt` around a place, or null when there is no
 * forecast for it. Never throws: a visit is recorded with or without.
 *
 * `TRIP_VISIT_WEATHER=0` turns it off (the test suite does, so that a
 * visit recorded "now" does not ask Open-Meteo).
 */
export async function visitWeather(
  at: { lat: number; lon: number },
  arrivedAt: Date,
  now: Date = new Date(),
): Promise<VisitWeather | null> {
  if (process.env.TRIP_VISIT_WEATHER === "0") return null;
  const day = arrivedAt.toISOString().slice(0, 10);
  try {
    const { byDay } = await forecastFor(at, [day], now);
    return weatherAt(byDay.get(day) ?? [], arrivedAt);
  } catch (err) {
    log.info("trip visit: no weather for the visit", { reason: String(err) });
    return null;
  }
}
