/**
 * Utility meters — equipment condition (Issue #792, Etappe 6e).
 *
 * Early-warning figures that consumption totals hide:
 *
 *  - **kWh per compressor hour** — the readable efficiency trend of a heat
 *    pump. A rising value means it needs more electricity for the same hour of
 *    running: icing, refrigerant loss, a fouled heat exchanger.
 *  - **Runtime share** of each pump — how much of the period it actually ran.
 *  - **Water baseline** — the *smallest* daily rate in a period. A rising floor
 *    while overall usage stays flat is the classic signature of a running
 *    toilet or a leak, and it is invisible in the monthly total.
 *  - **Yield per kWp** — the only dependable early indicator of PV degradation
 *    or soiled panels, because it normalises away a good or bad weather year.
 */

import { APIError } from "encore.dev/api";
import { listMeters, type MeterListItem } from "./meter.service";
import {
  getMeterReportForUser,
  loadAbsoluteReadingSeries,
  COMPLETE_COVERAGE_THRESHOLD,
  type MeterReport,
  type MeterReportBucket,
  type ReportGranularity,
} from "./reports.service";
import { linearRegressionSlope } from "./trends.service";
import { loadEnergyTariffTimeline } from "./tariffs.service";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function ratio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

/** Buckets per year, to express a per-bucket slope as a per-year change. */
function bucketsPerYear(granularity: ReportGranularity): number {
  return granularity === "year" ? 1 : 12;
}

function isComplete(bucket: { coverage: number }): boolean {
  return bucket.coverage >= COMPLETE_COVERAGE_THRESHOLD;
}

/** Change from the first to the last value of a series, as a ratio. */
function changeOverSeries(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return null;
  return ratio((last - first) / first);
}

export interface OperatingHoursBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  hours: number;
  /** Share of the measured time the machine actually ran, 0..1. */
  runtimeShare: number | null;
  coverage: number;
}

export interface OperatingHoursMetric {
  meterId: number;
  name: string;
  unit: string;
  buckets: OperatingHoursBucket[];
  totalHours: number;
  /** Runtime share over the fully measured periods. */
  averageRuntimeShare: number | null;
}

export interface CompressorEfficiencyBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  electricityKwh: number | null;
  compressorHours: number | null;
  /** Electricity per hour of running — rising means losing efficiency. */
  kwhPerHour: number | null;
}

export interface CompressorEfficiency {
  electricityMeterId: number;
  hoursMeterId: number;
  buckets: CompressorEfficiencyBucket[];
  earliestKwhPerHour: number | null;
  latestKwhPerHour: number | null;
  /** Change from the first to the last fully measured period. */
  changePercent: number | null;
  slopePerYear: number | null;
}

export interface WaterBaselineBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Lowest daily rate among the reading intervals starting in this period. */
  minDailyRate: number | null;
  averageDailyRate: number | null;
  intervals: number;
}

export interface WaterBaseline {
  meterId: number;
  name: string;
  unit: string;
  buckets: WaterBaselineBucket[];
  latestMinDailyRate: number | null;
  previousYearMinDailyRate: number | null;
  changePercent: number | null;
  slopePerYear: number | null;
}

export interface PvYieldBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  productionKwh: number;
  /** kWh per installed kWp — comparable across weather years. */
  yieldPerKwp: number | null;
  coverage: number;
}

export interface PvYieldReport {
  meterId: number;
  capacityKwp: number;
  buckets: PvYieldBucket[];
  bestYieldPerKwp: number | null;
  latestYieldPerKwp: number | null;
  /** Latest against the best period on record. */
  changeVsBestPercent: number | null;
}

export interface EquipmentReport {
  granularity: ReportGranularity;
  from: string | null;
  to: string | null;
  operatingHours: OperatingHoursMetric[];
  compressorEfficiency: CompressorEfficiency | null;
  waterBaselines: WaterBaseline[];
  pvYield: PvYieldReport | null;
}

