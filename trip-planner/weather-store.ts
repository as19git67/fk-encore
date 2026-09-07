/**
 * Reading and writing the cached forecast (§7.2).
 *
 * Plain reads and writes; the decisions live in `weather-service.ts`
 * next door. Keyed on the rounded coordinate and the day, which is
 * both the privacy rule and the reason the cache hits: everybody in
 * the same city asks the same question.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import dbDefault from "../db/database";
import { weatherForecastCache } from "../db/schema";
import type { ForecastHour } from "./weather";

type Db = typeof dbDefault;

export interface CachedDay {
  day: string;
  hours: ForecastHour[];
  fetchedAt: string;
}

/** Everything already known about these days at this rounded place. */
export async function readForecast(
  lat: number,
  lon: number,
  days: readonly string[],
  db: Db = dbDefault,
): Promise<Map<string, CachedDay>> {
  if (days.length === 0) return new Map();
  const rows = await db
    .select()
    .from(weatherForecastCache)
    .where(and(
      eq(weatherForecastCache.lat, lat),
      eq(weatherForecastCache.lon, lon),
      inArray(weatherForecastCache.day, [...days]),
    ));

  const byDay = new Map<string, CachedDay>();
  for (const row of rows) {
    byDay.set(row.day, {
      day: row.day,
      hours: (row.hours ?? []) as ForecastHour[],
      fetchedAt: row.fetched_at,
    });
  }
  return byDay;
}

/**
 * Store what was fetched, replacing whatever was there.
 *
 * An upsert rather than an insert: a forecast is a statement about the
 * future that gets better, and the newer one is always the one worth
 * keeping.
 *
 * `fetchedAt` is passed rather than defaulted to `now()` in the
 * database, so that the clock deciding what is stale and the clock
 * stamping the row are the same one. Two clocks disagreeing by a few
 * hours is how a cache quietly stops refreshing.
 */
export async function writeForecast(
  lat: number,
  lon: number,
  days: ReadonlyMap<string, ForecastHour[]>,
  fetchedAt: string = new Date().toISOString(),
  db: Db = dbDefault,
): Promise<void> {
  for (const [day, hours] of days) {
    await db
      .insert(weatherForecastCache)
      .values({ lat, lon, day, hours, fetched_at: fetchedAt })
      .onConflictDoUpdate({
        target: [weatherForecastCache.lat, weatherForecastCache.lon, weatherForecastCache.day],
        set: { hours, fetched_at: fetchedAt },
      });
  }
}

/**
 * Drop forecasts for days that have passed.
 *
 * A forecast for last Tuesday answers nothing anybody will ask again,
 * and the table would otherwise grow for the life of the installation.
 */
export async function forgetForecastsBefore(
  day: string,
  db: Db = dbDefault,
): Promise<number> {
  const dropped = await db
    .delete(weatherForecastCache)
    .where(lt(weatherForecastCache.day, day))
    .returning({ id: weatherForecastCache.id });
  return dropped.length;
}
