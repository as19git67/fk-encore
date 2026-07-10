import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import { applyHistoricalVirtualDeviceSwaps, importElectricityHistory } from "./import-electricity-history";
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

  it("normalizes the 2024-12 virtual meter swaps for 1.8.0 and 2.8.0", () => {
    const normalized = applyHistoricalVirtualDeviceSwaps(DATA);

    const importMeter = DATA.find((m) => m.key === "netzstrom_bezug")!;
    expect(importMeter.devices).toHaveLength(1);
    expect(importMeter.devices[0].readings.find(([date]) => date === "2024-12-01")?.[1]).toBe(24018);

    const bezug = normalized.find((m) => m.key === "netzstrom_bezug")!;
    expect(bezug.devices).toHaveLength(2);
    expect(bezug.devices[0].endValue).toBe(23030);
    expect(bezug.devices[1].installedAt).toBe("2024-12-01");
    expect(bezug.devices[1].readings[0]).toEqual(["2024-12-01", 1600]);
    expect(bezug.devices[1].readings[bezug.devices[1].readings.length - 1]).toEqual(["2026-07-01", 12745]);

    const lieferung = normalized.find((m) => m.key === "netzstrom_lieferung")!;
    expect(lieferung.devices).toHaveLength(2);
    expect(lieferung.devices[0].endValue).toBe(15442);
    expect(lieferung.devices[1].installedAt).toBe("2024-12-01");
    expect(lieferung.devices[1].readings[0]).toEqual(["2024-12-01", 571]);
    expect(lieferung.devices[1].readings[lieferung.devices[1].readings.length - 1]).toEqual(["2026-07-01", 7927]);
  });

  it("creates 17 meters with 22 devices and all readings", async () => {
    const res = await importElectricityHistory(userId, DATA);
    expect(res.alreadyImported).toBe(false);
    expect(res.metersCreated).toBe(17);
    expect(res.devicesCreated).toBe(22);
    expect(res.readingsCreated).toBe(2003);
  }, 120_000);

  it("imports 1.8.0 and 2.8.0 post-swap readings as raw device values", async () => {
    await importElectricityHistory(userId, DATA);

    const { meterId: bezugId } = await findMeterByName(userId, "Netzstrom Bezug (1.8.0)");
    const bezug = await getMeterDetail(userId, bezugId);
    expect(bezug.devices).toHaveLength(2);
    expect(bezug.devices.find((d) => d.active)?.serialNumber).toBe("1.8.0-ab-2024-12");
    expect(bezug.devices.find((d) => !d.active)?.endValue).toBe(23030);
    const bezugReadings = await listReadings(userId, bezugId, 100, 0);
    expect(bezugReadings.readings[0].value).toBe(12745);
    expect(bezugReadings.readings[0].absoluteValue).toBe(35775);

    const { meterId: lieferungId } = await findMeterByName(userId, "Netzstrom Einspeisung (2.8.0)");
    const lieferung = await getMeterDetail(userId, lieferungId);
    expect(lieferung.devices).toHaveLength(2);
    expect(lieferung.devices.find((d) => d.active)?.serialNumber).toBe("2.8.0-ab-2024-12");
    expect(lieferung.devices.find((d) => !d.active)?.endValue).toBe(15442);
    const lieferungReadings = await listReadings(userId, lieferungId, 100, 0);
    expect(lieferungReadings.readings[0].value).toBe(7927);
    expect(lieferungReadings.readings[0].absoluteValue).toBe(23369);
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

  it("Heizungspumpe has 2 devices due to 16-bit counter overflow", async () => {
    await importElectricityHistory(userId, DATA);
    const { meterId } = await findMeterByName(userId, "Heizungspumpe");
    const detail = await getMeterDetail(userId, meterId);
    expect(detail.type).toBe("operating_hours");
    expect(detail.devices).toHaveLength(2);
    expect(detail.devices.filter((d) => d.active)).toHaveLength(1);

    const closed = detail.devices.find((d) => !d.active)!;
    expect(closed.endValue).toBe(65536);

    const readings = await listReadings(userId, meterId, 500, 0);
    const latest = readings.readings[0];
    expect(latest.absoluteValue).toBeGreaterThan(65536);
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
