import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { groupMembers, groups, meterDevices, meterReadings, meters, users } from "../db/schema";
import { computeAbsoluteTotal, listMeters as listMetersLogic } from "./meter.service";
import * as endpoints from "./meter";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `meter-test-${label}-${Date.now()}-${Math.random()}@example.com`,
      name: `Meter Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

let userId: number;
const cleanupUserIds: number[] = [];
const cleanupGroupIds: number[] = [];

beforeEach(async () => {
  userId = await createUser("owner");
  cleanupUserIds.push(userId);
  setAuth(String(userId), ["meters.view"]);
});

afterEach(async () => {
  // Users cascade to meters → devices → readings; groups clean up memberships.
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of cleanupGroupIds.splice(0)) {
    await db.delete(groups).where(eq(groups.id, id));
  }
  vi.restoreAllMocks();
});

// ── Absolute total (pure arithmetic) ─────────────────────────────────────────

describe("computeAbsoluteTotal", () => {
  it("sums consumption across a device swap (issue #792 example)", () => {
    // Water meter: device 1 ran from 102 to 734, replacement started at 3
    // and currently reads 45 → total = (734-102) + (45-3) = 674.
    expect(
      computeAbsoluteTotal([
        { startValue: 102, endValue: 734, latestValue: null },
        { startValue: 3, endValue: null, latestValue: 45 },
      ]),
    ).toBe(674);
  });

  it("counts a device without readings as zero consumption", () => {
    expect(
      computeAbsoluteTotal([{ startValue: 5, endValue: null, latestValue: null }]),
    ).toBe(0);
  });

  it("returns zero for a metering point without devices", () => {
    expect(computeAbsoluteTotal([])).toBe(0);
  });
});

// ── Listing ──────────────────────────────────────────────────────────────────

async function createMeter(ownerId: number, name: string, groupId?: number): Promise<number> {
  const [row] = await db
    .insert(meters)
    .values({
      name,
      type: "water",
      unit: "m3",
      owner_user_id: ownerId,
      group_id: groupId ?? null,
    })
    .returning({ id: meters.id });
  return row.id;
}

describe("GET /meters", () => {
  it("returns the meter with active device, latest reading and absolute total", async () => {
    const meterId = await createMeter(userId, "Wasser Haupt");

    // Replaced device: 2020-02-10 → 2025-03-21, 102 → 734.
    await db.insert(meterDevices).values({
      meter_id: meterId,
      serial_number: "OLD-1",
      installed_at: "2020-02-10T00:00:00Z",
      removed_at: "2025-03-21T00:00:00Z",
      start_value: "102",
      end_value: "734",
    });
    // Active device since 2025-03-21, started at 3.
    const [active] = await db
      .insert(meterDevices)
      .values({
        meter_id: meterId,
        serial_number: "NEW-7",
        installed_at: "2025-03-21T00:00:00Z",
        start_value: "3",
      })
      .returning({ id: meterDevices.id });
    await db.insert(meterReadings).values([
      { device_id: active.id, value: "20.5", taken_at: "2025-06-01T08:00:00Z", entered_by: userId },
      { device_id: active.id, value: "45", taken_at: "2026-01-01T08:00:00Z", entered_by: userId },
    ]);

    const res = await endpoints.listMeters();
    expect(res.meters).toHaveLength(1);
    const m = res.meters[0];
    expect(m.name).toBe("Wasser Haupt");
    expect(m.type).toBe("water");
    expect(m.activeDeviceSerial).toBe("NEW-7");
    expect(m.lastReadingValue).toBe(45);
    expect(m.lastReadingAt).toContain("2026-01-01");
    // (734 - 102) + (45 - 3)
    expect(m.absoluteTotal).toBe(674);
  });

  it("lists a meter without devices with a zero total", async () => {
    await createMeter(userId, "Strom Garage");
    const res = await endpoints.listMeters();
    expect(res.meters).toHaveLength(1);
    expect(res.meters[0].activeDeviceSerial).toBeNull();
    expect(res.meters[0].lastReadingValue).toBeNull();
    expect(res.meters[0].absoluteTotal).toBe(0);
  });

  it("hides other users' private meters but shows group meters to members", async () => {
    const otherId = await createUser("other");
    cleanupUserIds.push(otherId);
    await createMeter(otherId, "Fremder Zähler");

    const [group] = await db
      .insert(groups)
      .values({ slug: `meter-test-${Date.now()}-${Math.random()}`, name: "Haushalt" })
      .returning({ id: groups.id });
    cleanupGroupIds.push(group.id);
    await db.insert(groupMembers).values({ group_id: group.id, user_id: userId });
    await createMeter(otherId, "Gas Haushalt", group.id);

    const visible = await listMetersLogic(userId);
    expect(visible.map((m) => m.name)).toEqual(["Gas Haushalt"]);
  });

  it("rejects callers without meters.view", async () => {
    setAuth(String(userId), []);
    await expect(endpoints.listMeters()).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
});
