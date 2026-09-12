import { APIError } from "encore.dev/api";
import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { meterDevices, meterReadings } from "../db/schema";
import { listMeters, loadDeviceOffsets, loadVisibleMeter, type MeterListItem } from "./meter.service";
import {
  EnergyTariffTimeline,
  loadEnergyTariffTimeline,
  sumCostResults,
  type EnergyTariffCostResult,
} from "./tariffs.service";

export type ReportGranularity = "day" | "week" | "month" | "year";

export const REPORT_GRANULARITIES: readonly ReportGranularity[] = ["day", "week", "month", "year"];

/**
 * How an interval between two readings is charged to report buckets.
 *
 * - `interpolated` (default) spreads it over the buckets it overlaps, weighted
 *   by time. A reading on the 3rd and the next on the 5th of the following
 *   month therefore no longer pushes half a month into the earlier bucket.
 * - `interval_start` charges the whole interval to the bucket its *start*
 *   falls into. That is the original Excel logic and stays available so old
 *   figures remain reproducible.
 */
export type BucketAllocation = "interpolated" | "interval_start";

/**
 * Coverage from which a bucket counts as fully measured. Readings rarely land
 * exactly on a period boundary, so a month covered to 99% is treated as
 * complete; anything below is a partial period and excluded from comparisons.
 */
export const COMPLETE_COVERAGE_THRESHOLD = 0.99;

export interface AbsoluteReadingPoint {
  takenAt: string;
  value: number;
}

export interface MeterReportBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  startReadingAt: string;
  endReadingAt: string;
  startValue: number;
  endValue: number;
  consumption: number;
  intervals: number;
  /** Share of the period actually spanned by readings, 0..1. */
  coverage: number;
  /**
   * Coverage-weighted mean length of the reading intervals behind this
   * period, in days. A month built from a single yearly reading has a
   * coverage of 1 but a mean interval of 365 — the value is interpolated,
   * not measured, and the UI can say so.
   */
  meanIntervalDays: number | null;
  /** Same period one year earlier; null unless both periods are fully covered. */
  previousConsumption: number | null;
  deltaAbsolute: number | null;
  /**
   * Relative change of the *daily rate*, so a leap-year February or a
   * 53-week year is not reported as a change in consumption.
   */
  deltaPercent: number | null;
}

export interface MeterReport {
  meterId: number;
  name: string;
  unit: string;
  decimals: number;
  granularity: ReportGranularity;
  allocation: BucketAllocation;
  from: string | null;
  to: string | null;
  buckets: MeterReportBucket[];
  totalConsumption: number;
}

export type EnergyReportRole =
  | "grid_import"
  | "grid_export"
  | "pv_production"
  | "heat_pump_total"
  | "heat_heating_total"
  | "heat_heating_pv"
  | "hot_water_total"
  | "hot_water_pv"
  | "ev_charger_total"
  | "ev_charger_pv";

export interface EnergyReportMeterRef {
  role: EnergyReportRole;
  meterId: number;
  name: string;
}

/** Data conditions the report clamps rather than fails on; the UI flags them. */
export type EnergyBucketWarning =
  /** More exported than produced — usually readings taken on different days. */
  | "export_exceeds_production"
  /** Heat pump + wallbox exceed the total — a sub-meter not fed from grid_import. */
  | "exclusion_exceeds_total";

export interface EnergyReportBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Lowest coverage among the contributing meters, 0..1. */
  coverage: number;
  /** Full PV set present and coverage at or above the threshold; only these feed `totals`. */
  complete: boolean;
  warnings: EnergyBucketWarning[];
  gridImport: number | null;
  gridExport: number | null;
  production: number | null;
  selfConsumption: number | null;
  totalConsumption: number | null;
  consumptionWithoutHeatPumpAndEv: number | null;
  autarky: number | null;
  selfConsumptionRate: number | null;
  heatPumpTotal: number | null;
  heatHeatingTotal: number | null;
  heatHeatingPv: number | null;
  heatHeatingGrid: number | null;
  heatHeatingPvShare: number | null;
  hotWaterTotal: number | null;
  hotWaterPv: number | null;
  hotWaterGrid: number | null;
  hotWaterPvShare: number | null;
  evChargerTotal: number | null;
  evChargerPv: number | null;
  evChargerGrid: number | null;
  evChargerPvShare: number | null;
  costs: EnergyTariffCostResult | null;
}

