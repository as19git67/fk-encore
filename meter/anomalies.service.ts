/**
 * Utility meters — anomaly detection (Issue #792, Etappe 7 / #1015).
 *
 * A daily job turns the latest reading intervals of every metering point into
 * daily consumption rates and compares them with what came before:
 *
 *  - **rolling baseline** — mean and standard deviation of the daily rate over
 *    the preceding intervals (z-score);
 *  - **seasonality** — the rate of the same span one year earlier. A January
 *    that is merely a January must not be flagged against an autumn baseline.
 *
 * Findings:
 *
 *  - `consumption_spike` / `consumption_drop` — the rate is several standard
 *    deviations away from the baseline *and* clearly different from the same
 *    time last year (a leak, an appliance left running, a typo one digit off).
 *  - `standstill` — an operating-hours counter that stopped advancing although
 *    it usually runs (pump failed, breaker tripped).
 *  - `negative_consumption` — the absolute total went backwards, which the
 *    per-device validation cannot catch across a badly configured device swap.
 *
 * The detector is a pure function over the absolute reading series; the job
 * around it only loads series and upserts rows. Rows are keyed on
 * (meter, type, interval end) so a re-run never duplicates a finding, and
 * pending findings whose interval is no longer anomalous (the typo was fixed)
 * are withdrawn on the next run.
 */

import { asc, and, eq, gte, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  meterAnomalies,
  meterReadings,
  meters,
  type MeterAnomalyType,
  type MeterType,
} from "../db/schema";
import { loadDeviceOffsets } from "./meter.service";

// -----------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------

/** Only intervals ending within this window are evaluated — older findings are not actionable. */
export const ANOMALY_RECENCY_DAYS = 60;
/** Preceding intervals that form the baseline. */
const BASELINE_WINDOW = 12;
/** Minimum baseline intervals before a z-score means anything. */
const BASELINE_MIN = 4;
/** z-score from which a rate counts as unusual. */
const Z_THRESHOLD = 3;
/**
 * Floor for the baseline standard deviation, relative to the mean. Twelve
 * near-identical monthly readings give a tiny stddev that would turn every
 * ordinary wobble into a five-sigma event.
 */
const STDDEV_FLOOR_RATIO = 0.1;
/** The rate must also differ from the baseline by at least this share. */
const MIN_RELATIVE_CHANGE = 0.5;
/** Within this band of last year's rate the change is considered seasonal. */
const SEASONAL_BAND = 0.25;
/** Intervals shorter than this are too noisy to judge. */
const MIN_INTERVAL_DAYS = 0.5;
/** An operating-hours counter must stand still at least this long. */
const STANDSTILL_MIN_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export interface SeriesPoint {
  readingId: number;
  takenAt: string;
  /** Absolute (monotonic across device swaps) value. */
  value: number;
}

export interface DetectedAnomaly {
  type: MeterAnomalyType;
  /** z-score against the baseline; null where not meaningful. */
  score: number | null;
  intervalStart: string;
  intervalEnd: string;
  /** Reading that closes the interval. */
  readingId: number;
  details: Record<string, unknown>;
}

interface Interval {
  start: SeriesPoint;
  end: SeriesPoint;
  days: number;
  consumption: number;
  rate: number;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildIntervals(series: SeriesPoint[]): Interval[] {
  const sorted = [...series].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const intervals: Interval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const days = (new Date(end.takenAt).getTime() - new Date(start.takenAt).getTime()) / MS_PER_DAY;
    if (!Number.isFinite(days) || days < MIN_INTERVAL_DAYS) continue;
    const consumption = end.value - start.value;
    if (!Number.isFinite(consumption)) continue;
    intervals.push({ start, end, days, consumption, rate: consumption / days });
  }
  return intervals;
}

