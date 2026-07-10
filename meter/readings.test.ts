import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { meterDevices, meterReadings, meters, users } from "../db/schema";
import * as endpoints from "./readings";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `reading-test-${label}-${Date.now()}-${Math.random()}@example.com`,
      name: `Reading Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

async function createMeter(ownerId: number): Promise<number> {
  const [row] = await db
    .insert(meters)
    .values({ name: "Wasser", type: "water", unit: "m3", owner_user_id: ownerId, decimals: 0 })
    .returning({ id: meters.id });
  return row.id;
}

async function addDevice(
  meterId: number,
  opts: { start: number; installedAt: string; removedAt?: string; end?: number; serial?: string },
): Promise<number> {
  const [row] = await db
    .insert(meterDevices)
    .values({
      meter_id: meterId,
      serial_number: opts.serial ?? null,
      installed_at: opts.installedAt,
      removed_at: opts.removedAt ?? null,
      start_value: opts.start.toFixed(3),
      end_value: opts.end !== undefined ? opts.end.toFixed(3) : null,
    })
    .returning({ id: meterDevices.id });
  return row.id;
}

let userId: number;
let meterId: number;
let deviceId: number;
const cleanupUserIds: number[] = [];

const ALL = ["meters.view", "meters.read_entry", "meters.manage"];

beforeEach(async () => {
  userId = await createUser("owner");
  cleanupUserIds.push(userId);
  meterId = await createMeter(userId);
  deviceId = await addDevice(meterId, { start: 0, installedAt: "2024-01-01T00:00:00Z", serial: "A" });
  setAuth(String(userId), ALL);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

describe("POST /meters/:id/readings", () => {
  it("records a manual reading on the active device", async () => {
    const { id } = await endpoints.addReading({ id: meterId, value: 123, takenAt: "2024-02-01T08:00:00Z" });
    expect(id).toBeGreaterThan(0);
    const rows = await db.select().from(meterReadings).where(eq(meterReadings.id, id));
    expect(rows[0].source).toBe("manual");
    expect(rows[0].entered_by).toBe(userId);
    expect(parseFloat(rows[0].value)).toBe(123);
  });

  it("defaults takenAt to now when omitted", async () => {
    const { id } = await endpoints.addReading({ id: meterId, value: 5 });
    const rows = await db.select().from(meterReadings).where(eq(meterReadings.id, id));
    expect(rows[0].taken_at).toBeTruthy();
  });

  it("rejects a value below the device start value", async () => {
    const d2meter = await createMeter(userId);
    await addDevice(d2meter, { start: 100, installedAt: "2024-01-01T00:00:00Z" });
    await expect(
      endpoints.addReading({ id: d2meter, value: 50, takenAt: "2024-02-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects a value below the previous reading", async () => {
    await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-02-01T00:00:00Z" });
    await expect(
      endpoints.addReading({ id: meterId, value: 90, takenAt: "2024-03-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects a back-dated value above the following reading", async () => {
    await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-03-01T00:00:00Z" });
    // Inserting an earlier reading larger than the later one breaks monotonicity.
    await expect(
      endpoints.addReading({ id: meterId, value: 120, takenAt: "2024-02-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("allows a valid back-dated reading between two others", async () => {
    await endpoints.addReading({ id: meterId, value: 50, takenAt: "2024-02-01T00:00:00Z" });
    await endpoints.addReading({ id: meterId, value: 150, takenAt: "2024-04-01T00:00:00Z" });
    const { id } = await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-03-01T00:00:00Z" });
    expect(id).toBeGreaterThan(0);
  });

  it("rejects a duplicate timestamp", async () => {
    await endpoints.addReading({ id: meterId, value: 10, takenAt: "2024-02-01T00:00:00Z" });
    await expect(
      endpoints.addReading({ id: meterId, value: 20, takenAt: "2024-02-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "already_exists" });
  });

  it("fails when the meter has no active device", async () => {
    await db
      .update(meterDevices)
      .set({ removed_at: "2024-06-01T00:00:00Z", end_value: "0" })
      .where(eq(meterDevices.id, deviceId));
    await expect(
      endpoints.addReading({ id: meterId, value: 1, takenAt: "2024-07-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("requires meters.read_entry", async () => {
    setAuth(String(userId), ["meters.view"]);
    await expect(
      endpoints.addReading({ id: meterId, value: 1 }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("GET /meters/:id/readings", () => {
  it("returns readings newest-first with a monotonic absolute column across a device swap", async () => {
    // Rebuild the meter as a closed device 102→734 + active device from 3.
    await db.delete(meterDevices).where(eq(meterDevices.id, deviceId));
    const oldDev = await addDevice(meterId, {
      start: 102,
      end: 734,
      installedAt: "2020-02-10T00:00:00Z",
      removedAt: "2025-03-21T00:00:00Z",
      serial: "OLD",
    });
    const newDev = await addDevice(meterId, { start: 3, installedAt: "2025-03-21T00:00:00Z", serial: "NEW" });
    await db.insert(meterReadings).values([
      { device_id: oldDev, value: "500", taken_at: "2023-01-01T00:00:00Z", entered_by: userId },
      { device_id: newDev, value: "45", taken_at: "2026-01-01T00:00:00Z", entered_by: userId },
    ]);

    const res = await endpoints.listReadings({ id: meterId });
    expect(res.total).toBe(2);
    // Newest first: the reading on the new device.
    expect(res.readings[0].value).toBe(45);
    expect(res.readings[0].deviceSerial).toBe("NEW");
    // Absolute = (734-102) + (45-3) = 674.
    expect(res.readings[0].absoluteValue).toBe(674);
    // Old device reading of 500 → absolute = 0 + (500-102) = 398.
    expect(res.readings[1].value).toBe(500);
    expect(res.readings[1].absoluteValue).toBe(398);
  });

  it("paginates via limit/offset", async () => {
    for (let i = 1; i <= 5; i++) {
      await endpoints.addReading({ id: meterId, value: i * 10, takenAt: `2024-0${i}-01T00:00:00Z` });
    }
    const page = await endpoints.listReadings({ id: meterId, limit: 2, offset: 0 });
    expect(page.readings).toHaveLength(2);
    expect(page.total).toBe(5);
    // Newest first → 50 then 40.
    expect(page.readings.map((r) => r.value)).toEqual([50, 40]);
  });
});

describe("PUT/DELETE /meters/readings/:readingId", () => {
  it("edits an own reading with meters.read_entry", async () => {
    const { id } = await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-02-01T00:00:00Z" });
    setAuth(String(userId), ["meters.view", "meters.read_entry"]);
    await endpoints.updateReading({ readingId: id, value: 110, takenAt: "2024-02-02T00:00:00Z" });
    const rows = await db.select().from(meterReadings).where(eq(meterReadings.id, id));
    expect(parseFloat(rows[0].value)).toBe(110);
  });

  it("rejects editing another user's reading without meters.manage", async () => {
    const { id } = await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-02-01T00:00:00Z" });
    // Make the owning meter visible to a second user via a shared... simplest:
    // the reading was entered by `userId`; a different visible user without
    // manage cannot edit it. Reassign entered_by to a different user.
    const otherId = await createUser("other");
    cleanupUserIds.push(otherId);
    await db.update(meterReadings).set({ entered_by: otherId }).where(eq(meterReadings.id, id));

    setAuth(String(userId), ["meters.view", "meters.read_entry"]);
    await expect(
      endpoints.updateReading({ readingId: id, value: 110, takenAt: "2024-02-02T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    // With manage it succeeds.
    setAuth(String(userId), ["meters.view", "meters.read_entry", "meters.manage"]);
    await endpoints.updateReading({ readingId: id, value: 110, takenAt: "2024-02-02T00:00:00Z" });
    const rows = await db.select().from(meterReadings).where(eq(meterReadings.id, id));
    expect(parseFloat(rows[0].value)).toBe(110);
  });

  it("re-validates monotonicity on edit", async () => {
    await endpoints.addReading({ id: meterId, value: 50, takenAt: "2024-02-01T00:00:00Z" });
    const { id } = await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-03-01T00:00:00Z" });
    // Lowering the later reading below the earlier one is rejected.
    await expect(
      endpoints.updateReading({ readingId: id, value: 40, takenAt: "2024-03-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("deletes an own reading", async () => {
    const { id } = await endpoints.addReading({ id: meterId, value: 100, takenAt: "2024-02-01T00:00:00Z" });
    await endpoints.deleteReading({ readingId: id });
    const rows = await db.select().from(meterReadings).where(eq(meterReadings.id, id));
    expect(rows).toHaveLength(0);
  });

  it("returns not_found for an unknown reading", async () => {
    await expect(
      endpoints.deleteReading({ readingId: 999999 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