export interface EnergyReport {
  unit: string;
  decimals: number;
  granularity: ReportGranularity;
  allocation: BucketAllocation;
  from: string | null;
  to: string | null;
  meters: EnergyReportMeterRef[];
  missingRoles: EnergyReportRole[];
  /** Roles carried by more than one visible meter; only the first is used. */
  duplicateRoles: EnergyReportRole[];
  buckets: EnergyReportBucket[];
  totals: Omit<
    EnergyReportBucket,
    "key" | "label" | "periodStart" | "periodEnd" | "coverage" | "complete" | "warnings"
  >;
  hasTariffs: boolean;
}

export const ENERGY_REPORT_ROLES: EnergyReportRole[] = [
  "grid_import",
  "grid_export",
  "pv_production",
  "heat_pump_total",
  "heat_heating_total",
  "heat_heating_pv",
  "hot_water_total",
  "hot_water_pv",
  "ev_charger_total",
  "ev_charger_pv",
];

const REQUIRED_ENERGY_REPORT_ROLES: EnergyReportRole[] = [
  "grid_import",
  "grid_export",
  "pv_production",
];

export function parseReportBoundary(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument(`${field} is not a valid date`);
  }
  return date;
}

const MS_PER_DAY = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO-8601 week-year and week number of a UTC date (weeks start on Monday). */
function isoWeek(date: Date): { year: number; week: number } {
  const probe = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the same week; its year is the ISO week-year.
  const weekday = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - weekday);
  const year = probe.getUTCFullYear();
  const firstDay = Date.UTC(year, 0, 1);
  const week = Math.ceil(((probe.getTime() - firstDay) / MS_PER_DAY + 1) / 7);
  return { year, week };
}

/** Monday 00:00 UTC of ISO week `week` of ISO week-year `year`. */
function isoWeekStart(year: number, week: number): Date {
  // 4 January is always inside week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  const mondayOfWeek1 = new Date(jan4.getTime() - (weekday - 1) * MS_PER_DAY);
  return new Date(mondayOfWeek1.getTime() + (week - 1) * 7 * MS_PER_DAY);
}

/**
 * Bucket key of the period a timestamp falls into:
 * `YYYY` / `YYYY-MM` / `YYYY-Www` (ISO week) / `YYYY-MM-DD`.
 */
