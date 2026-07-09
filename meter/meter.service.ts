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

import { desc, eq, inArray, or, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  groupMembers,
  meterDevices,
  meterReadings,
  meters,
  type MeterType,
} from "../db/schema";

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