export function buildOperatingHoursMetric(
  meter: MeterListItem,
  report: MeterReport,
): OperatingHoursMetric {
  const buckets = report.buckets.map((bucket): OperatingHoursBucket => {
    const periodHours =
      (new Date(bucket.periodEnd).getTime() - new Date(bucket.periodStart).getTime()) / MS_PER_HOUR;
    // Only the measured slice of the period can be compared with the hours
    // counted in it; a half-measured month would otherwise look half as busy.
    const measuredHours = periodHours * bucket.coverage;
    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      hours: bucket.consumption,
      runtimeShare:
        measuredHours > 0 ? ratio(Math.min(1, bucket.consumption / measuredHours)) : null,
      coverage: bucket.coverage,
    };
  });

  const complete = buckets.filter(
    (bucket) => isComplete(bucket) && bucket.runtimeShare !== null,
  );
  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    buckets,
    totalHours: round(buckets.reduce((sum, bucket) => sum + bucket.hours, 0), 1) ?? 0,
    averageRuntimeShare:
      complete.length === 0
        ? null
        : ratio(
            complete.reduce((sum, bucket) => sum + (bucket.runtimeShare ?? 0), 0) / complete.length,
          ),
  };
}

export function buildCompressorEfficiency(
  electricityMeterId: number,
  hoursMeterId: number,
  electricity: MeterReportBucket[],
  hours: MeterReportBucket[],
  granularity: ReportGranularity,
): CompressorEfficiency {
  const hoursByKey = new Map(hours.map((bucket) => [bucket.key, bucket]));

  const buckets = electricity.map((bucket): CompressorEfficiencyBucket => {
    const hoursBucket = hoursByKey.get(bucket.key);
    const compressorHours = hoursBucket?.consumption ?? null;
    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      electricityKwh: bucket.consumption,
      compressorHours,
      // Both sides must be fully measured, or the ratio compares a full
      // month of electricity against a partial month of running hours.
      kwhPerHour:
        compressorHours !== null &&
        compressorHours > 0 &&
        isComplete(bucket) &&
        hoursBucket !== undefined &&
        isComplete(hoursBucket)
          ? round(bucket.consumption / compressorHours)
          : null,
    };
  });

  const series = buckets
    .map((bucket) => bucket.kwhPerHour)
    .filter((value): value is number => value !== null);
  const slopePerBucket = linearRegressionSlope(series);

  return {
    electricityMeterId,
    hoursMeterId,
    buckets,
    earliestKwhPerHour: series[0] ?? null,
    latestKwhPerHour: series[series.length - 1] ?? null,
    changePercent: changeOverSeries(series),
    slopePerYear:
      slopePerBucket === null ? null : round(slopePerBucket * bucketsPerYear(granularity), 4),
  };
}

/**
 * Daily rates per period, from the raw reading intervals rather than the
 * bucketed totals. The minimum is the point of this report, and a minimum
 * cannot be interpolated — spreading an interval across periods would erase
 * exactly the quiet stretch that reveals a leak.
 */
