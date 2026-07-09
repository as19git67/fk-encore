/**
 * Utility meters module — business logic (Issue #792).
 *
 * Domain model: a `meters` row is the logical metering point; the physical
 * device installed there for a period lives in `meter_devices`. When a
 * device is swapped, the new one starts at 0 (or any value), so the
 * user-facing "absolute total" of a metering point is the sum of per-device
 * consumption and is monotonic across swaps:
 *
 *   total = Σ over devices of ((end_value ?? latest reading ?? start_value) - start_value)
 *
 * Visibility follows the documents module: a meter is visible to its owner
 * and, when `group_id` is set, to every member of that group.
 */

import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  groupMembers,
  meterDevices,
  meterReadings,
  meters,
  type MeterType,
} from "../db/schema";

export const METER_TYPES: readonly MeterType[] = [
  "electricity",
  "water",
  "gas",
  "operating_hours",
];

export interface DeviceState {
  startValue: number;
  endValue: number | null;
  /** Latest reading value on this device, if any. */
  latestValue: number | null;
}

/**
 * Absolute total of a metering point across device swaps. Pure function so
 * the arithmetic is unit-testable without a database.
 */
export function computeAbsoluteTotal(devices: DeviceState[]): number {
  let total = 0;
  for (const d of devices) {
    const current = d.endValue ?? d.latestValue ?? d.startValue;
    total += current - d.startValue;
  }
  return total;
}

/** Every group id the user belongs to (visibility scope). */
export async function loadUserGroupIds(userId: number): Promise<number[]> {
  const rows = await dbAll<{ group_id: number }>(
    db
      .select({ group_id: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, userId)),
  );
  return rows.map((r) => r.group_id);
}

/** Drizzle WHERE fragment selecting every meter visible to `userId`. */
export function visibleMetersWhere(userId: number, groupIds: number[]): SQL {
  const ownerMatch = eq(meters.owner_user_id, userId);
  if (groupIds.length === 0) return ownerMatch;
  return or(ownerMatch, inArray(meters.group_id, groupIds))!;
}

export interface MeterListItem {
  id: number;
  name: string;
  type: MeterType;
  unit: string;
  location: string | null;
  notes: string | null;
  decimals: number;
  groupId: number | null;
  ownerUserId: number;
  /** Serial number of the currently installed device, if one exists. */
  activeDeviceSerial: string | null;
  /** Latest reading on the active device. */
  lastReadingValue: number | null;
  lastReadingAt: string | null;
  /** Absolute, monotonic total across all devices of this metering point. */
  absoluteTotal: number;
}

/** All meters visible to the user, with active device + latest reading. */
export async function listMeters(userId: number): Promise<MeterListItem[]> {
  const groupIds = await loadUserGroupIds(userId);
  const meterRows = await dbAll<typeof meters.$inferSelect>(
    db
      .select()
      .from(meters)
      .where(visibleMetersWhere(userId, groupIds))
      .orderBy(meters.name),
  );
  if (meterRows.length === 0) return [];

  const meterIds = meterRows.map((m) => m.id);
  const deviceRows = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(inArray(meterDevices.meter_id, meterIds)),
  );

  // Latest reading per device — one query, newest-first, first row per
  // device wins. Household-scale data, so no window functions needed yet.
  const deviceIds = deviceRows.map((d) => d.id);
  const latestByDevice = new Map<number, { value: number; taken_at: string }>();
  if (deviceIds.length > 0) {
    const readingRows = await dbAll<{ device_id: number; value: string; taken_at: string }>(
      db
        .select({
          device_id: meterReadings.device_id,
          value: meterReadings.value,
          taken_at: meterReadings.taken_at,
        })
        .from(meterReadings)
        .where(inArray(meterReadings.device_id, deviceIds))
        .orderBy(desc(meterReadings.taken_at)),
    );
    for (const r of readingRows) {
      if (!latestByDevice.has(r.device_id)) {
        latestByDevice.set(r.device_id, { value: parseFloat(r.value), taken_at: r.taken_at });
      }
    }
  }

  return meterRows.map((m) => {
    const devices = deviceRows.filter((d) => d.meter_id === m.id);
    const active = devices.find((d) => d.removed_at === null) ?? null;
    const activeLatest = active ? latestByDevice.get(active.id) ?? null : null;

    const absoluteTotal = computeAbsoluteTotal(
      devices.map((d) => ({
        startValue: parseFloat(d.start_value),
        endValue: d.end_value !== null ? parseFloat(d.end_value) : null,
        latestValue: latestByDevice.get(d.id)?.value ?? null,
      })),
    );

    return {
      id: m.id,
      name: m.name,
      type: m.type,
      unit: m.unit,
      location: m.location,
      notes: m.notes,
      decimals: m.decimals,
      groupId: m.group_id,
      ownerUserId: m.owner_user_id,
      activeDeviceSerial: active?.serial_number ?? null,
      lastReadingValue: activeLatest?.value ?? null,
      lastReadingAt: activeLatest?.taken_at ?? null,
      absoluteTotal,
    };
  });
}

