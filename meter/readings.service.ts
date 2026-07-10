/**
 * Utility meters — reading capture & history (Issue #792, Etappe 3).
 *
 * A reading belongs to a physical device. Manual entry always targets the
 * metering point's currently installed device. Values are monotonic *within
 * a device*: a new reading must not fall below the reading immediately before
 * it (or the device's start value) and must not exceed the reading
 * immediately after it — so back-dated corrections stay consistent.
 *
 * The list exposes an `absoluteValue` per reading: the monotonic cumulative
 * total of the whole metering point at that reading, computed by adding the
 * consumption of every earlier (already-closed) device to
 * `reading.value - device.startValue`.
 */

import { and, asc, count, desc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { meterDevices, meterReadings } from "../db/schema";
import { loadVisibleMeter } from "./meter.service";

export interface ReadingDto {
  id: number;
  deviceId: number;
  deviceSerial: string | null;
  value: number;
  takenAt: string;
  source: string;
  notes: string | null;
  enteredBy: number | null;
  /** Monotonic cumulative total of the metering point at this reading. */
  absoluteValue: number;
}

export interface AddReadingInput {
  value: number;
  /** ISO timestamp; defaults to now when omitted. */
  takenAt?: string;
  notes?: string;
}

export interface UpdateReadingInput {
  value: number;
  takenAt: string;
  notes?: string;
}

function toIso(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw APIError.invalidArgument(`${field} is not a valid timestamp`);
  }
  return d.toISOString();
}

/**
 * Per-device base offset: the summed consumption of every device installed
 * before it. Only closed devices (end_value set) precede another device, so
 * the offset is deterministic without needing per-device readings.
 */
async function deviceBaseOffsets(
  meterId: number,
): Promise<Map<number, { baseOffset: number; startValue: number; serial: string | null }>> {
  const devices = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(asc(meterDevices.installed_at), asc(meterDevices.id)),
  );
  const map = new Map<number, { baseOffset: number; startValue: number; serial: string | null }>();
  let running = 0;
  for (const d of devices) {
    const startValue = parseFloat(d.start_value);
    map.set(d.id, { baseOffset: running, startValue, serial: d.serial_number });
    if (d.end_value !== null) {
      running += parseFloat(d.end_value) - startValue;
    }
  }
  return map;
}

/** Active (currently installed) device of a metering point, or throw. */
async function activeDevice(meterId: number): Promise<typeof meterDevices.$inferSelect> {
  const [active] = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(and(eq(meterDevices.meter_id, meterId), isNull(meterDevices.removed_at))),
  );
  if (!active) {
    throw APIError.failedPrecondition("meter has no active device to record a reading on");
  }
  return active;
}

/**
 * Enforce monotonicity of `value` at `takenAt` on `device`, ignoring the
 * reading `excludeId` (used when editing in place).
 */
async function assertMonotonic(
  device: typeof meterDevices.$inferSelect,
  value: number,
  takenAt: string,
  excludeId?: number,
): Promise<void> {
  const startValue = parseFloat(device.start_value);
  if (value < startValue) {
    throw APIError.invalidArgument(
      `value (${value}) must be >= the device's start value (${startValue})`,
    );
  }

  const notSelf = excludeId !== undefined ? ne(meterReadings.id, excludeId) : undefined;

  const prev = await dbFirst<{ value: string }>(
    db
      .select({ value: meterReadings.value })
      .from(meterReadings)
      .where(
        and(
          eq(meterReadings.device_id, device.id),
          lt(meterReadings.taken_at, takenAt),
          notSelf,
        ),
      )
      .orderBy(desc(meterReadings.taken_at))
      .limit(1),
  );
  if (prev && value < parseFloat(prev.value)) {
    throw APIError.invalidArgument(
      `value (${value}) must be >= the previous reading (${prev.value})`,
    );
  }

  const next = await dbFirst<{ value: string }>(
    db
      .select({ value: meterReadings.value })
      .from(meterReadings)
      .where(
        and(
          eq(meterReadings.device_id, device.id),
          gt(meterReadings.taken_at, takenAt),
          notSelf,
        ),
      )
      .orderBy(asc(meterReadings.taken_at))
      .limit(1),
  );
  if (next && value > parseFloat(next.value)) {
    throw APIError.invalidArgument(
      `value (${value}) must be <= the following reading (${next.value})`,
    );
  }
}