export function buildWaterBaselineBuckets(
  readings: Array<{ takenAt: string; value: number }>,
  granularity: ReportGranularity,
): WaterBaselineBucket[] {
  interface Accumulator {
    rates: number[];
    consumption: number;
    days: number;
  }
  const byKey = new Map<string, Accumulator>();

  for (let i = 0; i < readings.length - 1; i++) {
    const start = new Date(readings[i].takenAt);
    const end = new Date(readings[i + 1].takenAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

    const days = (end.getTime() - start.getTime()) / MS_PER_DAY;
    const consumption = readings[i + 1].value - readings[i].value;
    if (days <= 0 || !Number.isFinite(consumption) || consumption < 0) continue;

    const key =
      granularity === "year"
        ? String(start.getUTCFullYear())
        : `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    const entry = byKey.get(key) ?? { rates: [], consumption: 0, days: 0 };
    entry.rates.push(consumption / days);
    entry.consumption += consumption;
    entry.days += days;
    byKey.set(key, entry);
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]): WaterBaselineBucket => {
      const [year, month] = key.split("-").map(Number);
      const periodStart =
        granularity === "year"
          ? new Date(Date.UTC(year, 0, 1))
          : new Date(Date.UTC(year, month - 1, 1));
      const periodEnd =
        granularity === "year"
          ? new Date(Date.UTC(year + 1, 0, 1))
          : new Date(Date.UTC(year, month, 1));
      return {
        key,
        label: granularity === "year" ? key : `${String(month).padStart(2, "0")}.${year}`,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        minDailyRate: round(Math.min(...entry.rates), 4),
        averageDailyRate: entry.days > 0 ? round(entry.consumption / entry.days, 4) : null,
        intervals: entry.rates.length,
      };
    });
}

export function buildWaterBaseline(
  meter: MeterListItem,
  readings: Array<{ takenAt: string; value: number }>,
  granularity: ReportGranularity,
): WaterBaseline {
  const buckets = buildWaterBaselineBuckets(readings, granularity);
  const series = buckets
    .map((bucket) => bucket.minDailyRate)
    .filter((value): value is number => value !== null);
  const slopePerBucket = linearRegressionSlope(series);

  const latest = buckets[buckets.length - 1] ?? null;
  const previousKey =
    latest === null
      ? null
      : granularity === "year"
        ? String(Number(latest.key) - 1)
        : `${Number(latest.key.split("-")[0]) - 1}-${latest.key.split("-")[1]}`;
  const previous = previousKey === null ? null : buckets.find((b) => b.key === previousKey) ?? null;

  const latestRate = latest?.minDailyRate ?? null;
  const previousRate = previous?.minDailyRate ?? null;

  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    buckets,
    latestMinDailyRate: latestRate,
    previousYearMinDailyRate: previousRate,
    changePercent:
      latestRate !== null && previousRate !== null && previousRate > 0
        ? ratio((latestRate - previousRate) / previousRate)
        : null,
    slopePerYear:
      slopePerBucket === null ? null : round(slopePerBucket * bucketsPerYear(granularity), 4),
  };
}

export function buildPvYield(
  meterId: number,
  capacityKwp: number,
  buckets: MeterReportBucket[],
): PvYieldReport {
  const yieldBuckets = buckets.map((bucket): PvYieldBucket => ({
    key: bucket.key,
    label: bucket.label,
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    productionKwh: bucket.consumption,
    // A partial period would understate the yield and look like degradation.
    yieldPerKwp: isComplete(bucket) ? round(bucket.consumption / capacityKwp, 1) : null,
    coverage: bucket.coverage,
  }));

  const series = yieldBuckets
    .map((bucket) => bucket.yieldPerKwp)
    .filter((value): value is number => value !== null);
  const best = series.length === 0 ? null : Math.max(...series);
  const latest = series[series.length - 1] ?? null;

  return {
    meterId,
    capacityKwp,
    buckets: yieldBuckets,
    bestYieldPerKwp: best,
    latestYieldPerKwp: latest,
    changeVsBestPercent:
      best !== null && latest !== null && best > 0 ? ratio((latest - best) / best) : null,
  };
}

export async function getEquipmentReportForUser(
  userId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<EquipmentReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const visibleMeters = await listMeters(userId);
  const reportFor = (meterId: number) =>
    getMeterReportForUser(userId, meterId, granularity, fromDate, toDate);

  const operatingHours: OperatingHoursMetric[] = [];
  for (const meter of visibleMeters) {
    if (meter.type !== "operating_hours") continue;
    operatingHours.push(buildOperatingHoursMetric(meter, await reportFor(meter.id)));
  }

  const heatPumpMeter = visibleMeters.find((meter) => meter.role === "heat_pump_total");
  const compressorMeter = visibleMeters.find((meter) => meter.role === "compressor_hours");
  const compressorEfficiency =
    heatPumpMeter && compressorMeter
      ? buildCompressorEfficiency(
          heatPumpMeter.id,
          compressorMeter.id,
          (await reportFor(heatPumpMeter.id)).buckets,
          (await reportFor(compressorMeter.id)).buckets,
          granularity,
        )
      : null;

  const waterBaselines: WaterBaseline[] = [];
  for (const meter of visibleMeters) {
    if (meter.type !== "water") continue;
    const readings = await loadAbsoluteReadingSeries(userId, meter.id);
    waterBaselines.push(buildWaterBaseline(meter, readings, granularity));
  }

  const timeline = await loadEnergyTariffTimeline(userId);
  const capacityKwp = timeline.amountOf("pv_capacity_kwp");
  const productionMeter = visibleMeters.find((meter) => meter.role === "pv_production");
  const pvYield =
    capacityKwp !== null && capacityKwp > 0 && productionMeter
      ? buildPvYield(productionMeter.id, capacityKwp, (await reportFor(productionMeter.id)).buckets)
      : null;

  return {
    granularity,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    operatingHours,
    compressorEfficiency,
    waterBaselines,
    pvYield,
  };
}
