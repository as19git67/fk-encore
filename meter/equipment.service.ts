/**
 * Utility meters — equipment condition (Issue #792, Etappe 6e).
 *
 * Early-warning figures that consumption totals hide:
 *
 *  - **kWh per compressor hour** — the readable efficiency trend of a heat
 *    pump. A rising value means it needs more electricity for the same hour of
 *    running: icing, refrigerant loss, a fouled heat exchanger. Compared with
 *    the same period a year earlier, never January against July.
 *  - **Runtime share** of each pump — how much of the period it actually ran.
 *  - **Water baseline** — the *smallest* daily rate in a period. A rising floor
 *    while overall usage stays flat is the classic signature of a running
 *    toilet or a leak, and it is invisible in the monthly total. It needs
 *    readings a week apart at most; with one reading a month the minimum is
 *    the average and says nothing, so it is withheld.
 *  - **Yield per kWp** — the only dependable early indicator of PV degradation
 *    or soiled panels, because it normalises away a good or bad weather year.
 *    Always per calendar year, whatever the report granularity: a December
 *    against a July is weather, not degradation.
 *
 * Every trend here is a regression over calendar time, so a period without
 * measurement does not get squeezed out of the axis.
 */

import { APIError } from "encore.dev/api";
import { listMeters, type MeterListItem } from "./meter.service";
import {
  bucketEndIso,
  bucketKey,
  bucketLabel,
  bucketStartIso,
  getMeterReportForUser,
  loadAbsoluteReadingSeries,
  previousYearKey,
  resolveRoleMeters,
  COMPLETE_COVERAGE_THRESHOLD,
  type EnergyReportRole,
  type MeterReport,
  type MeterReportBucket,
  type ReportGranularity,
} from "./reports.service";
import { linearRegressionSlopeOverTime, yearsAt } from "./trends.service";
import { loadEnergyTariffTimeline } from "./tariffs.service";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Below this share of the period the compressor barely ran (summer hot water
 * only) and kWh per hour is dominated by standby and start-up, not by the
 * pump's condition.
 */
export const MIN_COMPRESSOR_RUNTIME_SHARE = 0.03;
/** Reading intervals up to this length resolve a quiet stretch a leak would show in. */
export const MAX_BASELINE_INTERVAL_DAYS = 7;
/** A period must be measured to this share before its baseline is compared. */
const MIN_BASELINE_MEASURED_SHARE = 0.5;
/** Regressions here run over a few points; three is the least that is a line. */
const MIN_TREND_POINTS = 3;

function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function ratio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function isComplete(bucket: { coverage: number }): boolean {
  return bucket.coverage >= COMPLETE_COVERAGE_THRESHOLD;
}

function relativeChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null;
  return ratio((to - from) / from);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface OperatingHoursBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  hours: number;
  /** Share of the measured time the machine actually ran; above 1 the reading is implausible. */
  runtimeShare: number | null;
  /** More hours counted than the measured time contains. */
  implausible: boolean;
  coverage: number;
}

export interface OperatingHoursMetric {
  meterId: number;
  name: string;
  unit: string;
  buckets: OperatingHoursBucket[];
  totalHours: number;
  /** Runtime share over the fully measured periods, weighted by their length. */
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
  /** Same period a year earlier. */
  previousYearKwhPerHour: number | null;
}

export interface CompressorEfficiency {
  electricityMeterId: number;
  hoursMeterId: number;
  buckets: CompressorEfficiencyBucket[];
  earliestKwhPerHour: number | null;
  latestKwhPerHour: number | null;
  /** Period the latest value belongs to. */
  latestKey: string | null;
  previousYearKwhPerHour: number | null;
  /** Latest period against the same period a year earlier. */
  changePercent: number | null;
  /** Regression over calendar time. */
  slopePerYear: number | null;
}

export interface WaterBaselineBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Lowest daily rate among the reading intervals starting in this period; null when the readings are too sparse. */
  minDailyRate: number | null;
  averageDailyRate: number | null;
  intervals: number;
  shortestIntervalDays: number | null;
  /** Days of the period covered by intervals starting in it. */
  measuredDays: number;
}

export interface WaterBaseline {
  meterId: number;
  name: string;
  unit: string;
  buckets: WaterBaselineBucket[];
  latestMinDailyRate: number | null;
  latestKey: string | null;
  previousYearMinDailyRate: number | null;
  changePercent: number | null;
  slopePerYear: number | null;
  /** No period had readings close enough together for a baseline. */
  tooSparse: boolean;
}