export async function addReading(
  userId: number,
  meterId: number,
  input: AddReadingInput,
): Promise<{ id: number }> {
  await loadVisibleMeter(userId, meterId);
  if (!Number.isFinite(input.value)) {
    throw APIError.invalidArgument("value must be a number");
  }
  const takenAt = input.takenAt ? toIso(input.takenAt, "takenAt") : new Date().toISOString();
  const device = await activeDevice(meterId);
  await assertMonotonic(device, input.value, takenAt);

  try {
    const [row] = await db
      .insert(meterReadings)
      .values({
        device_id: device.id,
        value: input.value.toFixed(3),
        taken_at: takenAt,
        source: "manual",
        notes: input.notes?.trim() || null,
        entered_by: userId,
      })
      .returning({ id: meterReadings.id });
    return { id: row.id };
  } catch (err: any) {
    // Unique (device_id, taken_at) — a reading already exists at that instant.
    // The native driver surfaces the SQLSTATE on `code`; drizzle wraps it and
    // exposes it on `cause.code`.
    if ((err?.code ?? err?.cause?.code) === "23505") {
      throw APIError.alreadyExists("a reading already exists at this timestamp");
    }
    throw err;
  }
}

export async function listReadings(
  userId: number,
  meterId: number,
  limit = 100,
  offset = 0,
): Promise<{ readings: ReadingDto[]; total: number }> {
  await loadVisibleMeter(userId, meterId);
  const offsets = await deviceBaseOffsets(meterId);

  const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const boundedOffset = Math.max(0, Math.floor(offset));

  const rows = await dbAll<typeof meterReadings.$inferSelect>(
    db
      .select()
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterReadings.device_id, meterDevices.id))
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(desc(meterReadings.taken_at), desc(meterReadings.id))
      .limit(boundedLimit)
      .offset(boundedOffset)
      .then((res: any[]) => res.map((r) => r.meter_readings)),
  );

  const countRow = await dbFirst<{ count: number }>(
    db
      .select({ count: count() })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterReadings.device_id, meterDevices.id))
      .where(eq(meterDevices.meter_id, meterId)),
  );

  const readings: ReadingDto[] = rows.map((r) => {
    const dev = offsets.get(r.device_id);
    const value = parseFloat(r.value);
    const absoluteValue = dev ? dev.baseOffset + (value - dev.startValue) : value;
    return {
      id: r.id,
      deviceId: r.device_id,
      deviceSerial: dev?.serial ?? null,
      value,
      takenAt: r.taken_at,
      source: r.source,
      notes: r.notes,
      enteredBy: r.entered_by,
      absoluteValue,
    };
  });

  return { readings, total: Number(countRow?.count ?? readings.length) };
}

/** Load a reading + its device + owning meter, enforcing edit permission. */
async function loadEditableReading(
  userId: number,
  hasManage: boolean,
  readingId: number,
): Promise<{ reading: typeof meterReadings.$inferSelect; device: typeof meterDevices.$inferSelect }> {
  const reading = await dbFirst<typeof meterReadings.$inferSelect>(
    db.select().from(meterReadings).where(eq(meterReadings.id, readingId)),
  );
  if (!reading) throw APIError.notFound("reading not found");

  const device = await dbFirst<typeof meterDevices.$inferSelect>(
    db.select().from(meterDevices).where(eq(meterDevices.id, reading.device_id)),
  );
  if (!device) throw APIError.notFound("reading not found");

  // Enforces visibility (owner/group) — throws not_found otherwise.
  await loadVisibleMeter(userId, device.meter_id);

  // Editing someone else's reading requires the manage permission.
  if (reading.entered_by !== userId && !hasManage) {
    throw APIError.permissionDenied("editing another user's reading requires meters.manage");
  }
  return { reading, device };
}

export async function updateReading(
  userId: number,
  hasManage: boolean,
  readingId: number,
  input: UpdateReadingInput,
): Promise<void> {
  const { reading, device } = await loadEditableReading(userId, hasManage, readingId);
  if (!Number.isFinite(input.value)) {
    throw APIError.invalidArgument("value must be a number");
  }
  const takenAt = toIso(input.takenAt, "takenAt");
  await assertMonotonic(device, input.value, takenAt, reading.id);

  try {
    await db
      .update(meterReadings)
      .set({
        value: input.value.toFixed(3),
        taken_at: takenAt,
        notes: input.notes?.trim() || null,
      })
      .where(eq(meterReadings.id, readingId));
  } catch (err: any) {
    if ((err?.code ?? err?.cause?.code) === "23505") {
      throw APIError.alreadyExists("a reading already exists at this timestamp");
    }
    throw err;
  }
}

export async function deleteReading(
  userId: number,
  hasManage: boolean,
  readingId: number,
): Promise<void> {
  await loadEditableReading(userId, hasManage, readingId);
  await db.delete(meterReadings).where(eq(meterReadings.id, readingId));
}
