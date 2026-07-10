import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import { importElectricityHistory } from "./import-electricity-history";
import { electricityHistoryData as DATA } from "./import/electricity-history-data";
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
      email: `elec-import-${Date.now()}-${Math.random()}@example.com`,
      name: "Elec Importer",
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

describe("importElectricityHistory", () => {
  it("bundled data has the expected shape", () => {
    expect(DATA.length).toBe(17);
    const totalReadings = DATA.reduce(
      (s, m) => s + m.devices.reduce((s2, d) => s2 + d.readings.length, 0),
      0,
    );
    expect(totalReadings).toBe(2003);
  });

  it("creates 17 meters with 19 devices and all readings", async () => {
    const res = await importElectricityHistory(userId, DATA);
    expect(res.alreadyImported).toBe(false);
    expect(res.metersCreated).toBe(17);
    expect(res.devicesCreated).toBe(19);
    expect(res.readingsCreated).toBe(2003);
  }, 120_000);

  it("Hausstrom has 3 devices with correct device swaps", async () => {
    await importElectricityHistory(userId, DATA);

    // Find the Hausstrom meter — it's the first in the data
    const hausstromDef = DATA.find((m) => m.key === "hausstrom")!;
    expect(hausstromDef.name).toBe("Hausstrom");

    // Use listReadings to find the meter ID by walking our created meters
    // (we know the import creates meters in order)
    const { meterId } = await findMeterByName(userId, "Hausstrom");
    const detail = await getMeterDetail(userId, meterId);

    expect(detail.type).toBe("electricity");
    expect(detail.unit).toBe("kWh");
    expect(detail.devices).toHaveLength(3);
    expect(detail.devices.filter((d) => d.active)).toHaveLength(1);

    // Active device is the newest (1EFR2375190547)
    const active = detail.devices.find((d) => d.active)!;
    expect(active.serialNumber).toBe("1EFR2375190547");
    expect(active.endValue).toBeNull();

    // Closed device end values match the change events
    const closedEnds = detail.devices
      .filter((d) => !d.active)
      .map((d) => d.endValue)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(closedEnds).toEqual([22418, 74613]);
  }, 120_000);

  it("operating-hours meters are created with correct type", async () => {
    await importElectricityHistory(userId, DATA);
    const { meterId } = await findMeterByName(userId, "Verdichter");
    const detail = await getMeterDetail(userId, meterId);
    expect(detail.type).toBe("operating_hours");
    expect(detail.unit).toBe("h");
    expect(detail.devices).toHaveLength(1);
  }, 120_000);

  it("is idempotent — a second run writes nothing", async () => {
    const first = await importElectricityHistory(userId, DATA);
    const second = await importElectricityHistory(userId, DATA);
    expect(second.alreadyImported).toBe(true);
    expect(second.metersCreated).toBe(0);
  }, 120_000);

  it("POST endpoint enforces meters.manage", async () => {
    setAuth(String(userId), ["meters.view"]);
    await expect(importEndpoint.importElecHistory()).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
});

import { listMeters } from "./meter.service";
async function findMeterByName(uid: number, name: string) {
  const meterList = await listMeters(uid);
  const m = meterList.find((m) => m.name === name);
  if (!m) throw new Error(`meter "${name}" not found`);
  return { meterId: m.id };
}
