/**
 * Utility meters — consumption trends (Issue #792, Etappe 6b).
 *
 * Answers "am I using more or less than before?" per category. Raw monthly
 * figures cannot answer that on their own: heating in January and in July
 * differ by an order of magnitude, so a regression over twelve raw months
 * mostly measures the season. Everything here therefore runs on the
 * **rolling 12-month sum**, in which the seasons cancel out.
 */

import { listMeters } from "./meter.service";
import {
  buildEnergyReportFromMeterReports,
  getMeterReportForUser,
  resolveRoleMeters,
  roundReportValue,
  COMPLETE_COVERAGE_THRESHOLD,
  type EnergyReportRole,
  type MeterReport,
} from "./reports.service";

/** Relative change below which a trend counts as flat rather than a direction. */
const STABLE_BAND = 0.02;

/**
 * Minimum rolling-12 points before a regression slope is meaningful.
 * Consecutive rolling windows overlap by eleven months, so three of them are
 * almost one observation; six (17 months of data) is the least that can be
 * called a direction.
 */
export const MIN_SLOPE_POINTS = 6;

/** What the reported direction is based on. */
export type TrendDirectionBasis = "year_over_year" | "regression" | "none";

export type TrendDirection = "rising" | "falling" | "stable" | "unknown";

export interface TrendPoint {
  key: string;
  label: string;
  /** Consumption in that month; null if the month is not fully measured. */
  value: number | null;
  /** That month plus the eleven before it; null if any of them is missing. */
  rolling12: number | null;
}

export interface ConsumptionTrend {
  key: string;
  label: string;
  unit: string;
  decimals: number;
  /** Meters feeding this figure, for drill-down in the UI. */
  meterIds: number[];
  /** Last twelve fully measured months. */
  current12: number | null;
  /** The twelve months before those. */
  previous12: number | null;
  changeAbsolute: number | null;
  changePercent: number | null;
  /** Change of the annual total per year, from a regression over rolling12. */
  slopePerYear: number | null;
  /** Rolling-12 points the regression ran over. */
  trendPoints: number;
  direction: TrendDirection;
  /** Whether the direction compares two full years or reads the regression. */
  directionBasis: TrendDirectionBasis;
  monthsAvailable: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  points: TrendPoint[];
}

export interface ConsumptionTrendsReport {
  generatedAt: string;
  trends: ConsumptionTrend[];
}

interface TrendSample {
  key: string;
  label: string;
  value: number | null;
  coverage: number;
}

function monthIndex(key: string): number {
  const [year, month] = key.split("-");
  return Number(year) * 12 + (Number(month) - 1);
}

function monthKeyFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${month}.${year}`;
}

function monthStartIso(key: string): string {
  return `${key}-01T00:00:00.000Z`;
}

function monthEndIso(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return (month === 12
    ? new Date(Date.UTC(year + 1, 0, 1))
    : new Date(Date.UTC(year, month, 1))
  ).toISOString();
}

/**
 * Least-squares slope of y over x. The caller chooses x: for a contiguous
 * monthly series the index will do, for anything with gaps it has to be time —
 * a regression over list positions squeezes a missing year out of the axis
 * and overstates the slope.
 */
export function linearRegressionSlopeOverTime(
  points: Array<{ x: number; y: number }>,
  minPoints = MIN_SLOPE_POINTS,
): number | null {
  if (points.length < minPoints) return null;
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    numerator += dx * (point.y - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Slope per step of a contiguous, equally spaced series. */
export function linearRegressionSlope(values: number[], minPoints = MIN_SLOPE_POINTS): number | null {
  return linearRegressionSlopeOverTime(
    values.map((y, x) => ({ x, y })),
    minPoints,
  );
}

const MS_PER_YEAR = 365.25 * 86_400_000;

/** A period's position on a time axis measured in years, for regressions with gaps. */
export function yearsAt(periodStart: string): number {
  return new Date(periodStart).getTime() / MS_PER_YEAR;
}

export function computeConsumptionTrend(
  key: string,
  label: string,
  unit: string,
  decimals: number,
  meterIds: number[],
  samples: TrendSample[],
): ConsumptionTrend {
  const measured = new Map<string, number>();
  for (const sample of samples) {
    if (sample.value === null) continue;
    if (sample.coverage < COMPLETE_COVERAGE_THRESHOLD) continue;
    measured.set(sample.key, sample.value);
  }

  const empty: ConsumptionTrend = {
    key,
    label,
    unit,
    decimals,
    meterIds,
    current12: null,
    previous12: null,
    changeAbsolute: null,
    changePercent: null,
    slopePerYear: null,
    trendPoints: 0,
    direction: "unknown",
    directionBasis: "none",
    monthsAvailable: measured.size,
    rangeStart: null,
    rangeEnd: null,
    points: [],
  };
  if (measured.size === 0) return empty;

  const indices = [...measured.keys()].map(monthIndex);
  const firstIndex = Math.min(...indices);
  const lastIndex = Math.max(...indices);

  const points: TrendPoint[] = [];
  for (let index = firstIndex; index <= lastIndex; index++) {
    const monthKey = monthKeyFromIndex(index);
    const value = measured.get(monthKey) ?? null;

    // A rolling sum is only defined when all twelve months were measured;
    // a gap must not silently look like a drop in consumption.
    let rolling12: number | null = null;
    if (index - firstIndex >= 11) {
      let sum = 0;
      let complete = true;
      for (let offset = 0; offset < 12; offset++) {
        const monthValue = measured.get(monthKeyFromIndex(index - offset));
        if (monthValue === undefined) {
          complete = false;
          break;
        }
        sum += monthValue;
      }
      if (complete) rolling12 = roundReportValue(sum, decimals);
    }

    points.push({ key: monthKey, label: monthLabel(monthKey), value, rolling12 });
  }

  const lastRollingPos = points.findLastIndex((point) => point.rolling12 !== null);
  if (lastRollingPos === -1) return { ...empty, points };

  const current12 = points[lastRollingPos].rolling12;
  const previousPos = lastRollingPos - 12;
  const previous12 = previousPos >= 0 ? points[previousPos].rolling12 : null;

  // Regression over the contiguous run of rolling values ending at the latest
  // one — an older, disconnected run says nothing about the current trend.
  const tail: number[] = [];
  for (let pos = lastRollingPos; pos >= 0; pos--) {
    const rolling = points[pos].rolling12;
    if (rolling === null) break;
    tail.unshift(rolling);
  }
  const slopePerMonth = linearRegressionSlope(tail);
  const slopePerYear =
    slopePerMonth === null ? null : roundReportValue(slopePerMonth * 12, decimals);

  const changeAbsolute =
    current12 !== null && previous12 !== null
      ? roundReportValue(current12 - previous12, decimals)
      : null;
  const changePercent =
    current12 !== null && previous12 !== null && previous12 > 0
      ? Math.round(((current12 - previous12) / previous12) * 1000) / 1000
      : null;

  let direction: TrendDirection = "unknown";
  let directionBasis: TrendDirectionBasis = "none";
  const relative =
    changePercent ??
    (slopePerYear !== null && current12 !== null && current12 > 0
      ? slopePerYear / current12
      : null);
  if (relative !== null) {
    direction = Math.abs(relative) < STABLE_BAND ? "stable" : relative > 0 ? "rising" : "falling";
    directionBasis = changePercent !== null ? "year_over_year" : "regression";
  }

  const rangeStartPos = Math.max(0, lastRollingPos - 11);
  return {
    key,
    label,
    unit,
    decimals,
    meterIds,
    current12,
    previous12,
    changeAbsolute,
    changePercent,
    slopePerYear,
    trendPoints: tail.length,
    direction,
    directionBasis,
    monthsAvailable: measured.size,
    rangeStart: monthStartIso(points[rangeStartPos].key),
    rangeEnd: monthEndIso(points[lastRollingPos].key),
    points,
  };
}

function samplesFromMeterReport(report: MeterReport): TrendSample[] {
  return report.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: bucket.consumption,
    coverage: bucket.coverage,
  }));
}

/** Roles that get their own trend tile, in display order. */
const ROLE_TRENDS: Array<{ role: EnergyReportRole; key: string; label: string }> = [
  { role: "heat_heating_total", key: "heating", label: "Heizung" },
  { role: "hot_water_total", key: "hot_water", label: "Warmwasser" },
  { role: "ev_charger_total", key: "ev_charger", label: "E-Auto / Wallbox" },
  { role: "grid_import", key: "grid_import", label: "Netzbezug" },
];

export async function getConsumptionTrendsForUser(
  userId: number,
): Promise<ConsumptionTrendsReport> {
  const visibleMeters = await listMeters(userId);
  const { roleMeters } = await resolveRoleMeters(userId);

  // One report per meter, whatever role or type asks for it.
  const reportCache = new Map<number, Promise<MeterReport>>();
  const reportFor = (meterId: number) => {
    let pending = reportCache.get(meterId);
    if (!pending) {
      pending = getMeterReportForUser(userId, meterId, "month", null, null);
      reportCache.set(meterId, pending);
    }
    return pending;
  };

  const reports: Partial<Record<EnergyReportRole, MeterReport>> = {};
  for (const [role, meter] of roleMeters) {
    reports[role] = await reportFor(meter.id);
  }

  const trends: ConsumptionTrend[] = [];

  // Household electricity is derived, not metered: total consumption minus the
  // heat pump and the wallbox. It needs the PV figures, so it comes from the
  // aggregate energy report rather than a single meter.
  const energy = buildEnergyReportFromMeterReports(reports, "month", null, null);
  if (energy.buckets.length > 0) {
    trends.push(
      computeConsumptionTrend(
        "household",
        "Haushaltsstrom (ohne Wärmepumpe und Wallbox)",
        energy.unit,
        energy.decimals,
        [...roleMeters.values()].map((meter) => meter.id),
        energy.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          value: bucket.consumptionWithoutHeatPumpAndEv,
          coverage: bucket.coverage,
        })),
      ),
    );
  }

  const tiled = new Set<number>();
  for (const { role, key, label } of ROLE_TRENDS) {
    const report = reports[role];
    const meter = roleMeters.get(role);
    if (!report || !meter) continue;
    tiled.add(meter.id);
    trends.push(
      computeConsumptionTrend(
        key,
        label,
        report.unit,
        report.decimals,
        [meter.id],
        samplesFromMeterReport(report),
      ),
    );
  }

  // Water and gas meters get their own tile — unless a role already gave
  // them one (a gas heating meter with the heating role).
  for (const meter of visibleMeters) {
    if (meter.type !== "water" && meter.type !== "gas") continue;
    if (tiled.has(meter.id)) continue;
    const report = await reportFor(meter.id);
    trends.push(
      computeConsumptionTrend(
        `meter:${meter.id}`,
        meter.name,
        report.unit,
        report.decimals,
        [meter.id],
        samplesFromMeterReport(report),
      ),
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    trends: trends.filter((trend) => trend.monthsAvailable > 0),
  };
}