export interface PvYieldBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  productionKwh: number;
  /** Installed capacity in force in that year. */
  capacityKwp: number | null;
  /** kWh per installed kWp — comparable across weather years. */
  yieldPerKwp: number | null;
  coverage: number;
}

export interface PvYieldReport {
  meterId: number;
  /** Current installed capacity. */
  capacityKwp: number;
  /** Always calendar years, whatever granularity the report was asked for. */
  buckets: PvYieldBucket[];
  latestYieldPerKwp: number | null;
  latestKey: string | null;
  previousYearYieldPerKwp: number | null;
  changeVsPreviousYearPercent: number | null;
  medianYieldPerKwp: number | null;
  changeVsMedianPercent: number | null;
  bestYieldPerKwp: number | null;
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
  /** Roles a figure would need and the household has not assigned. */
  missingRoles: EnergyReportRole[];
  duplicateRoles: EnergyReportRole[];
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
    const share = measuredHours > 0 ? bucket.consumption / measuredHours : null;
    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      hours: bucket.consumption,
      runtimeShare: ratio(share),
      // Not clamped: a reading that counts more hours than there were is a
      // data error the reader should see, not a machine that ran flat out.
      implausible: share !== null && share > 1.001,
      coverage: bucket.coverage,
    };
  });

  const complete = buckets.filter((bucket) => isComplete(bucket) && bucket.runtimeShare !== null);
  const measuredHours = (bucket: OperatingHoursBucket) =>
    ((new Date(bucket.periodEnd).getTime() - new Date(bucket.periodStart).getTime()) / MS_PER_HOUR) *
    bucket.coverage;
  const totalMeasured = complete.reduce((sum, bucket) => sum + measuredHours(bucket), 0);
  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    buckets,
    totalHours: round(buckets.reduce((sum, bucket) => sum + bucket.hours, 0), 1) ?? 0,
    // Weighted by period length: a January weighs more than a February.
    averageRuntimeShare:
      totalMeasured > 0
        ? ratio(complete.reduce((sum, bucket) => sum + bucket.hours, 0) / totalMeasured)
        : null,
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

  const ratioBuckets = electricity.map((bucket) => {
    const hoursBucket = hoursByKey.get(bucket.key);
    const compressorHours = hoursBucket?.consumption ?? null;
    const periodHours =
      (new Date(bucket.periodEnd).getTime() - new Date(bucket.periodStart).getTime()) / MS_PER_HOUR;
    // Both sides must be fully measured, or the ratio compares a full month
    // of electricity against a partial month of running hours; and the pump
    // must have run a meaningful share of the period at all.
    const kwhPerHour =
      compressorHours !== null &&
      compressorHours >= periodHours * MIN_COMPRESSOR_RUNTIME_SHARE &&
      isComplete(bucket) &&
      hoursBucket !== undefined &&
      isComplete(hoursBucket)
        ? bucket.consumption / compressorHours
        : null;
    return { bucket, compressorHours, kwhPerHour };
  });
  const byKey = new Map(ratioBuckets.map((entry) => [entry.bucket.key, entry.kwhPerHour]));

  const buckets = ratioBuckets.map(
    ({ bucket, compressorHours, kwhPerHour }): CompressorEfficiencyBucket => ({
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      electricityKwh: bucket.consumption,
      compressorHours,
      kwhPerHour: round(kwhPerHour),
      previousYearKwhPerHour: round(byKey.get(previousYearKey(bucket.key, granularity)) ?? null),
    }),
  );

  const withRatio = ratioBuckets.filter(
    (entry): entry is typeof entry & { kwhPerHour: number } => entry.kwhPerHour !== null,
  );
  const latest = withRatio[withRatio.length - 1] ?? null;
  const previous =
    latest === null
      ? null
      : (byKey.get(previousYearKey(latest.bucket.key, granularity)) ?? null);

  return {
    electricityMeterId,
    hoursMeterId,
    buckets,
    earliestKwhPerHour: round(withRatio[0]?.kwhPerHour ?? null),
    latestKwhPerHour: round(latest?.kwhPerHour ?? null),
    latestKey: latest?.bucket.key ?? null,
    previousYearKwhPerHour: round(previous),
    changePercent: relativeChange(previous, latest?.kwhPerHour ?? null),
    slopePerYear: round(
      linearRegressionSlopeOverTime(
        withRatio.map((entry) => ({ x: yearsAt(entry.bucket.periodStart), y: entry.kwhPerHour })),
        MIN_TREND_POINTS,
      ),
      4,
    ),
  };
}

