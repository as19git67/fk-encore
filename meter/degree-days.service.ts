/**
 * Heating degree days from the Open-Meteo archive (#1023 follow-up).
 *
 * The weather-adjusted heating report reads `heating_degree_days` assumption
 * rows. Instead of asking the household to import a table, this fills those
 * rows from the daily mean temperatures of the household's home coordinate:
 *
 *   G = Σ over heating days (20 °C − T_mean),  heating day: T_mean < 15 °C
 *
 * — the VDI 2067 / German convention (`HEATING_BASE_C`, `HEATING_LIMIT_C`).
 * One row per month, `valid_from` = first of the month, unit `kd`, and a
 * `source` that says where it came from. Rows that are already there — an
 * imported series, a hand-entered value, or an earlier fetch — are left
 * alone, so the fetch is idempotent and a manual correction survives it.
 *
 * Range: from the month of the first reading on the heating meter (the
 * report has nothing to divide before that) to the last month that is
 * complete *and* already in the archive, which trails today by a few days.
 */

import { asc, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { meterDevices, meterHomeLocations, meterReadings } from "../db/schema";
import { roundToGrid } from "../trip-planner/weather-client";
import { listMeters } from "./meter.service";
import { importTariffEntries, listElectricityTariffs } from "./tariffs.service";
import {
  getArchiveClient,
  getGeocodingClient,
  type DailyMeanTemperature,
  type GeocodeCandidate,
} from "./open-meteo-client";

export const HEATING_BASE_C = 20;
export const HEATING_LIMIT_C = 15;
/** The archive publishes a day this many days after it; anything younger is not asked for. */
export const ARCHIVE_LAG_DAYS = 7;
/** A month with more missing days than this is not written — a gap must not look like a mild month. */
const MAX_MISSING_DAYS_PER_MONTH = 2;
const MAX_GEOCODE_RESULTS = 8;

const MS_PER_DAY = 86_400_000;

export interface HomeLocation {
  label: string;
  lat: number;
  lon: number;
  source: "geocoded" | "manual";
  updatedAt: string;
}

export interface MonthlyDegreeDays {
  /** `YYYY-MM` */
  month: string;
  degreeDays: number;
  heatingDays: number;
  /** Days of the month with a value. */
  daysWithData: number;
  daysInMonth: number;
}

export interface DegreeDaysFillResult {
  /** `YYYY-MM` range that was considered, null when there is nothing to fill. */
  from: string | null;
  to: string | null;
  monthsMissing: number;
  monthsWritten: number;
  /** Months the archive could not deliver completely (too fresh or gaps). */
  monthsIncomplete: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

/** Pure: monthly degree-day sums from daily means; incomplete months are dropped. */
export function computeMonthlyDegreeDays(days: DailyMeanTemperature[]): MonthlyDegreeDays[] {
  const byMonth = new Map<string, { sum: number; heating: number; withData: number }>();
  for (const { day, meanC } of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const key = monthKeyOf(day);
    const entry = byMonth.get(key) ?? { sum: 0, heating: 0, withData: 0 };
    if (meanC !== null) {
      entry.withData += 1;
      if (meanC < HEATING_LIMIT_C) {
        entry.heating += 1;
        entry.sum += HEATING_BASE_C - meanC;
      }
    }
    byMonth.set(key, entry);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, entry]): MonthlyDegreeDays => {
      const [year, m] = month.split("-").map(Number);
      return {
        month,
        degreeDays: Math.round(entry.sum * 10) / 10,
        heatingDays: entry.heating,
        daysWithData: entry.withData,
        daysInMonth: daysInMonth(year, m),
      };
    })
    .filter((row) => row.daysInMonth - row.daysWithData <= MAX_MISSING_DAYS_PER_MONTH);
}

