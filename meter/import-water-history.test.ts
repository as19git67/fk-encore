import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import { importWaterMeterHistory } from "./import-water-history";
import { waterHistoryData as DATA } from "./import/water-history-data";
import { getMeterDetail } from "./meter.service";
import { listReadings } from "./readings.service";
import * as importEndpoint from "./import";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

let userId: number;
const cleanupUserIds: number[] = [];

beforeEach(async () => {
  const [row] = await db
    .insert(users)
    .values({
      email: `water-import-${Date.now()}-${Math.random()}@example.com`,
      name: "Water Importer",
      password_hash: "x",
    })
    .returning({ id: users.id });
  userId = row.id;
  cleanupUserIds.push(userId);
  setAuth(String(userId), ["meters.view", "meters.read_entry", "meters.manage"]);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

describe("importWaterMeterHistory", () => {
  it("bundled data has the expected shape", () => {
    expect(DATA.readings).toHaveLength(222);
    expect(DATA.meter_change_events).toHaveLength(3);
  });

  it("creates one meter with four devices and all readings", async () => {
    const res = await importWaterMeterHistory(userId, DATA);
    expect(res.alreadyImported).toBe(false);
    expect(res.devices).toBe(4);
    expect(res.readings).toBe(222);

    const detail = await getMeterDetail(userId, res.meterId);
    expect(detail.type).toBe("water");
    expect(detail.unit).toBe("m³");
    expect(detail.devices).toHaveLength(4);

    // Exactly one active device (the last one), the rest closed.
    expect(detail.devices.filter((d) => d.active)).toHaveLength(1);
    const active = detail.devices.find((d) => d.active)!;
    expect(active.endValue).toBeNull();

    // Closed devices carry the sheet's final readings.
    const closedEnds = detail.devices
      .filter((d) => !d.active)
      .map((d) => d.endValue)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(closedEnds).toEqual([495, 519.9, 583.9]);

    // Absolute total equals the sheet's last cumulative value (1855.8).
    expect(detail.absoluteTotal).toBeCloseTo(1855.8, 3);
  });

  it("exposes a monotonic absolute column matching the sheet cumulatives", async () => {
    const { meterId } = await importWaterMeterHistory(userId, DATA);
    const { readings, total } = await listReadings(userId, meterId, 500, 0);
    expect(total).toBe(222);

    // Newest reading (2026-08-01, value 257) → cumulative 1855.8.
    expect(readings[0].value).toBe(257);
    expect(readings[0].absoluteValue).toBeCloseTo(1855.8, 3);

    // Absolute values are strictly non-decreasing back through time.
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i - 1].absoluteValue).toBeGreaterThanOrEqual(readings[i].absoluteValue - 1e-6);
    }
  });

  it("is idempotent — a second run writes nothing", async () => {
    const first = await importWaterMeterHistory(userId, DATA);
    const second = await importWaterMeterHistory(userId, DATA);
    expect(second.alreadyImported).toBe(true);
    expect(second.meterId).toBe(first.meterId);

    const { total } = await listReadings(userId, first.meterId, 500, 0);
    expect(total).toBe(222);
  });

  it("POST /meters/import/water-history imports via the endpoint and enforces meters.manage", async () => {
    setAuth(String(userId), ["meters.view"]);
    await expect(importEndpoint.importWaterHistory()).rejects.toMatchObject({
      code: "permission_denied",
    });

    setAuth(String(userId), ["meters.manage"]);
    const res = await importEndpoint.importWaterHistory();
    expect(res.devices).toBe(4);
    expect(res.readings).toBe(222);
  });
});
