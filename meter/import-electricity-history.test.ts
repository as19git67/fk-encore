import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import {
  applyHistoricalVirtualDeviceSwaps,
  consolidateHistoricalReportMeters,
  importElectricityHistory,
} from "./import-electricity-history";
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
    const reportMeters = consolidateHistoricalReportMeters(DATA);
    const normalized = applyHistoricalVirtualDeviceSwaps(reportMeters);

    const importMeter = DATA.find((m) => m.key === "netzstrom_bezug")!;
    expect(importMeter.devices).toHaveLength(1);
    expect(importMeter.devices[0].readings.find(([date]) => date === "2024-12-01")?.[1]).toBe(24018);

    const bezug = normalized.find((m) => m.key === "netzstrom_bezug")!;
    expect(bezug.devices).toHaveLength(3);
    expect(bezug.devices[0].serial).toBe("historisch-hausstrom-wp-ht-nt");
    expect(bezug.devices[0].endValue).toBe(184484);
    expect(bezug.devices[1].startValue).toBe(4726);
    expect(bezug.devices[1].endValue).toBe(23030);
    expect(bezug.devices[2].installedAt).toBe("2024-12-01");
    expect(bezug.devices[2].readings[0]).toEqual(["2024-12-01", 1600]);
    expect(bezug.devices[2].readings[bezug.devices[2].readings.length - 1]).toEqual(["2026-07-01", 12745]);

    const lieferung = normalized.find((m) => m.key === "netzstrom_lieferung")!;
    expect(lieferung.devices).toHaveLength(2);
    expect(lieferung.devices[0].endValue).toBe(15442);
    expect(lieferung.devices[1].installedAt).toBe("2024-12-01");
    expect(lieferung.devices[1].readings[0]).toEqual(["2024-12-01", 571]);
    expect(lieferung.devices[1].readings[lieferung.devices[1].readings.length - 1]).toEqual(["2026-07-01", 7927]);
  });

  it("consolidates legacy parallel meters into modern report meters", () => {
    const consolidated = consolidateHistoricalReportMeters(DATA);

    expect(consolidated).toHaveLength(14);
    expect(consolidated.find((m) => m.key === "hausstrom")).toBeUndefined();
    expect(consolidated.find((m) => m.key === "waermepumpe_ht")).toBeUndefined();
    expect(consolidated.find((m) => m.key === "waermepumpe_nt")).toBeUndefined();

    const bezug = consolidated.find((m) => m.key === "netzstrom_bezug")!;
    expect(bezug.devices).toHaveLength(2);
    expect(bezug.devices[0]).toMatchObject({
      serial: "historisch-hausstrom-wp-ht-nt",
      startValue: 0,
      endValue: 184484,
      installedAt: "2008-01-01",
      removedAt: "2021-05-01",
    });
    expect(bezug.devices[0].readings[0]).toEqual(["2008-01-01", 16234.2]);
    expect(bezug.devices[0].readings[bezug.devices[0].readings.length - 1]).toEqual([
      "2021-04-01",
      184109,
    ]);
    expect(bezug.devices[1].startValue).toBe(4726);

    const waermepumpe = consolidated.find((m) => m.key === "waermepumpe_komplett")!;
    expect(waermepumpe.devices).toHaveLength(2);
    expect(waermepumpe.devices[0]).toMatchObject({
      serial: "historisch-wp-ht-nt",
      startValue: 0,
      endValue: 105145,
      installedAt: "2006-09-20",
      removedAt: "2022-12-01",
    });
    expect(waermepumpe.devices[0].readings[0]).toEqual(["2006-09-20", 409.1]);
    expect(waermepumpe.devices[0].readings[waermepumpe.devices[0].readings.length - 1]).toEqual([
      "2021-05-01",
      105145,
    ]);
    expect(waermepumpe.devices[1].startValue).toBe(41);
  });

  it("sets explicit report roles on imported energy meters", async () => {
    await importElectricityHistory(userId, DATA);

    const { meterId: bezugId } = await findMeterByName(userId, "Netzstrom Bezug (1.8.0)");
    const { meterId: einspeisungId } = await findMeterByName(userId, "Netzstrom Einspeisung (2.8.0)");
    const { meterId: produktionId } = await findMeterByName(userId, "PV Produktion");
    const { meterId: waermepumpeId } = await findMeterByName(userId, "Wärmepumpe Komplett");
    const { meterId: heizungId } = await findMeterByName(userId, "Fußbodenheizung");
    const { meterId: heizungPvId } = await findMeterByName(userId, "Fußbodenheizung PV");
    const { meterId: warmwasserId } = await findMeterByName(userId, "Warmwasser");
    const { meterId: warmwasserPvId } = await findMeterByName(userId, "Warmwasser PV");
    const { meterId: wallboxId } = await findMeterByName(userId, "E-Auto Wallbox");
    const { meterId: wallboxPvId } = await findMeterByName(userId, "E-Auto PV-Laden");

    await expect(getMeterDetail(userId, bezugId)).resolves.toMatchObject({ role: "grid_import" });
    await expect(getMeterDetail(userId, einspeisungId)).resolves.toMatchObject({ role: "grid_export" });
    await expect(getMeterDetail(userId, produktionId)).resolves.toMatchObject({ role: "pv_production" });
    await expect(getMeterDetail(userId, waermepumpeId)).resolves.toMatchObject({ role: "heat_pump_total" });
    await expect(getMeterDetail(userId, heizungId)).resolves.toMatchObject({ role: "heat_heating_total" });
    await expect(getMeterDetail(userId, heizungPvId)).resolves.toMatchObject({ role: "heat_heating_pv" });
    await expect(getMeterDetail(userId, warmwasserId)).resolves.toMatchObject({ role: "hot_water_total" });
    await expect(getMeterDetail(userId, warmwasserPvId)).resolves.toMatchObject({ role: "hot_water_pv" });
    await expect(getMeterDetail(userId, wallboxId)).resolves.toMatchObject({ role: "ev_charger_total" });
    await expect(getMeterDetail(userId, wallboxPvId)).resolves.toMatchObject({ role: "ev_charger_pv" });
  }, 120_000);

  // Guards the gap that left the wallbox out of the energy report for months:
  // the roles existed in the schema and the report read them, but the import
  // never assigned them, so every wallbox figure silently stayed null.
  it("assigns every defined meter role", async () => {
    await importElectricityHistory(userId, DATA);

    const assigned = new Set(
      (await listMeters(userId)).map((meter) => meter.role).filter((role) => role !== null),
    );
    expect([...assigned].sort()).toEqual([...METER_ROLES].sort());
  }, 120_000);

  it("creates 14 report-friendly meters with 19 devices and consolidated readings", async () => {
    const res = await importElectricityHistory(userId, DATA);
    expect(res.alreadyImported).toBe(false);
    expect(res.metersCreated).toBe(14);
    expect(res.devicesCreated).toBe(19);
    expect(res.readingsCreated).toBe(1780);
  }, 120_000);

  it("imports 1.8.0 and 2.8.0 post-swap readings as raw device values", async () => {
    await importElectricityHistory(userId, DATA);

    const { meterId: bezugId } = await findMeterByName(userId, "Netzstrom Bezug (1.8.0)");
    const bezug = await getMeterDetail(userId, bezugId);
    expect(bezug.devices).toHaveLength(3);
    expect(bezug.devices.find((d) => d.active)?.serialNumber).toBe("1.8.0-ab-2024-12");
    expect(
      bezug.devices
        .map((d) => d.endValue)
        .filter((v) => v !== null)
        .sort((a, b) => a - b),
    ).toEqual([23030, 184484]);
    const bezugReadings = await listReadings(userId, bezugId, 100, 0);
    expect(bezugReadings.readings[0].value).toBe(12745);
    expect(bezugReadings.readings[0].absoluteValue).toBe(215533);

    const { meterId: lieferungId } = await findMeterByName(userId, "Netzstrom Einspeisung (2.8.0)");
    const lieferung = await getMeterDetail(userId, lieferungId);
    expect(lieferung.devices).toHaveLength(2);
    expect(lieferung.devices.find((d) => d.active)?.serialNumber).toBe("2.8.0-ab-2024-12");
    expect(lieferung.devices.find((d) => !d.active)?.endValue).toBe(15442);
    const lieferungReadings = await listReadings(userId, lieferungId, 100, 0);
    expect(lieferungReadings.readings[0].value).toBe(7927);
    expect(lieferungReadings.readings[0].absoluteValue).toBe(23369);
  }, 120_000);

  it("imports Wärmepumpe Komplett with the old HT/NT history folded in", async () => {
    await importElectricityHistory(userId, DATA);

    await expect(findMeterByName(userId, "Hausstrom")).rejects.toThrow('meter "Hausstrom" not found');
    await expect(findMeterByName(userId, "Wärmepumpe HT")).rejects.toThrow('meter "Wärmepumpe HT" not found');
    await expect(findMeterByName(userId, "Wärmepumpe NT")).rejects.toThrow('meter "Wärmepumpe NT" not found');

    const { meterId } = await findMeterByName(userId, "Wärmepumpe Komplett");
    const detail = await getMeterDetail(userId, meterId);

    expect(detail.type).toBe("electricity");
    expect(detail.unit).toBe("kWh");
    expect(detail.devices).toHaveLength(2);
    expect(detail.devices.filter((d) => d.active)).toHaveLength(1);

    const active = detail.devices.find((d) => d.active)!;
    expect(active.serialNumber).toBeNull();
    expect(active.endValue).toBeNull();
    expect(active.startValue).toBe(41);

    const closed = detail.devices.find((d) => !d.active)!;
    expect(closed.serialNumber).toBe("historisch-wp-ht-nt");
    expect(closed.endValue).toBe(105145);

    const readings = await listReadings(userId, meterId, 100, 0);
    expect(readings.readings[0].value).toBe(15399);
    expect(readings.readings[0].absoluteValue).toBe(120503);
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

import { listMeters, METER_ROLES } from "./meter.service";
async function findMeterByName(uid: number, name: string) {
  const meterList = await listMeters(uid);
  const m = meterList.find((m) => m.name === name);
  if (!m) throw new Error(`meter "${name}" not found`);
  return { meterId: m.id };
}