/** Months `YYYY-MM` from `from` to `to` inclusive. */
export function monthRange(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const months: string[] = [];
  for (let index = fy * 12 + (fm - 1); index <= ty * 12 + (tm - 1); index++) {
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

/** Last month that ended at least ARCHIVE_LAG_DAYS before `now`. */
export function lastArchivedMonth(now: Date): string {
  const cutoff = new Date(now.getTime() - ARCHIVE_LAG_DAYS * MS_PER_DAY);
  // The month before the cutoff's month is the last one that is complete.
  const previous = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Home location ───────────────────────────────────────────────────────────

function mapHome(row: typeof meterHomeLocations.$inferSelect): HomeLocation {
  return { label: row.label, lat: row.lat, lon: row.lon, source: row.source, updatedAt: row.updated_at };
}

export async function getHomeLocation(userId: number): Promise<HomeLocation | null> {
  const row = await dbFirst<typeof meterHomeLocations.$inferSelect>(
    db.select().from(meterHomeLocations).where(eq(meterHomeLocations.user_id, userId)),
  );
  return row ? mapHome(row) : null;
}

export async function setHomeLocation(
  userId: number,
  input: { label: string; lat: number; lon: number; source: "geocoded" | "manual" },
): Promise<HomeLocation> {
  const label = input.label.trim();
  if (!label) throw APIError.invalidArgument("label must not be empty");
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
    throw APIError.invalidArgument("lat must be between -90 and 90");
  }
  if (!Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180) {
    throw APIError.invalidArgument("lon must be between -180 and 180");
  }
  const values = {
    label,
    lat: roundToGrid(input.lat),
    lon: roundToGrid(input.lon),
    source: input.source,
    updated_at: new Date().toISOString(),
  };
  const [row] = await db
    .insert(meterHomeLocations)
    .values({ user_id: userId, ...values })
    .onConflictDoUpdate({ target: meterHomeLocations.user_id, set: values })
    .returning();
  return mapHome(row);
}

export async function deleteHomeLocation(userId: number): Promise<void> {
  await db.delete(meterHomeLocations).where(eq(meterHomeLocations.user_id, userId));
}

export async function searchPlaces(query: string): Promise<GeocodeCandidate[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) throw APIError.invalidArgument("query must have at least two characters");
  return await getGeocodingClient().search(trimmed, MAX_GEOCODE_RESULTS);
}

// ── Fill ────────────────────────────────────────────────────────────────────

/** Month of the earliest reading on the household's heating meter, or null. */
async function firstHeatingMonth(userId: number): Promise<string | null> {
  const visible = await listMeters(userId);
  const meter =
    visible.find((m) => m.role === "heat_heating_total") ??
    visible.find((m) => m.role === "heat_pump_total");
  if (!meter) return null;
  const row = await dbFirst<{ taken_at: string }>(
    db
      .select({ taken_at: meterReadings.taken_at })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
      .where(eq(meterDevices.meter_id, meter.id))
      .orderBy(asc(meterReadings.taken_at))
      .limit(1),
  );
  if (!row) return null;
  const date = new Date(row.taken_at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Fetch and store the degree days every month between the first heating
 * reading and the last archived month that has no row yet. Requires a home
 * location; a missing heating meter simply yields nothing to do.
 */
export async function fillDegreeDaysForUser(
  userId: number,
  now: Date = new Date(),
): Promise<DegreeDaysFillResult> {
  const home = await getHomeLocation(userId);
  if (!home) {
    throw APIError.failedPrecondition("no home location set — choose a place first");
  }
  const empty: DegreeDaysFillResult = {
    from: null,
    to: null,
    monthsMissing: 0,
    monthsWritten: 0,
    monthsIncomplete: 0,
  };

  const from = await firstHeatingMonth(userId);
  const to = lastArchivedMonth(now);
  if (!from || from > to) return empty;

  const existing = new Set<string>();
  for (const row of await listElectricityTariffs(userId)) {
    if (row.kind !== "heating_degree_days") continue;
    const date = new Date(row.validFrom);
    existing.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const missing = monthRange(from, to).filter((month) => !existing.has(month));
  if (missing.length === 0) return { ...empty, from, to };

  // One archive call per calendar year that has a gap — the API takes any
  // span, but a year keeps a single answer small and a failure local.
  const byYear = new Map<number, string[]>();
  for (const month of missing) {
    const year = Number(month.slice(0, 4));
    byYear.set(year, [...(byYear.get(year) ?? []), month]);
  }

  const client = getArchiveClient();
  const fetchedAt = new Date().toISOString();
  let written = 0;
  let incomplete = 0;
  for (const [, months] of [...byYear.entries()].sort(([a], [b]) => a - b)) {
    const first = months[0];
    const last = months[months.length - 1];
    const [ly, lm] = last.split("-").map(Number);
    const days = await client.dailyMeanTemperature(
      home.lat,
      home.lon,
      `${first}-01`,
      `${last}-${String(daysInMonth(ly, lm)).padStart(2, "0")}`,
    );
    const complete = new Map(computeMonthlyDegreeDays(days).map((row) => [row.month, row]));
    const entries = months
      .map((month) => complete.get(month))
      .filter((row): row is MonthlyDegreeDays => row !== undefined)
      .map((row) => ({
        kind: "heating_degree_days",
        validFrom: `${row.month}-01`,
        amount: row.degreeDays,
        unit: "kd",
        source: {
          provider: "open-meteo-archive",
          lat: home.lat,
          lon: home.lon,
          heatingDays: row.heatingDays,
          daysWithData: row.daysWithData,
          fetchedAt,
        },
      }));
    incomplete += months.length - entries.length;
    if (entries.length === 0) continue;
    const result = await importTariffEntries(userId, entries);
    written += result.created + result.updated;
    incomplete += result.failed;
  }

  return { from, to, monthsMissing: missing.length, monthsWritten: written, monthsIncomplete: incomplete };
}

/** Every household with a home location — the daily job's audience. */
export async function userIdsWithHomeLocation(): Promise<number[]> {
  const rows = await dbAll<{ user_id: number }>(
    db.select({ user_id: meterHomeLocations.user_id }).from(meterHomeLocations),
  );
  return rows.map((row) => row.user_id);
}