/** Mean daily rate over the part of `intervals` that overlaps [from, to). */
function rateOver(intervals: Interval[], from: number, to: number): number | null {
  let consumption = 0;
  let days = 0;
  for (const interval of intervals) {
    if (interval.consumption < 0) continue;
    const s = new Date(interval.start.takenAt).getTime();
    const e = new Date(interval.end.takenAt).getTime();
    const overlap = Math.min(e, to) - Math.max(s, from);
    if (overlap <= 0) continue;
    const share = overlap / (e - s);
    consumption += interval.consumption * share;
    days += (overlap / MS_PER_DAY);
  }
  if (days <= 0) return null;
  return consumption / days;
}

/**
 * Pure detector. `now` bounds the recency window; only intervals ending
 * within ANOMALY_RECENCY_DAYS before it are judged, everything earlier only
 * feeds the baseline and the seasonal reference.
 */
export function detectMeterAnomalies(
  series: SeriesPoint[],
  meterType: MeterType,
  now: Date = new Date(),
): DetectedAnomaly[] {
  const intervals = buildIntervals(series);
  const recencyStart = now.getTime() - ANOMALY_RECENCY_DAYS * MS_PER_DAY;
  const findings: DetectedAnomaly[] = [];

  intervals.forEach((interval, index) => {
    const endMs = new Date(interval.end.takenAt).getTime();
    if (endMs < recencyStart) return;

    const base = {
      intervalStart: interval.start.takenAt,
      intervalEnd: interval.end.takenAt,
      readingId: interval.end.readingId,
    };
    const common = {
      days: round(interval.days, 2),
      consumption: round(interval.consumption),
      rate: round(interval.rate),
      startValue: interval.start.value,
      endValue: interval.end.value,
    };

    if (interval.consumption < 0) {
      findings.push({ ...base, type: "negative_consumption", score: null, details: common });
      return;
    }

    // Baseline: the preceding non-negative intervals, newest BASELINE_WINDOW.
    const history = intervals
      .slice(0, index)
      .filter((prev) => prev.consumption >= 0)
      .slice(-BASELINE_WINDOW);
    if (history.length < BASELINE_MIN) return;

    // Rates weighted by interval length, so a two-day reading does not count
    // as much as a full month.
    const totalDays = history.reduce((sum, prev) => sum + prev.days, 0);
    const mean = history.reduce((sum, prev) => sum + prev.rate * prev.days, 0) / totalDays;
    const variance =
      history.reduce((sum, prev) => sum + prev.days * (prev.rate - mean) ** 2, 0) / totalDays;
    const stddev = Math.max(Math.sqrt(variance), mean * STDDEV_FLOOR_RATIO);

    const startMs = new Date(interval.start.takenAt).getTime();
    const seasonalRate = rateOver(
      intervals.slice(0, index),
      startMs - 365 * MS_PER_DAY,
      endMs - 365 * MS_PER_DAY,
    );

    const details = {
      ...common,
      baselineMean: round(mean),
      baselineStddev: round(stddev),
      baselineIntervals: history.length,
      seasonalRate: seasonalRate === null ? null : round(seasonalRate),
    };

    if (meterType === "operating_hours" && mean > 0 && interval.consumption === 0) {
      if (interval.days >= STANDSTILL_MIN_DAYS) {
        const z = stddev > 0 ? (interval.rate - mean) / stddev : null;
        findings.push({
          ...base,
          type: "standstill",
          score: z === null ? null : round(z, 2),
          details,
        });
      }
      return;
    }

    if (mean <= 0 || stddev <= 0) return;
    const z = (interval.rate - mean) / stddev;

    if (z >= Z_THRESHOLD && interval.rate >= mean * (1 + MIN_RELATIVE_CHANGE)) {
      if (seasonalRate !== null && interval.rate <= seasonalRate * (1 + SEASONAL_BAND)) return;
      findings.push({ ...base, type: "consumption_spike", score: round(z, 2), details });
      return;
    }
    if (z <= -Z_THRESHOLD && interval.rate <= mean * (1 - MIN_RELATIVE_CHANGE)) {
      if (seasonalRate !== null && interval.rate >= seasonalRate * (1 - SEASONAL_BAND)) return;
      findings.push({ ...base, type: "consumption_drop", score: round(z, 2), details });
    }
  });

  return findings;
}