// ── CRUD + device management (Etappe 2) ──────────────────────────────────────

export interface DeviceDto {
  id: number;
  serialNumber: string | null;
  installedAt: string;
  removedAt: string | null;
  startValue: number;
  endValue: number | null;
  notes: string | null;
  /** True for the currently installed device (removedAt === null). */
  active: boolean;
}

export interface MeterDetail extends MeterListItem {
  createdAt: string;
  updatedAt: string;
  photoPath: string | null;
  /** Full device history, newest installation first. */
  devices: DeviceDto[];
}

export interface InitialDeviceInput {
  serialNumber?: string;
  /** ISO timestamp the device was installed. */
  installedAt: string;
  startValue?: number;
}

export interface CreateMeterInput {
  name: string;
  type: MeterType;
  unit: string;
  location?: string;
  notes?: string;
  decimals?: number;
  groupId?: number | null;
  device: InitialDeviceInput;
}

export interface UpdateMeterInput {
  name: string;
  type: MeterType;
  unit: string;
  location?: string;
  notes?: string;
  decimals?: number;
  groupId?: number | null;
}

export interface ReplaceDeviceInput {
  /** Moment of the swap; becomes removedAt (old) and installedAt (new). */
  swapAt: string;
  /** Closing reading of the outgoing device. */
  finalValue: number;
  newSerialNumber?: string;
  newStartValue?: number;
}

/**
 * Load a meter the caller may see (owner or group member), else throw
 * `not_found` — deliberately masking existence for meters outside the
 * caller's scope. Used by both view and manage paths (manage additionally
 * needs the `meters.manage` permission, checked at the endpoint).
 */
export async function loadVisibleMeter(
  userId: number,
  meterId: number,
): Promise<typeof meters.$inferSelect> {
  const groupIds = await loadUserGroupIds(userId);
  const [row] = await dbAll<typeof meters.$inferSelect>(
    db
      .select()
      .from(meters)
      .where(and(eq(meters.id, meterId), visibleMetersWhere(userId, groupIds))),
  );
  if (!row) throw APIError.notFound("meter not found");
  return row;
}

function normalizeType(type: string): MeterType {
  if (!METER_TYPES.includes(type as MeterType)) {
    throw APIError.invalidArgument(
      `type must be one of: ${METER_TYPES.join(", ")}`,
    );
  }
  return type as MeterType;
}

function normalizeDecimals(decimals: number | undefined): number {
  if (decimals === undefined) return 1;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) {
    throw APIError.invalidArgument("decimals must be an integer in 0..3");
  }
  return decimals;
}

function normalizeName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw APIError.invalidArgument("name must not be empty");
  return trimmed;
}

function normalizeUnit(unit: string): string {
  const trimmed = (unit ?? "").trim();
  if (!trimmed) throw APIError.invalidArgument("unit must not be empty");
  return trimmed;
}