export function bucketKey(date: Date, granularity: ReportGranularity): string {
  const year = date.getUTCFullYear();
  switch (granularity) {
    case "year":
      return String(year);
    case "month":
      return `${year}-${pad2(date.getUTCMonth() + 1)}`;
    case "week": {
      const iso = isoWeek(date);
      return `${iso.year}-W${pad2(iso.week)}`;
    }
    case "day":
      return `${year}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
}

export function bucketLabel(key: string, granularity: ReportGranularity): string {
  switch (granularity) {
    case "year":
      return key;
    case "month": {
      const [year, month] = key.split("-");
      return `${month}.${year}`;
    }
    case "week": {
      const [year, week] = key.split("-W");
      return `KW ${week}/${year}`;
    }
    case "day": {
      const [year, month, day] = key.split("-");
      return `${day}.${month}.${year}`;
    }
  }
}

/** Start of the bucket a timestamp falls into, as a UTC date. */
export function bucketStartDate(date: Date, granularity: ReportGranularity): Date {
  switch (granularity) {
    case "year":
      return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    case "month":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    case "week": {
      const iso = isoWeek(date);
      return isoWeekStart(iso.year, iso.week);
    }
    case "day":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
}

export function nextBucketStart(bucketStart: Date, granularity: ReportGranularity): Date {
  switch (granularity) {
    case "year":
      return new Date(Date.UTC(bucketStart.getUTCFullYear() + 1, 0, 1));
    case "month":
      return new Date(Date.UTC(bucketStart.getUTCFullYear(), bucketStart.getUTCMonth() + 1, 1));
    case "week":
      return new Date(bucketStart.getTime() + 7 * MS_PER_DAY);
    case "day":
      return new Date(bucketStart.getTime() + MS_PER_DAY);
  }
}

/**
 * Key of the same period one year earlier. For weeks that is the same ISO
 * week number of the previous week-year (a week 53 simply finds no match),
 * for days the same calendar date.
 */
export function previousYearKey(key: string, granularity: ReportGranularity): string {
  switch (granularity) {
    case "year":
      return String(Number(key) - 1);
    case "month": {
      const [year, month] = key.split("-");
      return `${Number(year) - 1}-${month}`;
    }
    case "week": {
      const [year, week] = key.split("-W");
      return `${Number(year) - 1}-W${week}`;
    }
    case "day": {
      const [year, month, day] = key.split("-");
      return `${Number(year) - 1}-${month}-${day}`;
    }
  }
}

/** Start of the period a bucket key denotes, as a UTC date. */
export function bucketStartFromKey(key: string, granularity: ReportGranularity): Date {
  switch (granularity) {
    case "year":
      return new Date(Date.UTC(Number(key), 0, 1));
    case "month": {
      const [year, month] = key.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, 1));
    }
    case "week": {
      const [year, week] = key.split("-W").map(Number);
      return isoWeekStart(year, week);
    }
    case "day": {
      const [year, month, day] = key.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day));
    }
  }
}

export function bucketStartIso(key: string, granularity: ReportGranularity): string {
  return bucketStartFromKey(key, granularity).toISOString();
}

export function bucketEndIso(key: string, granularity: ReportGranularity): string {
  return nextBucketStart(bucketStartFromKey(key, granularity), granularity).toISOString();
}

/** Buckets per year, to express a per-bucket slope as a per-year change. */
export function bucketsPerYear(granularity: ReportGranularity): number {
  switch (granularity) {
    case "year":
      return 1;
    case "month":
      return 12;
    case "week":
      return 365.25 / 7;
    case "day":
      return 365.25;
  }
}

const MS_PER_DAY_F = 86_400_000;

/** Length of a period in days. */
export function periodDays(periodStart: string, periodEnd: string): number {
  return (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / MS_PER_DAY_F;
}

export function roundReportValue(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

function roundRatio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

interface BucketAccumulator {
  key: string;
  /** Absolute value and instant at the start of the first charged segment. */
  startAt: string;
  startValue: number;
  /** … and at the end of the last charged segment. */
  endAt: string;
  endValue: number;
  consumption: number;
  intervals: number;
  /** Σ interval length × overlap, for the coverage-weighted mean interval. */
  weightedIntervalMs: number;
  overlapMs: number;
}

/** Milliseconds of each bucket that lie between the first and last reading. */
function accumulateCoverage(
  intervals: Array<{ startDate: Date; endDate: Date }>,
  granularity: ReportGranularity,
): Map<string, number> {
  const covered = new Map<string, number>();
  for (const { startDate, endDate } of intervals) {
    for (
      let cursor = bucketStartDate(startDate, granularity);
      cursor.getTime() < endDate.getTime();
      cursor = nextBucketStart(cursor, granularity)
    ) {
      const bucketEnd = nextBucketStart(cursor, granularity);
      const overlapMs =
        Math.min(endDate.getTime(), bucketEnd.getTime()) -
        Math.max(startDate.getTime(), cursor.getTime());
      if (overlapMs <= 0) continue;
      const key = bucketKey(cursor, granularity);
      covered.set(key, (covered.get(key) ?? 0) + overlapMs);
    }
  }
  return covered;
}

function bucketCoverage(key: string, granularity: ReportGranularity, coveredMs: number): number {
  const periodMs =
    new Date(bucketEndIso(key, granularity)).getTime() -
    new Date(bucketStartIso(key, granularity)).getTime();
  if (periodMs <= 0) return 0;
  return Math.min(1, Math.round((coveredMs / periodMs) * 1000) / 1000);
}

/**
 * Fills in the year-over-year comparison. Runs on the unfiltered bucket set so
 * a `from` filter does not silently remove the reference period, and only
 * compares periods that are both fully covered — a full March against a
 * half-measured March would otherwise look like a real change.
 */
function attachPreviousYear(
  buckets: MeterReportBucket[],
  granularity: ReportGranularity,
  decimals: number,
): MeterReportBucket[] {
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const bucket of buckets) {
    const previous = byKey.get(previousYearKey(bucket.key, granularity));
    if (
      !previous ||
      bucket.coverage < COMPLETE_COVERAGE_THRESHOLD ||
      previous.coverage < COMPLETE_COVERAGE_THRESHOLD
    ) {
      continue;
    }
    bucket.previousConsumption = previous.consumption;
    bucket.deltaAbsolute = roundReportValue(bucket.consumption - previous.consumption, decimals);
    // Compare daily rates: a 29-day February against a 28-day one, or a
    // 53-week year against a 52-week one, is not a change in consumption.
    const rate = bucket.consumption / periodDays(bucket.periodStart, bucket.periodEnd);
    const previousRate =
      previous.consumption / periodDays(previous.periodStart, previous.periodEnd);
    bucket.deltaPercent = previousRate > 0 ? roundRatio((rate - previousRate) / previousRate) : null;
  }
  return buckets;
}

export function buildMeterReportBuckets(
  readings: AbsoluteReadingPoint[],
  granularity: ReportGranularity,
  options: {
    from?: Date | null;
    to?: Date | null;
    decimals?: number;
    allocation?: BucketAllocation;
  } = {},
): MeterReportBucket[] {
  const sorted = [...readings].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const from = options.from ?? null;
  const to = options.to ?? null;
  const decimals = options.decimals ?? 3;
  const allocation = options.allocation ?? "interpolated";
  const accumulators = new Map<string, BucketAccumulator>();
  const spans: Array<{ startDate: Date; endDate: Date }> = [];

  const charge = (
    key: string,
    segment: { startAt: string; startValue: number; endAt: string; endValue: number },
    consumption: number,
    intervalMs: number,
    overlapMs: number,
  ) => {
    const existing = accumulators.get(key);
    if (existing) {
      existing.endAt = segment.endAt;
      existing.endValue = segment.endValue;
      existing.consumption += consumption;
      existing.intervals += 1;
      existing.weightedIntervalMs += intervalMs * overlapMs;
      existing.overlapMs += overlapMs;
    } else {
      accumulators.set(key, {
        key,
        ...segment,
        consumption,
        intervals: 1,
        weightedIntervalMs: intervalMs * overlapMs,
        overlapMs,
      });
    }
  };

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const startDate = new Date(start.takenAt);
    const endDate = new Date(end.takenAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) continue;

    const consumption = end.value - start.value;
    if (!Number.isFinite(consumption) || consumption < 0) continue;

    const durationMs = endDate.getTime() - startDate.getTime();
    if (durationMs > 0) spans.push({ startDate, endDate });

    const whole = {
      startAt: start.takenAt,
      startValue: start.value,
      endAt: end.takenAt,
      endValue: end.value,
    };

    // Two readings at the same instant (a device swap whose closing and
    // opening reading share a timestamp) still carry consumption — it goes
    // to the period of that instant rather than being lost.
    if (allocation === "interval_start" || durationMs <= 0) {
      charge(bucketKey(startDate, granularity), whole, consumption, durationMs, durationMs);
      continue;
    }

    // Absolute value at an instant inside the interval, assuming a constant rate.
    const valueAt = (ms: number) =>
      start.value + (consumption * (ms - startDate.getTime())) / durationMs;

    for (
      let cursor = bucketStartDate(startDate, granularity);
      cursor.getTime() < endDate.getTime();
      cursor = nextBucketStart(cursor, granularity)
    ) {
      const bucketEnd = nextBucketStart(cursor, granularity);
      const segmentStartMs = Math.max(startDate.getTime(), cursor.getTime());
      const segmentEndMs = Math.min(endDate.getTime(), bucketEnd.getTime());
      const overlapMs = segmentEndMs - segmentStartMs;
      if (overlapMs <= 0) continue;
      charge(
        bucketKey(cursor, granularity),
        {
          startAt: new Date(segmentStartMs).toISOString(),
          startValue: valueAt(segmentStartMs),
          endAt: new Date(segmentEndMs).toISOString(),
          endValue: valueAt(segmentEndMs),
        },
        (consumption * overlapMs) / durationMs,
        durationMs,
        overlapMs,
      );
    }
  }

  const coveredMsByKey = accumulateCoverage(spans, granularity);
  const buckets = [...accumulators.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry): MeterReportBucket => ({
      key: entry.key,
      label: bucketLabel(entry.key, granularity),
      periodStart: bucketStartIso(entry.key, granularity),
      periodEnd: bucketEndIso(entry.key, granularity),
      startReadingAt: entry.startAt,
      endReadingAt: entry.endAt,
      startValue: roundReportValue(entry.startValue, decimals),
      endValue: roundReportValue(entry.endValue, decimals),
      consumption: roundReportValue(entry.consumption, decimals),
      intervals: entry.intervals,
      coverage: bucketCoverage(entry.key, granularity, coveredMsByKey.get(entry.key) ?? 0),
      meanIntervalDays:
        entry.overlapMs > 0
          ? Math.round((entry.weightedIntervalMs / entry.overlapMs / MS_PER_DAY_F) * 10) / 10
          : null,
      previousConsumption: null,
      deltaAbsolute: null,
      deltaPercent: null,
    }));

  attachPreviousYear(buckets, granularity, decimals);

  // The filter works on whole periods in both modes and only after the
  // comparison, so a `from` never removes the reference year — in
  // `interval_start` mode a period is the one its intervals start in.
  return buckets.filter((bucket) => {
    const periodStart = new Date(bucket.periodStart);
    if (from && periodStart < from) return false;
    if (to && periodStart >= to) return false;
    return true;
  });
}

export async function loadAbsoluteReadingSeries(
  userId: number,
  meterId: number,
): Promise<AbsoluteReadingPoint[]> {
  await loadVisibleMeter(userId, meterId);
  const { devices, offsets } = await loadDeviceOffsets(meterId);
  if (devices.length === 0) return [];

  const readings = await dbAll<{ device_id: number; value: string; taken_at: string }>(
    db
      .select({
        device_id: meterReadings.device_id,
        value: meterReadings.value,
        taken_at: meterReadings.taken_at,
      })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterReadings.device_id, meterDevices.id))
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(asc(meterReadings.taken_at), asc(meterReadings.id)),
  );

  return readings.map((reading) => {
    const offset = offsets.get(reading.device_id);
    const rawValue = parseFloat(reading.value);
    return {
      takenAt: reading.taken_at,
      value: offset ? offset.baseOffset + rawValue - offset.startValue : rawValue,
    };
  });
}

export async function getMeterReportForUser(
  userId: number,
  meterId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
  allocation: BucketAllocation = "interpolated",
): Promise<MeterReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const meter = await loadVisibleMeter(userId, meterId);
  const readings = await loadAbsoluteReadingSeries(userId, meterId);
  const buckets = buildMeterReportBuckets(readings, granularity, {
    from: fromDate,
    to: toDate,
    decimals: meter.decimals,
    allocation,
  });

  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    decimals: meter.decimals,
    granularity,
    allocation,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    buckets,
    totalConsumption: roundReportValue(
      buckets.reduce((sum, bucket) => sum + bucket.consumption, 0),
      meter.decimals,
    ),
  };
}

/** Roles whose consumption is taken out of the total to get the rest of the household. */
const EXCLUSION_ROLES: EnergyReportRole[] = [
  "heat_pump_total",
  "heat_heating_total",
  "hot_water_total",
  "ev_charger_total",
];

export function buildEnergyReportFromMeterReports(
  reports: Partial<Record<EnergyReportRole, MeterReport>>,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
  tariffTimeline?: EnergyTariffTimeline,
  allocation: BucketAllocation = "interpolated",
  /** Per-key cost results that replace the bucket's own (yearly costs summed from months). */
  costOverrides?: Map<string, EnergyTariffCostResult | null>,
): Omit<EnergyReport, "meters" | "missingRoles" | "duplicateRoles"> {
  const decimals = Math.max(
    0,
    ...ENERGY_REPORT_ROLES.map((role) => reports[role]?.decimals ?? 0),
  );
  const bucketKeys = new Set<string>();
  for (const report of Object.values(reports)) {
    for (const bucket of report?.buckets ?? []) bucketKeys.add(bucket.key);
  }

  const byRole = new Map<EnergyReportRole, Map<string, MeterReportBucket>>();
  for (const role of ENERGY_REPORT_ROLES) {
    byRole.set(role, new Map((reports[role]?.buckets ?? []).map((bucket) => [bucket.key, bucket])));
  }
  // A role the household meters at all. If such a role has no bucket for a
  // period, the period is *missing* that reading — not consuming zero.
  const meteredRoles = new Set<EnergyReportRole>(
    ENERGY_REPORT_ROLES.filter((role) => (reports[role]?.buckets.length ?? 0) > 0),
  );
  const missingFor = (role: EnergyReportRole, key: string) =>
    meteredRoles.has(role) && !byRole.get(role)?.has(key);

  const buckets = [...bucketKeys].sort().map((key): EnergyReportBucket => {
    const source =
      byRole.get("grid_import")?.get(key) ??
      byRole.get("grid_export")?.get(key) ??
      byRole.get("pv_production")?.get(key) ??
      byRole.get("heat_pump_total")?.get(key) ??
      byRole.get("heat_heating_total")?.get(key) ??
      byRole.get("hot_water_total")?.get(key) ??
      byRole.get("ev_charger_total")?.get(key);
    const value = (role: EnergyReportRole) => byRole.get(role)?.get(key)?.consumption ?? null;
    const gridImport = value("grid_import");
    const gridExport = value("grid_export");
    const production = value("pv_production");
    const heatPumpTotal = value("heat_pump_total");
    const heatHeatingTotal = value("heat_heating_total");
    const heatHeatingPv = value("heat_heating_pv");
    const hotWaterTotal = value("hot_water_total");
    const hotWaterPv = value("hot_water_pv");
    const evChargerTotal = value("ev_charger_total");
    const evChargerPv = value("ev_charger_pv");

    const gridShare = (total: number | null, pv: number | null) =>
      total !== null && pv !== null ? roundReportValue(Math.max(0, total - pv), decimals) : null;
    const pvShare = (total: number | null, pv: number | null) =>
      total !== null && total > 0 && pv !== null ? roundRatio(Math.min(1, pv / total)) : null;

    const warnings: EnergyBucketWarning[] = [];
    if (production !== null && gridExport !== null && gridExport > production) {
      warnings.push("export_exceeds_production");
    }
    const selfConsumption =
      production !== null && gridExport !== null
        ? roundReportValue(Math.max(0, production - gridExport), decimals)
        : null;
    const totalConsumption =
      gridImport !== null && selfConsumption !== null
        ? roundReportValue(gridImport + selfConsumption, decimals)
        : null;

    // Heat pump share: the whole-pump meter if the household has one,
    // otherwise whatever sub-meters it has. A metered role without a bucket
    // for this period leaves the household figure undefined.
    const exclusionMissing = EXCLUSION_ROLES.some((role) => missingFor(role, key));
    const subMeters = [heatHeatingTotal, hotWaterTotal].filter((v): v is number => v !== null);
    const heatPumpExclusion =
      heatPumpTotal ??
      (subMeters.length > 0
        ? roundReportValue(subMeters.reduce((a, b) => a + b, 0), decimals)
        : null);
    let consumptionWithoutHeatPumpAndEv: number | null = null;
    if (totalConsumption !== null && !exclusionMissing) {
      const excluded = (heatPumpExclusion ?? 0) + (evChargerTotal ?? 0);
      if (excluded > totalConsumption + 0.5) warnings.push("exclusion_exceeds_total");
      consumptionWithoutHeatPumpAndEv = roundReportValue(
        Math.max(0, totalConsumption - excluded),
        decimals,
      );
    }

    const contributingCoverages = ENERGY_REPORT_ROLES.map(
      (role) => byRole.get(role)?.get(key)?.coverage,
    ).filter((value): value is number => value !== undefined);
    const coverage = contributingCoverages.length > 0 ? Math.min(...contributingCoverages) : 0;
    const hasPvSet = gridImport !== null && gridExport !== null && production !== null;

    const bucket: EnergyReportBucket = {
      key,
      label: source?.label ?? bucketLabel(key, granularity),
      periodStart: source?.periodStart ?? bucketStartIso(key, granularity),
      periodEnd: source?.periodEnd ?? bucketEndIso(key, granularity),
      coverage,
      complete: hasPvSet && coverage >= COMPLETE_COVERAGE_THRESHOLD,
      warnings,
      gridImport,
      gridExport,
      production,
      selfConsumption,
      totalConsumption,
      consumptionWithoutHeatPumpAndEv,
      autarky:
        totalConsumption !== null && totalConsumption > 0 && gridImport !== null
          ? roundRatio(1 - gridImport / totalConsumption)
          : null,
      selfConsumptionRate:
        production !== null && production > 0 && selfConsumption !== null
          ? roundRatio(selfConsumption / production)
          : null,
      heatPumpTotal,
      heatHeatingTotal,
      heatHeatingPv,
      heatHeatingGrid: gridShare(heatHeatingTotal, heatHeatingPv),
      heatHeatingPvShare: pvShare(heatHeatingTotal, heatHeatingPv),
      hotWaterTotal,
      hotWaterPv,
      hotWaterGrid: gridShare(hotWaterTotal, hotWaterPv),
      hotWaterPvShare: pvShare(hotWaterTotal, hotWaterPv),
      evChargerTotal,
      evChargerPv,
      evChargerGrid: gridShare(evChargerTotal, evChargerPv),
      evChargerPvShare: pvShare(evChargerTotal, evChargerPv),
      costs: null,
    };
    bucket.costs = costOverrides?.has(key)
      ? (costOverrides.get(key) ?? null)
      : tariffTimeline?.hasCostTariffs()
        ? tariffTimeline.costsForBucket({
            periodStart: bucket.periodStart,
            periodEnd: bucket.periodEnd,
            gridImport: bucket.gridImport,
            gridExport: bucket.gridExport,
            selfConsumption: bucket.selfConsumption,
            totalConsumption: bucket.totalConsumption,
          })
        : null;
    return bucket;
  });

  // Periods before the PV system (no full set of grid import, export and
  // production) stay out of the PV report altogether. Partially measured
  // periods are shown, flagged, and kept out of the totals.
  const pvBuckets = buckets.filter(
    (bucket) =>
      bucket.gridImport !== null && bucket.gridExport !== null && bucket.production !== null,
  );
  const completeBuckets = pvBuckets.filter((bucket) => bucket.complete);

  const sum = (selector: (bucket: EnergyReportBucket) => number | null) => {
    const values = completeBuckets.map(selector).filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return roundReportValue(values.reduce((total, value) => total + value, 0), decimals);
  };
  /**
   * A share over the periods where *both* sides are known — summing a
   * numerator over more periods than its denominator would report a PV share
   * above one hundred percent after a sub-meter was added later.
   */
  const pairedShare = (
    totalOf: (bucket: EnergyReportBucket) => number | null,
    pvOf: (bucket: EnergyReportBucket) => number | null,
  ) => {
    const pairs = completeBuckets.filter((b) => totalOf(b) !== null && pvOf(b) !== null);
    if (pairs.length === 0) return null;
    const total = pairs.reduce((acc, b) => acc + (totalOf(b) as number), 0);
    const pv = pairs.reduce((acc, b) => acc + (pvOf(b) as number), 0);
    return total > 0 ? roundRatio(Math.min(1, pv / total)) : null;
  };
  const costSum = (selector: (bucket: EnergyReportBucket) => number | null | undefined) => {
    const values = completeBuckets
      .map(selector)
      .filter((value): value is number => value !== null && value !== undefined);
    if (values.length === 0) return null;
    return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  };

  const gridImport = sum((bucket) => bucket.gridImport);
  const gridExport = sum((bucket) => bucket.gridExport);
  const production = sum((bucket) => bucket.production);
  // Sums of the bucket figures, so the total row adds up to its columns.
  const selfConsumption = sum((bucket) => bucket.selfConsumption);
  const totalConsumption = sum((bucket) => bucket.totalConsumption);
  const heatHeatingTotal = sum((bucket) => bucket.heatHeatingTotal);
  const heatHeatingPv = sum((bucket) => bucket.heatHeatingPv);
  const hotWaterTotal = sum((bucket) => bucket.hotWaterTotal);
  const hotWaterPv = sum((bucket) => bucket.hotWaterPv);
  const evChargerTotal = sum((bucket) => bucket.evChargerTotal);
  const evChargerPv = sum((bucket) => bucket.evChargerPv);

  return {
    unit: "kWh",
    decimals,
    granularity,
    allocation,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    buckets: pvBuckets,
    totals: {
      gridImport,
      gridExport,
      production,
      selfConsumption,
      totalConsumption,
      consumptionWithoutHeatPumpAndEv: sum((bucket) => bucket.consumptionWithoutHeatPumpAndEv),
      autarky:
        totalConsumption !== null && totalConsumption > 0 && gridImport !== null
          ? roundRatio(1 - gridImport / totalConsumption)
          : null,
      selfConsumptionRate:
        production !== null && production > 0 && selfConsumption !== null
          ? roundRatio(selfConsumption / production)
          : null,
      heatPumpTotal: sum((bucket) => bucket.heatPumpTotal),
      heatHeatingTotal,
      heatHeatingPv,
      heatHeatingGrid: sum((bucket) => bucket.heatHeatingGrid),
      heatHeatingPvShare: pairedShare((b) => b.heatHeatingTotal, (b) => b.heatHeatingPv),
      hotWaterTotal,
      hotWaterPv,
      hotWaterGrid: sum((bucket) => bucket.hotWaterGrid),
      hotWaterPvShare: pairedShare((b) => b.hotWaterTotal, (b) => b.hotWaterPv),
      evChargerTotal,
      evChargerPv,
      evChargerGrid: sum((bucket) => bucket.evChargerGrid),
      evChargerPvShare: pairedShare((b) => b.evChargerTotal, (b) => b.evChargerPv),
      costs: tariffTimeline?.hasCostTariffs()
        ? {
            gridImportCostEur: costSum((bucket) => bucket.costs?.gridImportCostEur),
            baseCostEur: costSum((bucket) => bucket.costs?.baseCostEur),
            feedInRevenueEur: costSum((bucket) => bucket.costs?.feedInRevenueEur),
            avoidedGridCostEur: costSum((bucket) => bucket.costs?.avoidedGridCostEur),
            pvBenefitEur: costSum((bucket) => bucket.costs?.pvBenefitEur),
            netElectricityCostEur: costSum((bucket) => bucket.costs?.netElectricityCostEur),
            noPvElectricityCostEur: costSum((bucket) => bucket.costs?.noPvElectricityCostEur),
          }
        : null,
    },
    hasTariffs: tariffTimeline?.hasCostTariffs() ?? false,
  };
}

/** The first visible meter per role, plus the roles that occur more than once. */
export async function resolveRoleMeters(
  userId: number,
): Promise<{ roleMeters: Map<EnergyReportRole, MeterListItem>; duplicateRoles: EnergyReportRole[] }> {
  const roleMeters = new Map<EnergyReportRole, MeterListItem>();
  const duplicates = new Set<EnergyReportRole>();
  for (const meter of await listMeters(userId)) {
    const role = meter.role as EnergyReportRole | null;
    if (!role || !ENERGY_REPORT_ROLES.includes(role)) continue;
    if (roleMeters.has(role)) duplicates.add(role);
    else roleMeters.set(role, meter);
  }
  return { roleMeters, duplicateRoles: [...duplicates] };
}

export async function getEnergyReportForUser(
  userId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
  allocation: BucketAllocation = "interpolated",
): Promise<EnergyReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const { roleMeters, duplicateRoles } = await resolveRoleMeters(userId);
  const tariffTimeline = await loadEnergyTariffTimeline(userId);

  const loadReports = async (g: ReportGranularity) => {
    const reports: Partial<Record<EnergyReportRole, MeterReport>> = {};
    for (const [role, meter] of roleMeters) {
      reports[role] = await getMeterReportForUser(userId, meter.id, g, fromDate, toDate, allocation);
    }
    return reports;
  };
  const reports = await loadReports(granularity);

  // A year's cost is the sum of its months' costs, not the year's kWh at a
  // day-weighted average price: consumption is seasonal, price changes are
  // not, and the two ways of counting would otherwise disagree by a few
  // percent between the month and the year view.
  let costOverrides: Map<string, EnergyTariffCostResult | null> | undefined;
  if (granularity === "year" && tariffTimeline.hasCostTariffs()) {
    const monthly = buildEnergyReportFromMeterReports(
      await loadReports("month"),
      "month",
      fromDate,
      toDate,
      tariffTimeline,
      allocation,
    );
    const monthsByYear = new Map<string, Array<EnergyTariffCostResult | null>>();
    for (const bucket of monthly.buckets) {
      const year = bucket.key.slice(0, 4);
      monthsByYear.set(year, [...(monthsByYear.get(year) ?? []), bucket.costs]);
    }
    costOverrides = new Map(
      [...monthsByYear.entries()].map(([year, list]) => [year, sumCostResults(list)]),
    );
  }

  const base = buildEnergyReportFromMeterReports(
    reports,
    granularity,
    fromDate,
    toDate,
    tariffTimeline,
    allocation,
    costOverrides,
  );
  return {
    ...base,
    meters: [...roleMeters.entries()].map(([role, meter]) => ({
      role,
      meterId: meter.id,
      name: meter.name,
    })),
    missingRoles: REQUIRED_ENERGY_REPORT_ROLES.filter((role) => !roleMeters.has(role)),
    duplicateRoles,
  };
}
