import { APIError } from "encore.dev/api";
import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { meterDevices, meterReadings } from "../db/schema";
import { loadVisibleMeter } from "./meter.service";

export type ReportGranularity = "month" | "year";

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
}

export interface MeterReport {
  meterId: number;
  name: string;
  unit: string;
  decimals: number;
  granularity: ReportGranularity;
  from: string | null;
  to: string | null;
  buckets: MeterReportBucket[];
  totalConsumption: number;
}

export function parseReportBoundary(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument(`${field} is not a valid date`);
  }
  return date;
}

function bucketKey(date: Date, granularity: ReportGranularity): string {
  const year = date.getUTCFullYear();
  if (granularity === "year") return String(year);
  return `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function bucketLabel(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") return key;
  const [year, month] = key.split("-");
  return `${month}.${year}`;
}

function bucketStartIso(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") return `${key}-01-01T00:00:00.000Z`;
  return `${key}-01T00:00:00.000Z`;
}

function bucketEndIso(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") {
    return `${Number(key) + 1}-01-01T00:00:00.000Z`;
  }
  const [yearRaw, monthRaw] = key.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const next = month === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month, 1));
  return next.toISOString();
}

export function roundReportValue(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

export function buildMeterReportBuckets(
  readings: AbsoluteReadingPoint[],
  granularity: ReportGranularity,
  options: { from?: Date | null; to?: Date | null; decimals?: number } = {},
): MeterReportBucket[] {
  const sorted = [...readings].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const from = options.from ?? null;
  const to = options.to ?? null;
  const decimals = options.decimals ?? 3;
  const buckets = new Map<string, MeterReportBucket>();

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const startDate = new Date(start.takenAt);
    const endDate = new Date(end.takenAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) continue;
    if (from && startDate < from) continue;
    if (to && startDate >= to) continue;

    const consumption = end.value - start.value;
    if (!Number.isFinite(consumption) || consumption < 0) continue;

    const key = bucketKey(startDate, granularity);
    const existing = buckets.get(key);
    if (existing) {
      existing.endReadingAt = end.takenAt;
      existing.endValue = end.value;
      existing.consumption = roundReportValue(existing.consumption + consumption, decimals);
      existing.intervals += 1;
    } else {
      buckets.set(key, {
        key,
        label: bucketLabel(key, granularity),
        periodStart: bucketStartIso(key, granularity),
        periodEnd: bucketEndIso(key, granularity),
        startReadingAt: start.takenAt,
        endReadingAt: end.takenAt,
        startValue: start.value,
        endValue: end.value,
        consumption: roundReportValue(consumption, decimals),
        intervals: 1,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function loadAbsoluteReadingSeries(
  userId: number,
  meterId: number,
): Promise<AbsoluteReadingPoint[]> {
  await loadVisibleMeter(userId, meterId);

  const devices = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(asc(meterDevices.installed_at), asc(meterDevices.id)),
  );
  if (devices.length === 0) return [];

  const baseByDevice = new Map<number, { base: number; start: number }>();
  let running = 0;
  for (const device of devices) {
    const start = parseFloat(device.start_value);
    baseByDevice.set(device.id, { base: running, start });
    if (device.end_value !== null) {
      running += parseFloat(device.end_value) - start;
    }
  }

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
    const base = baseByDevice.get(reading.device_id);
    const rawValue = parseFloat(reading.value);
    return {
      takenAt: reading.taken_at,
      value: base ? base.base + rawValue - base.start : rawValue,
    };
  });
}

export async function getMeterReportForUser(
  userId: number,
  meterId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
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
  });

  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    decimals: meter.decimals,
    granularity,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    buckets,
    totalConsumption: roundReportValue(
      buckets.reduce((sum, bucket) => sum + bucket.consumption, 0),
      meter.decimals,
    ),
  };
}