// -----------------------------------------------------------------------
// Job
// -----------------------------------------------------------------------

/** Absolute series of a metering point including reading ids (no visibility check — job use). */
export async function loadSeriesForJob(meterId: number): Promise<SeriesPoint[]> {
  const { devices, offsets } = await loadDeviceOffsets(meterId);
  if (devices.length === 0) return [];

  const rows = await dbAll<{ id: number; device_id: number; value: string; taken_at: string }>(
    db
      .select({
        id: meterReadings.id,
        device_id: meterReadings.device_id,
        value: meterReadings.value,
        taken_at: meterReadings.taken_at,
      })
      .from(meterReadings)
      .where(inArray(meterReadings.device_id, devices.map((d) => d.id)))
      .orderBy(asc(meterReadings.taken_at), asc(meterReadings.id)),
  );
  return rows.map((row) => {
    const offset = offsets.get(row.device_id);
    const raw = parseFloat(row.value);
    return {
      readingId: Number(row.id),
      takenAt: row.taken_at,
      value: offset ? offset.baseOffset + raw - offset.startValue : raw,
    };
  });
}

export interface AnomalyRunResult {
  meters: number;
  anomaliesFound: number;
  anomaliesCreated: number;
  anomaliesWithdrawn: number;
}

/** Evaluate every metering point and upsert the findings. */
export async function runMeterAnomalyDetection(now: Date = new Date()): Promise<AnomalyRunResult> {
  const meterRows = await dbAll<{ id: number; type: MeterType }>(
    db.select({ id: meters.id, type: meters.type }).from(meters),
  );
  const result: AnomalyRunResult = {
    meters: meterRows.length,
    anomaliesFound: 0,
    anomaliesCreated: 0,
    anomaliesWithdrawn: 0,
  };
  const recencyStart = new Date(now.getTime() - ANOMALY_RECENCY_DAYS * MS_PER_DAY).toISOString();

  for (const meter of meterRows) {
    const series = await loadSeriesForJob(meter.id);
    const findings = detectMeterAnomalies(series, meter.type, now);
    result.anomaliesFound += findings.length;

    for (const finding of findings) {
      const inserted = await db
        .insert(meterAnomalies)
        .values({
          meter_id: meter.id,
          reading_id: finding.readingId,
          type: finding.type,
          score: finding.score === null ? null : finding.score.toFixed(3),
          interval_start: finding.intervalStart,
          interval_end: finding.intervalEnd,
          details: finding.details,
        })
        .onConflictDoNothing({
          target: [meterAnomalies.meter_id, meterAnomalies.type, meterAnomalies.interval_end],
        })
        .returning({ id: meterAnomalies.id });
      result.anomaliesCreated += inserted.length;
    }

    // Withdraw pending findings inside the window that did not come back —
    // the reading was corrected, so the alert is stale.
    const keep = findings.map((f) => `${f.type}|${new Date(f.intervalEnd).toISOString()}`);
    const pending = await dbAll<{ id: number; type: string; interval_end: string }>(
      db
        .select({
          id: meterAnomalies.id,
          type: meterAnomalies.type,
          interval_end: meterAnomalies.interval_end,
        })
        .from(meterAnomalies)
        .where(
          and(
            eq(meterAnomalies.meter_id, meter.id),
            eq(meterAnomalies.status, "pending"),
            gte(meterAnomalies.interval_end, recencyStart),
          ),
        ),
    );
    const stale = pending
      .filter((row) => !keep.includes(`${row.type}|${new Date(row.interval_end).toISOString()}`))
      .map((row) => Number(row.id));
    if (stale.length > 0) {
      await db.delete(meterAnomalies).where(inArray(meterAnomalies.id, stale));
      result.anomaliesWithdrawn += stale.length;
    }
  }

  return result;
}