/** When a group is assigned, the caller must belong to it (no cross-posting). */
async function assertGroupAssignable(
  userId: number,
  groupId: number | null | undefined,
): Promise<number | null> {
  if (groupId === undefined || groupId === null) return null;
  const groupIds = await loadUserGroupIds(userId);
  if (!groupIds.includes(groupId)) {
    throw APIError.invalidArgument("you are not a member of this group");
  }
  return groupId;
}

function toIso(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw APIError.invalidArgument(`${field} is not a valid timestamp`);
  }
  return d.toISOString();
}

export async function createMeter(
  userId: number,
  input: CreateMeterInput,
): Promise<{ id: number }> {
  const name = normalizeName(input.name);
  const type = normalizeType(input.type);
  const unit = normalizeUnit(input.unit);
  const decimals = normalizeDecimals(input.decimals);
  const groupId = await assertGroupAssignable(userId, input.groupId);

  if (!input.device) {
    throw APIError.invalidArgument("an initial device is required");
  }
  const installedAt = toIso(input.device.installedAt, "device.installedAt");
  const startValue = input.device.startValue ?? 0;
  if (!Number.isFinite(startValue) || startValue < 0) {
    throw APIError.invalidArgument("device.startValue must be >= 0");
  }

  const id = await db.transaction(async (tx) => {
    const [meter] = await tx
      .insert(meters)
      .values({
        name,
        type,
        unit,
        location: input.location?.trim() || null,
        notes: input.notes?.trim() || null,
        decimals,
        owner_user_id: userId,
        group_id: groupId,
      })
      .returning({ id: meters.id });
    await tx.insert(meterDevices).values({
      meter_id: meter.id,
      serial_number: input.device.serialNumber?.trim() || null,
      installed_at: installedAt,
      start_value: startValue.toFixed(3),
    });
    return meter.id;
  });
  return { id };
}

export async function updateMeter(
  userId: number,
  meterId: number,
  input: UpdateMeterInput,
): Promise<void> {
  await loadVisibleMeter(userId, meterId);
  const name = normalizeName(input.name);
  const type = normalizeType(input.type);
  const unit = normalizeUnit(input.unit);
  const decimals = normalizeDecimals(input.decimals);
  const groupId = await assertGroupAssignable(userId, input.groupId);

  await db
    .update(meters)
    .set({
      name,
      type,
      unit,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
      decimals,
      group_id: groupId,
      updated_at: new Date().toISOString(),
    })
    .where(eq(meters.id, meterId));
}

export async function deleteMeter(userId: number, meterId: number): Promise<void> {
  await loadVisibleMeter(userId, meterId);
  await db.delete(meters).where(eq(meters.id, meterId));
}

export async function getMeterDetail(
  userId: number,
  meterId: number,
): Promise<MeterDetail> {
  const m = await loadVisibleMeter(userId, meterId);

  const deviceRows = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(desc(meterDevices.installed_at)),
  );

  const deviceIds = deviceRows.map((d) => d.id);
  const latestByDevice = new Map<number, { value: number; taken_at: string }>();
  if (deviceIds.length > 0) {
    const readingRows = await dbAll<{ device_id: number; value: string; taken_at: string }>(
      db
        .select({
          device_id: meterReadings.device_id,
          value: meterReadings.value,
          taken_at: meterReadings.taken_at,
        })
        .from(meterReadings)
        .where(inArray(meterReadings.device_id, deviceIds))
        .orderBy(desc(meterReadings.taken_at)),
    );
    for (const r of readingRows) {
      if (!latestByDevice.has(r.device_id)) {
        latestByDevice.set(r.device_id, { value: parseFloat(r.value), taken_at: r.taken_at });
      }
    }
  }

  const active = deviceRows.find((d) => d.removed_at === null) ?? null;
  const activeLatest = active ? latestByDevice.get(active.id) ?? null : null;
  const absoluteTotal = computeAbsoluteTotal(
    deviceRows.map((d) => ({
      startValue: parseFloat(d.start_value),
      endValue: d.end_value !== null ? parseFloat(d.end_value) : null,
      latestValue: latestByDevice.get(d.id)?.value ?? null,
    })),
  );

  return {
    id: m.id,
    name: m.name,
    type: m.type,
    unit: m.unit,
    location: m.location,
    notes: m.notes,
    decimals: m.decimals,
    groupId: m.group_id,
    ownerUserId: m.owner_user_id,
    photoPath: m.photo_path,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    activeDeviceSerial: active?.serial_number ?? null,
    lastReadingValue: activeLatest?.value ?? null,
    lastReadingAt: activeLatest?.taken_at ?? null,
    absoluteTotal,
    devices: deviceRows.map((d) => ({
      id: d.id,
      serialNumber: d.serial_number,
      installedAt: d.installed_at,
      removedAt: d.removed_at,
      startValue: parseFloat(d.start_value),
      endValue: d.end_value !== null ? parseFloat(d.end_value) : null,
      notes: d.notes,
      active: d.removed_at === null,
    })),
  };
}