/**
 * Daily rates per period, from the raw reading intervals rather than the
 * bucketed totals. The minimum is the point of this report, and a minimum
 * cannot be interpolated — spreading an interval across periods would erase
 * exactly the quiet stretch that reveals a leak. An interval counts for the
 * period it starts in. Intervals starting outside [from, to) are left out.
 */
export function buildWaterBaselineBuckets(
  readings: Array<{ takenAt: string; value: number }>,
  granularity: ReportGranularity,
  range: { from?: Date | null; to?: Date | null } = {},
): WaterBaselineBucket[] {
  interface Accumulator {
    rates: number[];
    lengths: number[];
    consumption: number;
    days: number;
  }
  const byKey = new Map<string, Accumulator>();

  for (let i = 0; i < readings.length - 1; i++) {
    const start = new Date(readings[i].takenAt);
    const end = new Date(readings[i + 1].takenAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (range.from && start < range.from) continue;
    if (range.to && start >= range.to) continue;

    const days = (end.getTime() - start.getTime()) / MS_PER_DAY;
    const consumption = readings[i + 1].value - readings[i].value;
    if (days <= 0 || !Number.isFinite(consumption) || consumption < 0) continue;

    const key = bucketKey(start, granularity);
    const entry = byKey.get(key) ?? { rates: [], lengths: [], consumption: 0, days: 0 };
    entry.rates.push(consumption / days);
    entry.lengths.push(days);
    entry.consumption += consumption;
    entry.days += days;
    byKey.set(key, entry);
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]): WaterBaselineBucket => {
      const shortest = Math.min(...entry.lengths);
      // With one interval the minimum is the average; the baseline only means
      // something once the readings are dense enough to separate a quiet
      // stretch from the rest of the period.
      const resolved = entry.rates.length >= 2 || shortest <= MAX_BASELINE_INTERVAL_DAYS;
      return {
        key,
        label: bucketLabel(key, granularity),
        periodStart: bucketStartIso(key, granularity),
        periodEnd: bucketEndIso(key, granularity),
        minDailyRate: resolved ? round(Math.min(...entry.rates), 4) : null,
        averageDailyRate: entry.days > 0 ? round(entry.consumption / entry.days, 4) : null,
        intervals: entry.rates.length,
        shortestIntervalDays: round(shortest, 1),
        measuredDays: round(entry.days, 1) ?? 0,
      };
    });
}

export function buildWaterBaseline(
  meter: MeterListItem,
  readings: Array<{ takenAt: string; value: number }>,
  granularity: ReportGranularity,
  range: { from?: Date | null; to?: Date | null } = {},
): WaterBaseline {
  const buckets = buildWaterBaselineBuckets(readings, granularity, range);
  const periodDays = (bucket: WaterBaselineBucket) =>
    (new Date(bucket.periodEnd).getTime() - new Date(bucket.periodStart).getTime()) / MS_PER_DAY;
  // A baseline is compared only when the period was measured to a fair share:
  // two days of readings against a full month a year earlier is not a change.
  const comparable = buckets.filter(
    (bucket) =>
      bucket.minDailyRate !== null &&
      bucket.measuredDays >= periodDays(bucket) * MIN_BASELINE_MEASURED_SHARE,
  );
  const latest = comparable[comparable.length - 1] ?? null;
  const previous =
    latest === null
      ? null
      : (comparable.find((b) => b.key === previousYearKey(latest.key, granularity)) ?? null);

  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    buckets,
    latestMinDailyRate: latest?.minDailyRate ?? null,
    latestKey: latest?.key ?? null,
    previousYearMinDailyRate: previous?.minDailyRate ?? null,
    changePercent: relativeChange(previous?.minDailyRate ?? null, latest?.minDailyRate ?? null),
    slopePerYear: round(
      linearRegressionSlopeOverTime(
        comparable.map((bucket) => ({
          x: yearsAt(bucket.periodStart),
          y: bucket.minDailyRate as number,
        })),
        MIN_TREND_POINTS,
      ),
      4,
    ),
    tooSparse: buckets.length > 0 && buckets.every((bucket) => bucket.minDailyRate === null),
  };
}

