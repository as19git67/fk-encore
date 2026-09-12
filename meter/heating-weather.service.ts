/**
 * Utility meters — weather-adjusted heating consumption (Issue #792,
 * report C3 / #1023).
 *
 * "More heating electricity than last year" is, more often than not, only
 * "a colder winter". The raw trend cannot tell the two apart; this report
 * divides the monthly heating consumption by the heating degree days of that
 * month, so the remaining figure — kWh per degree day — describes the house
 * and its heating system, not the weather.
 *
 * Two sources for the reference, chosen by what the household has entered:
 *
 *  - **`degree_days`** — a monthly degree-day series (VDI 2067 style, for a
 *    nearby station) stored as assumption rows of kind `heating_degree_days`
 *    (one per month, `valid_from` = first of the month, unit `kd`), typically
 *    loaded through the tariff file import. Every month with both a measured
 *    consumption and a degree-day value yields kWh/Kd, and the consumption is
 *    normalised to a *normal* month (multi-year mean of that month's degree
 *    days) — the weather-adjusted value.
 *  - **`estimated`** — without any degree-day rows the reference winter is
 *    estimated from the household's own history: the multi-year mean of each
 *    calendar month. That cannot remove the weather (it has no weather data),
 *    but it does show how far a month deviates from what is typical for this
 *    house, which is the honest fallback. The report labels the mode so the
 *    UI can say which one it is.
 */

import { APIError } from "encore.dev/api";
import { listMeters } from "./meter.service";
import {
  getMeterReportForUser,
  COMPLETE_COVERAGE_THRESHOLD,
  type MeterReportBucket,
} from "./reports.service";
import { listElectricityTariffs } from "./tariffs.service";
import { linearRegressionSlopeOverTime } from "./trends.service";

export type HeatingReferenceSource = "degree_days" | "estimated";

/** Minimum years a calendar month must be measured before its mean counts as "typical". */
const MIN_REFERENCE_YEARS = 2;

export interface HeatingWeatherBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Measured heating consumption; null when the month is not fully measured. */
  heatingKwh: number | null;
  /** Degree days of that month from the series; null without a row or in `estimated` mode. */
  degreeDays: number | null;
  kwhPerDegreeDay: number | null;
  /**
   * Consumption normalised to a normal month (kWh/Kd × normal degree days of
   * that calendar month). Only in `degree_days` mode.
   */
  adjustedKwh: number | null;
  /** Multi-year mean of this calendar month (of adjustedKwh in `degree_days` mode, else raw). */
  typicalKwh: number | null;
  /** (adjusted ?? raw − typical) / typical. */
  deviationPercent: number | null;
}

export interface HeatingWeatherYear {
  year: number;
  measuredMonths: number;
  heatingKwh: number | null;
  degreeDays: number | null;
  kwhPerDegreeDay: number | null;
  adjustedKwh: number | null;
}

export interface HeatingWeatherReport {
  meterId: number | null;
  meterName: string | null;
  unit: string;
  source: HeatingReferenceSource | null;
  /** Number of measured months that also had a degree-day value. */
  degreeDayMonths: number;
  /** Multi-year mean of the degree days per calendar month, index 0 = January (`degree_days` only). */
  normalDegreeDays: Array<number | null>;
  /** Multi-year mean consumption per calendar month, index 0 = January. */
  typicalKwh: Array<number | null>;
  /** Years the typical profile is built from. */
  referenceYears: number;
  buckets: HeatingWeatherBucket[];
  years: HeatingWeatherYear[];
  /** kWh per degree day of the latest year with a full twelve months, and the year before. */
  latestKwhPerDegreeDay: number | null;
  previousKwhPerDegreeDay: number | null;
  changePercent: number | null;
  slopePerYear: number | null;
}

function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function ratio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function monthIndexOf(key: string): number {
  return Number(key.split("-")[1]) - 1;
}

function yearOf(key: string): number {
  return Number(key.split("-")[0]);
}

/**
 * Pure core: monthly heating buckets plus an optional degree-day map keyed
 * `YYYY-MM`. An empty map selects the `estimated` mode.
 */