/**
 * Atomic device swap: close the currently installed device with a final
 * reading and install a replacement. Enforces monotonicity — the closing
 * value must not fall below the outgoing device's start value or its latest
 * reading, and the swap must happen after that reading.
 */
export async function replaceDevice(
  userId: number,
  meterId: number,
  input: ReplaceDeviceInput,
): Promise<{ newDeviceId: number }> {
  await loadVisibleMeter(userId, meterId);

  const swapAt = toIso(input.swapAt, "swapAt");
  const finalValue = input.finalValue;
  if (!Number.isFinite(finalValue)) {
    throw APIError.invalidArgument("finalValue must be a number");
  }
  const newStartValue = input.newStartValue ?? 0;
  if (!Number.isFinite(newStartValue) || newStartValue < 0) {
    throw APIError.invalidArgument("newStartValue must be >= 0");
  }

  const [active] = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(and(eq(meterDevices.meter_id, meterId), isNull(meterDevices.removed_at))),
  );
  if (!active) {
    throw APIError.failedPrecondition("meter has no active device to replace");
  }

  const startValue = parseFloat(active.start_value);
  if (finalValue < startValue) {
    throw APIError.invalidArgument(
      `finalValue (${finalValue}) must be >= the device's start value (${startValue})`,
    );
  }
  if (new Date(swapAt).getTime() < new Date(active.installed_at).getTime()) {
    throw APIError.invalidArgument("swapAt must be at or after the device's installation");
  }

  // The closing reading must not undercut the last recorded reading, and the
  // swap must not predate it.
  const [latest] = await dbAll<{ value: string; taken_at: string }>(
    db
      .select({ value: meterReadings.value, taken_at: meterReadings.taken_at })
      .from(meterReadings)
      .where(eq(meterReadings.device_id, active.id))
      .orderBy(desc(meterReadings.taken_at))
      .limit(1),
  );
  if (latest) {
    if (finalValue < parseFloat(latest.value)) {
      throw APIError.invalidArgument(
        `finalValue (${finalValue}) must be >= the last reading (${latest.value})`,
      );
    }
    if (new Date(swapAt).getTime() < new Date(latest.taken_at).getTime()) {
      throw APIError.invalidArgument("swapAt must be at or after the last reading");
    }
  }

  const newDeviceId = await db.transaction(async (tx) => {
    await tx
      .update(meterDevices)
      .set({ removed_at: swapAt, end_value: finalValue.toFixed(3) })
      .where(eq(meterDevices.id, active.id));
    const [created] = await tx
      .insert(meterDevices)
      .values({
        meter_id: meterId,
        serial_number: input.newSerialNumber?.trim() || null,
        installed_at: swapAt,
        start_value: newStartValue.toFixed(3),
      })
      .returning({ id: meterDevices.id });
    return created.id;
  });

  return { newDeviceId };
}
