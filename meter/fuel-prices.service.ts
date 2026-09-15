/**
 * Petrol prices from the EU Weekly Oil Bulletin.
 *
 * The comparison report (electric car vs. petrol car) values each bucket with
 * the `petrol_price` in force in that bucket's months. This fills those rows
 * the same way `degree-days.service.ts` fills the degree days: one row per
 * calendar month, `valid_from` = first of the month, unit `eur_per_l`, and a
 * `source` that records where the figure came from. Rows that are already
 * there — imported, hand-entered, or from an earlier fetch — are left alone,
 * so the fetch is idempotent and a correction survives it.
 *
 * What the figure is, so the report does not claim more than it knows: the
 * national average pump price for Euro-super 95 including all duties and
 * taxes, averaged over the weeks of the month. It is not what this household
 * paid at its own station — that is why a hand-entered row always wins.
 */

import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { meters, meterDevices, meterReadings } from "../db/schema";
import { listMeters } from "./meter.service";
import { importTariffEntries, listElectricityTariffs } from "./tariffs.service";
import {
  getOilBulletinClient,
  type BulletinFuel,
  type WeeklyFuelPrice,
} from "./oil-bulletin-client";

/**
 * The bulletin's country column to read. The household's home location does
 * not carry a country, and this application is used in Germany; a different
 * country is a one-constant change, not a setting worth a UI.
 */
export const BULLETIN_COUNTRY = "DE";
export const BULLETIN_FUEL: BulletinFuel = "euro95";
/**
 * A month needs this many surveyed weeks before its average is written. Two
 * weeks of a volatile month is not a monthly average, and the current month
 * is always short — this is what keeps it out.
 */
export const MIN_WEEKS_PER_MONTH = 3;

export interface MonthlyFuelPrice {
  /** `YYYY-MM` */
  month: string;
  eurPerLitre: number;
  /** Surveyed weeks the average rests on. */
  weeks: number;
}

export interface FuelPriceFillResult {
  /** `YYYY-MM` range that was considered, null when there is nothing to fill. */
  from: string | null;
  to: string | null;
  monthsMissing: number;
  monthsWritten: number;
  /** Months the bulletin has not published enough weeks for yet. */
  monthsIncomplete: number;
}

/**
 * Pure: monthly averages from the weekly survey. A week is counted towards
 * the month it was surveyed in; months with too few weeks are dropped rather
 * than averaged from a fragment.
 */
export function computeMonthlyFuelPrices(weeks: WeeklyFuelPrice[]): MonthlyFuelPrice[] {
  const byMonth = new Map<string, number[]>();
  for (const { week, eurPerLitre } of weeks) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) continue;
    const month = week.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), eurPerLitre]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, values]) => values.length >= MIN_WEEKS_PER_MONTH)
    .map(([month, values]): MonthlyFuelPrice => ({
      month,
      // Three decimals: fuel is priced to the tenth of a cent.
      eurPerLitre: Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 1000) / 1000,
      weeks: values.length,
    }));
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

/** Month of the earliest reading on the wallbox meter — before that there is nothing to compare. */
async function firstChargingMonth(userId: number): Promise<string | null> {
  const meter = (await listMeters(userId)).find((m) => m.role === "ev_charger_total");
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

/** The bulletin's monthly series, fetched once and shared by every household. */
export async function loadMonthlyFuelPrices(): Promise<MonthlyFuelPrice[]> {
  const weeks = await getOilBulletinClient().weeklyPrices(BULLETIN_COUNTRY, BULLETIN_FUEL);
  return computeMonthlyFuelPrices(weeks);
}

/**
 * Fetch and store the petrol price for every month between the first charging
 * reading and the last month the bulletin has published in full that has no
 * row yet. A household without a wallbox meter simply has nothing to do.
 *
 * `monthly` lets the job hand the same series to every household instead of
 * downloading the workbook once per user.
 */
export async function fillPetrolPricesForUser(
  userId: number,
  monthly?: MonthlyFuelPrice[],
): Promise<FuelPriceFillResult> {
  const empty: FuelPriceFillResult = {
    from: null,
    to: null,
    monthsMissing: 0,
    monthsWritten: 0,
    monthsIncomplete: 0,
  };

  const from = await firstChargingMonth(userId);
  if (!from) return empty;

  const existing = new Set<string>();
  for (const row of await listElectricityTariffs(userId)) {
    if (row.kind !== "petrol_price") continue;
    const date = new Date(row.validFrom);
    existing.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  const series = monthly ?? (await loadMonthlyFuelPrices());
  const last = series[series.length - 1];
  if (!last) return { ...empty, from };
  const to = last.month;
  if (from > to) return { ...empty, from, to };

  const wanted = monthRange(from, to);
  const missing = wanted.filter((month) => !existing.has(month));
  if (missing.length === 0) return { ...empty, from, to };

  const complete = new Map(series.map((row) => [row.month, row]));
  const fetchedAt = new Date().toISOString();
  const entries = missing
    .map((month) => complete.get(month))
    .filter((row): row is MonthlyFuelPrice => row !== undefined)
    .map((row) => ({
      kind: "petrol_price",
      validFrom: `${row.month}-01`,
      amount: row.eurPerLitre,
      unit: "eur_per_l",
      source: {
        provider: "eu-weekly-oil-bulletin",
        country: BULLETIN_COUNTRY,
        fuel: BULLETIN_FUEL,
        weeks: row.weeks,
        fetchedAt,
      },
    }));

  let incomplete = missing.length - entries.length;
  let written = 0;
  if (entries.length > 0) {
    const result = await importTariffEntries(userId, entries);
    written = result.created + result.updated;
    incomplete += result.failed;
  }

  return {
    from,
    to,
    monthsMissing: missing.length,
    monthsWritten: written,
    monthsIncomplete: incomplete,
  };
}

/** Households that own a wallbox meter — the job's audience, nobody else. */
export async function userIdsWithChargingMeter(): Promise<number[]> {
  const rows = await dbAll<{ owner_user_id: number }>(
    db
      .selectDistinct({ owner_user_id: meters.owner_user_id })
      .from(meters)
      .where(eq(meters.role, "ev_charger_total")),
  );
  return rows.map((row) => row.owner_user_id);
}