export function buildHeatingWeatherReport(
  meter: { id: number; name: string; unit: string } | null,
  buckets: MeterReportBucket[],
  degreeDaysByMonth: Map<string, number>,
): HeatingWeatherReport {
  const empty: HeatingWeatherReport = {
    meterId: meter?.id ?? null,
    meterName: meter?.name ?? null,
    unit: meter?.unit ?? "kWh",
    source: null,
    degreeDayMonths: 0,
    normalDegreeDays: new Array(12).fill(null),
    typicalKwh: new Array(12).fill(null),
    referenceYears: 0,
    buckets: [],
    years: [],
    latestKwhPerDegreeDay: null,
    previousKwhPerDegreeDay: null,
    changePercent: null,
    slopePerYear: null,
  };
  if (!meter) return empty;

  const measured = buckets.filter(
    (bucket) => bucket.coverage >= COMPLETE_COVERAGE_THRESHOLD && /^\d{4}-\d{2}$/.test(bucket.key),
  );
  if (measured.length === 0) return empty;

  const withDegreeDays = measured.filter((bucket) => degreeDaysByMonth.has(bucket.key));
  const source: HeatingReferenceSource = withDegreeDays.length > 0 ? "degree_days" : "estimated";

  // Normal degree days per calendar month — the multi-year mean of the
  // series, over every month it covers (not only the measured ones).
  const normalDegreeDays: Array<number | null> = new Array(12).fill(null);
  if (source === "degree_days") {
    const byMonth: number[][] = Array.from({ length: 12 }, () => []);
    for (const [key, value] of degreeDaysByMonth) {
      if (/^\d{4}-\d{2}$/.test(key)) byMonth[monthIndexOf(key)].push(value);
    }
    byMonth.forEach((values, month) => {
      normalDegreeDays[month] = round(mean(values), 1);
    });
  }

  // First pass: per-bucket figures without the typical comparison.
  const partial = measured.map((bucket) => {
    const month = monthIndexOf(bucket.key);
    const degreeDays = source === "degree_days" ? (degreeDaysByMonth.get(bucket.key) ?? null) : null;
    const kwhPerDegreeDay =
      degreeDays !== null && degreeDays > 0 ? bucket.consumption / degreeDays : null;
    const normal = normalDegreeDays[month];
    const adjustedKwh =
      kwhPerDegreeDay !== null && normal !== null ? kwhPerDegreeDay * normal : null;
    return { bucket, month, degreeDays, kwhPerDegreeDay, adjustedKwh };
  });

  // Typical profile: mean per calendar month of the comparable value.
  const comparable = (entry: (typeof partial)[number]): number | null =>
    source === "degree_days" ? entry.adjustedKwh : entry.bucket.consumption;
  const typicalSamples: number[][] = Array.from({ length: 12 }, () => []);
  const referenceYearSet = new Set<number>();
  for (const entry of partial) {
    const value = comparable(entry);
    if (value === null) continue;
    typicalSamples[entry.month].push(value);
    referenceYearSet.add(yearOf(entry.bucket.key));
  }
  const typicalKwh: Array<number | null> = typicalSamples.map((values) =>
    values.length >= MIN_REFERENCE_YEARS ? round(mean(values), 1) : null,
  );

  const resultBuckets = partial.map((entry): HeatingWeatherBucket => {
    const typical = typicalKwh[entry.month];
    const value = comparable(entry);
    return {
      key: entry.bucket.key,
      label: entry.bucket.label,
      periodStart: entry.bucket.periodStart,
      periodEnd: entry.bucket.periodEnd,
      heatingKwh: entry.bucket.consumption,
      degreeDays: entry.degreeDays,
      kwhPerDegreeDay: round(entry.kwhPerDegreeDay, 3),
      adjustedKwh: round(entry.adjustedKwh, 1),
      typicalKwh: typical,
      deviationPercent:
        typical !== null && typical > 0 && value !== null
          ? ratio((value - typical) / typical)
          : null,
    };
  });

  // Yearly roll-up. kWh per degree day of a year is the ratio of the sums,
  // not the mean of the monthly ratios — summer months with a handful of
  // degree days would otherwise dominate.
  const byYear = new Map<number, HeatingWeatherBucket[]>();
  for (const bucket of resultBuckets) {
    const year = yearOf(bucket.key);
    byYear.set(year, [...(byYear.get(year) ?? []), bucket]);
  }
  const yearStats = [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, rows]) => {
      const heating = rows.reduce((sum, row) => sum + (row.heatingKwh ?? 0), 0);
      const ddRows = rows.filter((row) => row.degreeDays !== null && row.adjustedKwh !== null);
      const degreeDays =
        ddRows.length === rows.length && rows.length > 0
          ? ddRows.reduce((sum, row) => sum + (row.degreeDays ?? 0), 0)
          : null;
      const adjusted =
        degreeDays !== null ? ddRows.reduce((sum, row) => sum + (row.adjustedKwh ?? 0), 0) : null;
      const kwhPerDegreeDay = degreeDays !== null && degreeDays > 0 ? heating / degreeDays : null;
      return { year, measuredMonths: rows.length, heating, degreeDays, adjusted, kwhPerDegreeDay };
    });
  const years = yearStats.map(
    (stat): HeatingWeatherYear => ({
      year: stat.year,
      measuredMonths: stat.measuredMonths,
      heatingKwh: round(stat.heating, 1),
      degreeDays: round(stat.degreeDays, 1),
      kwhPerDegreeDay: round(stat.kwhPerDegreeDay, 3),
      adjustedKwh: round(stat.adjusted, 1),
    }),
  );

  // Trend over full years only; the change is taken from the unrounded
  // ratios so two equal years do not drift apart through rounding.
  const fullYears = yearStats.filter(
    (stat) => stat.measuredMonths === 12 && stat.kwhPerDegreeDay !== null,
  );
  const latest = fullYears[fullYears.length - 1] ?? null;
  const previous = fullYears[fullYears.length - 2] ?? null;
  // Regression over calendar time, so a year without full measurement does
  // not get squeezed out of the axis.
  const series = fullYears.map((stat) => ({
    x: stat.year,
    y: stat.kwhPerDegreeDay as number,
  }));

  return {
    meterId: meter.id,
    meterName: meter.name,
    unit: meter.unit,
    source,
    degreeDayMonths: withDegreeDays.length,
    normalDegreeDays,
    typicalKwh,
    referenceYears: referenceYearSet.size,
    buckets: resultBuckets,
    years,
    latestKwhPerDegreeDay: round(latest?.kwhPerDegreeDay ?? null, 3),
    previousKwhPerDegreeDay: round(previous?.kwhPerDegreeDay ?? null, 3),
    changePercent:
      latest && previous && previous.kwhPerDegreeDay
        ? ratio(((latest.kwhPerDegreeDay ?? 0) - previous.kwhPerDegreeDay) / previous.kwhPerDegreeDay)
        : null,
    slopePerYear: round(linearRegressionSlopeOverTime(series, 3), 4),
  };
}

/** Degree-day rows of the user as a `YYYY-MM` → Kd map. */
export async function loadDegreeDaysByMonth(userId: number): Promise<Map<string, number>> {
  const rows = await listElectricityTariffs(userId);
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "heating_degree_days") continue;
    const date = new Date(row.validFrom);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    map.set(key, row.amount);
  }
  return map;
}

export async function getHeatingWeatherReportForUser(
  userId: number,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<HeatingWeatherReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }
  const visible = await listMeters(userId);
  // Heating-only meter first; the whole heat pump (heating + hot water) is
  // still mostly weather-driven and serves as the fallback.
  const meter =
    visible.find((m) => m.role === "heat_heating_total") ??
    visible.find((m) => m.role === "heat_pump_total") ??
    null;
  if (!meter) return buildHeatingWeatherReport(null, [], new Map());

  const report = await getMeterReportForUser(userId, meter.id, "month", fromDate, toDate);
  const degreeDays = await loadDegreeDaysByMonth(userId);
  return buildHeatingWeatherReport(
    { id: meter.id, name: meter.name, unit: meter.unit },
    report.buckets,
    degreeDays,
  );
}