export function buildPvYield(
  meterId: number,
  capacityKwp: number,
  yearBuckets: MeterReportBucket[],
  capacityAt: (periodStart: string) => number | null = () => capacityKwp,
): PvYieldReport {
  const yieldBuckets = yearBuckets.map((bucket): PvYieldBucket => {
    const capacity = capacityAt(bucket.periodStart);
    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      productionKwh: bucket.consumption,
      capacityKwp: capacity,
      // A partial period would understate the yield and look like degradation.
      yieldPerKwp:
        isComplete(bucket) && capacity !== null && capacity > 0
          ? round(bucket.consumption / capacity, 1)
          : null,
      coverage: bucket.coverage,
    };
  });

  const measured = yieldBuckets.filter(
    (bucket): bucket is PvYieldBucket & { yieldPerKwp: number } => bucket.yieldPerKwp !== null,
  );
  const latest = measured[measured.length - 1] ?? null;
  const previous =
    latest === null ? null : (measured.find((b) => b.key === previousYearKey(latest.key, "year")) ?? null);
  const series = measured.map((bucket) => bucket.yieldPerKwp);
  const best = series.length === 0 ? null : Math.max(...series);
  // The median of the other years is a fairer reference than the best one:
  // the best year is by definition the luckiest weather, and against it every
  // ordinary year looks like decline.
  const others = latest === null ? [] : measured.filter((b) => b !== latest).map((b) => b.yieldPerKwp);
  const medianYield = round(median(others), 1);

  return {
    meterId,
    capacityKwp,
    buckets: yieldBuckets,
    latestYieldPerKwp: latest?.yieldPerKwp ?? null,
    latestKey: latest?.key ?? null,
    previousYearYieldPerKwp: previous?.yieldPerKwp ?? null,
    changeVsPreviousYearPercent: relativeChange(previous?.yieldPerKwp ?? null, latest?.yieldPerKwp ?? null),
    medianYieldPerKwp: medianYield,
    changeVsMedianPercent: relativeChange(medianYield, latest?.yieldPerKwp ?? null),
    bestYieldPerKwp: best,
    changeVsBestPercent: relativeChange(best, latest?.yieldPerKwp ?? null),
  };
}

const EQUIPMENT_ROLES: EnergyReportRole[] = ["heat_pump_total", "pv_production"];

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
  const { roleMeters, duplicateRoles } = await resolveRoleMeters(userId);
  // One load per meter and granularity, however many figures ask for it.
  const cache = new Map<string, Promise<MeterReport>>();
  const reportFor = (meterId: number, g: ReportGranularity = granularity) => {
    const key = `${meterId}:${g}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = getMeterReportForUser(userId, meterId, g, fromDate, toDate);
      cache.set(key, pending);
    }
    return pending;
  };

  const heatPumpMeter = roleMeters.get("heat_pump_total");
  const compressorMeter = visibleMeters.find((meter) => meter.role === "compressor_hours");
  const productionMeter = roleMeters.get("pv_production");
  const waterMeters = visibleMeters.filter((meter) => meter.type === "water");
  const hourMeters = visibleMeters.filter((meter) => meter.type === "operating_hours");

  const timeline = await loadEnergyTariffTimeline(userId);
  const capacityKwp = timeline.amountOf("pv_capacity_kwp");

  const [operatingHours, compressorEfficiency, waterBaselines, pvYield] = await Promise.all([
    Promise.all(
      hourMeters.map(async (meter) => buildOperatingHoursMetric(meter, await reportFor(meter.id))),
    ),
    heatPumpMeter && compressorMeter
      ? Promise.all([reportFor(heatPumpMeter.id), reportFor(compressorMeter.id)]).then(
          ([electricity, hours]) =>
            buildCompressorEfficiency(
              heatPumpMeter.id,
              compressorMeter.id,
              electricity.buckets,
              hours.buckets,
              granularity,
            ),
        )
      : Promise.resolve(null),
    Promise.all(
      waterMeters.map(async (meter) =>
        buildWaterBaseline(meter, await loadAbsoluteReadingSeries(userId, meter.id), granularity, {
          from: fromDate,
          to: toDate,
        }),
      ),
    ),
    capacityKwp !== null && capacityKwp > 0 && productionMeter
      ? reportFor(productionMeter.id, "year").then((report) =>
          buildPvYield(productionMeter.id, capacityKwp, report.buckets, (periodStart) =>
            timeline.amountAt("pv_capacity_kwp", periodStart),
          ),
        )
      : Promise.resolve(null),
  ]);

  const missingRoles = EQUIPMENT_ROLES.filter((role) => !roleMeters.has(role));
  if (!compressorMeter) missingRoles.push("compressor_hours" as EnergyReportRole);

  return {
    granularity,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    operatingHours,
    compressorEfficiency,
    waterBaselines,
    pvYield,
    missingRoles,
    duplicateRoles,
  };
}
