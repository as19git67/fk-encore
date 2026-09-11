import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { meterDevices, meterElectricityTariffs, meterReadings, meters, users } from "../db/schema";
import {
  computeMonthlyDegreeDays,
  fillDegreeDaysForUser,
  lastArchivedMonth,
  monthRange,
  HEATING_BASE_C,
} from "./degree-days.service";
import {
  parseDailyMeans,
  parseGeocodeCandidates,
  setArchiveClient,
  setGeocodingClient,
  resetArchiveClient,
  resetGeocodingClient,
  OpenMeteoUnavailableError,
  type ArchiveClient,
  type DailyMeanTemperature,
} from "./open-meteo-client";
import * as endpoints from "./home-location";

function daysOf(month: string, meanC: number | ((day: number) => number | null)): DailyMeanTemperature[] {
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => ({
    day: `${month}-${String(i + 1).padStart(2, "0")}`,
    meanC: typeof meanC === "function" ? meanC(i + 1) : meanC,
  }));
}

describe("computeMonthlyDegreeDays", () => {
  it("sums (20 − T) over days below the heating limit", () => {
    // January: every day 0 °C → 31 × 20 = 620 Kd.
    // July: every day 22 °C → no heating day → 0 Kd.
    const rows = computeMonthlyDegreeDays([...daysOf("2026-01", 0), ...daysOf("2026-07", 22)]);
    expect(rows).toEqual([
      { month: "2026-01", degreeDays: 31 * HEATING_BASE_C, heatingDays: 31, daysWithData: 31, daysInMonth: 31 },
      { month: "2026-07", degreeDays: 0, heatingDays: 0, daysWithData: 31, daysInMonth: 31 },
    ]);
  });

  it("treats 14.9 °C as a heating day and 15 °C as none", () => {
    const rows = computeMonthlyDegreeDays([
      ...daysOf("2026-04", (day) => (day === 1 ? 14.9 : 15)),
    ]);
    expect(rows[0].heatingDays).toBe(1);
    expect(rows[0].degreeDays).toBeCloseTo(5.1, 5);
  });

  it("tolerates two missing days but drops a month with more", () => {
    const twoMissing = daysOf("2026-02", (day) => (day <= 2 ? null : 5));
    const threeMissing = daysOf("2026-03", (day) => (day <= 3 ? null : 5));
    const rows = computeMonthlyDegreeDays([...twoMissing, ...threeMissing]);
    expect(rows.map((r) => r.month)).toEqual(["2026-02"]);
    expect(rows[0].daysWithData).toBe(26);
  });

  it("drops a month the archive only delivered partially", () => {
    const rows = computeMonthlyDegreeDays(daysOf("2026-05", 10).slice(0, 20));
    expect(rows).toEqual([]);
  });
});

describe("monthRange / lastArchivedMonth", () => {
  it("lists months inclusive across a year boundary", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("stops at the last month that is complete and past the archive lag", () => {
    expect(lastArchivedMonth(new Date("2026-09-11T00:00:00Z"))).toBe("2026-08");
    // Early in the month the previous month is still inside the lag.
    expect(lastArchivedMonth(new Date("2026-09-03T00:00:00Z"))).toBe("2026-07");
  });
});

describe("open-meteo parsers", () => {
  it("parses the archive daily block and keeps gaps as null", () => {
    const days = parseDailyMeans({
      daily: { time: ["2026-01-01", "2026-01-02"], temperature_2m_mean: [-1.4, null] },
    });
    expect(days).toEqual([
      { day: "2026-01-01", meanC: -1.4 },
      { day: "2026-01-02", meanC: null },
    ]);
  });

  it("rejects an answer without a daily block", () => {
    expect(() => parseDailyMeans({})).toThrow(OpenMeteoUnavailableError);
  });

  it("parses geocoding results and skips broken rows", () => {
    const places = parseGeocodeCandidates({
      results: [
        { name: "Musterstadt", admin1: "Bayern", country: "Deutschland", latitude: 48.1, longitude: 11.5 },
        { name: "Broken", latitude: "x", longitude: 1 },
      ],
    });
    expect(places).toEqual([
      { name: "Musterstadt", admin1: "Bayern", country: "Deutschland", lat: 48.1, lon: 11.5 },
    ]);
    expect(parseGeocodeCandidates({})).toEqual([]);
  });
});

// ── Fill + endpoints against the database ───────────────────────────────────

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

const ALL = ["meters.view", "meters.read_entry", "meters.manage"];

let userId: number;
const cleanupUserIds: number[] = [];

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `dd-${Date.now()}-${Math.random()}@example.com`,
      name: "Degree Day Tester",
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

async function createHeatingMeter(ownerId: number, firstReading: string): Promise<number> {
  const [meter] = await db
    .insert(meters)
    .values({ name: "Heizung", type: "electricity", unit: "kWh", role: "heat_heating_total", owner_user_id: ownerId })
    .returning({ id: meters.id });
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: meter.id, installed_at: "2020-01-01T00:00:00Z", start_value: "0" })
    .returning({ id: meterDevices.id });
  await db.insert(meterReadings).values([
    { device_id: device.id, value: "0", taken_at: firstReading, entered_by: ownerId },
    { device_id: device.id, value: "500", taken_at: "2026-09-01T00:00:00Z", entered_by: ownerId },
  ]);
  return meter.id;
}

/** Archive stub: 0 °C on every day it is asked for, and it records the calls. */
class FakeArchive implements ArchiveClient {
  calls: Array<{ lat: number; lon: number; from: string; to: string }> = [];
  async dailyMeanTemperature(lat: number, lon: number, from: string, to: string) {
    this.calls.push({ lat, lon, from, to });
    const days: DailyMeanTemperature[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push({ day: d.toISOString().slice(0, 10), meanC: 0 });
    }
    return days;
  }
}

let archive: FakeArchive;

beforeEach(async () => {
  userId = await createUser();
  cleanupUserIds.push(userId);
  setAuth(String(userId), ALL);
  archive = new FakeArchive();
  setArchiveClient(archive);
  setGeocodingClient({
    async search(query) {
      if (query === "down") throw new OpenMeteoUnavailableError("open-meteo geocoding answered 503");
      return [{ name: query, admin1: "Bayern", country: "Deutschland", lat: 48.137, lon: 11.575 }];
    },
  });
});

afterEach(async () => {
  resetArchiveClient();
  resetGeocodingClient();
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

describe("home location endpoints", () => {
  it("stores the chosen place rounded to the grid and reads it back", async () => {
    expect((await endpoints.getMeterHomeLocation()).home).toBeNull();
    const { home } = await endpoints.putMeterHomeLocation({ label: "Musterstadt, Bayern", lat: 48.137, lon: 11.575 });
    expect(home.label).toBe("Musterstadt, Bayern");
    expect(home.lat).toBe(48.15);
    expect(home.lon).toBe(11.55);
    expect(home.source).toBe("geocoded");
    expect((await endpoints.getMeterHomeLocation()).home?.label).toBe("Musterstadt, Bayern");

    await endpoints.deleteMeterHomeLocation();
    expect((await endpoints.getMeterHomeLocation()).home).toBeNull();
  });

  it("validates coordinates and requires meters.manage to change", async () => {
    await expect(
      endpoints.putMeterHomeLocation({ label: "x", lat: 95, lon: 0 }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    setAuth(String(userId), ["meters.view"]);
    await expect(
      endpoints.putMeterHomeLocation({ label: "x", lat: 48, lon: 11 }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("searches places and maps an outage to unavailable", async () => {
    const res = await endpoints.searchMeterPlaces({ q: "Musterstadt" });
    expect(res.places[0]).toMatchObject({ name: "Musterstadt", lat: 48.137 });
    await expect(endpoints.searchMeterPlaces({ q: "down" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(endpoints.searchMeterPlaces({ q: "x" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("fillDegreeDaysForUser", () => {
  it("requires a home location", async () => {
    await expect(fillDegreeDaysForUser(userId)).rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("has nothing to do without a heating meter", async () => {
    await endpoints.putMeterHomeLocation({ label: "Musterstadt", lat: 48.137, lon: 11.575 });
    const res = await fillDegreeDaysForUser(userId, new Date("2026-09-11T00:00:00Z"));
    expect(res).toMatchObject({ from: null, monthsMissing: 0, monthsWritten: 0 });
    expect(archive.calls).toEqual([]);
  });

  it("writes one row per missing month, skips existing rows and is idempotent", async () => {
    await endpoints.putMeterHomeLocation({ label: "Musterstadt", lat: 48.137, lon: 11.575 });
    await createHeatingMeter(userId, "2025-11-15T00:00:00Z");
    // A hand-entered January must survive the fetch.
    await db.insert(meterElectricityTariffs).values({
      owner_user_id: userId,
      kind: "heating_degree_days",
      valid_from: "2026-01-01T00:00:00.000Z",
      amount: "123.4",
      unit: "kd",
    });

    const now = new Date("2026-09-11T00:00:00Z");
    const first = await fillDegreeDaysForUser(userId, now);
    expect(first.from).toBe("2025-11");
    expect(first.to).toBe("2026-08");
    expect(first.monthsMissing).toBe(9); // 10 months minus the existing January
    expect(first.monthsWritten).toBe(9);
    expect(first.monthsIncomplete).toBe(0);
    // One call per calendar year with a gap, coordinates as stored (grid).
    expect(archive.calls.map((c) => [c.from, c.to])).toEqual([
      ["2025-11-01", "2025-12-31"],
      ["2026-02-01", "2026-08-31"],
    ]);
    expect(archive.calls[0]).toMatchObject({ lat: 48.15, lon: 11.55 });

    const rows = await db
      .select()
      .from(meterElectricityTariffs)
      .where(eq(meterElectricityTariffs.owner_user_id, userId));
    expect(rows).toHaveLength(10);
    const january = rows.find((r) => r.valid_from.startsWith("2026-01"))!;
    expect(Number(january.amount)).toBe(123.4);
    expect(january.source).toBeNull();
    const december = rows.find((r) => r.valid_from.startsWith("2025-12"))!;
    // 31 days at 0 °C → 620 Kd.
    expect(Number(december.amount)).toBe(620);
    expect((december.source as Record<string, unknown>).provider).toBe("open-meteo-archive");

    // Second run: nothing missing, no call.
    archive.calls = [];
    const second = await fillDegreeDaysForUser(userId, now);
    expect(second.monthsMissing).toBe(0);
    expect(second.monthsWritten).toBe(0);
    expect(archive.calls).toEqual([]);
  });

  it("does not write a month the archive delivered incompletely", async () => {
    await endpoints.putMeterHomeLocation({ label: "Musterstadt", lat: 48.137, lon: 11.575 });
    await createHeatingMeter(userId, "2026-07-01T00:00:00Z");
    setArchiveClient({
      async dailyMeanTemperature(_lat, _lon, from, to) {
        const all = await archive.dailyMeanTemperature(_lat, _lon, from, to);
        // August is missing its last ten days.
        return all.filter((d) => !(d.day.startsWith("2026-08") && Number(d.day.slice(8)) > 21));
      },
    });
    const res = await fillDegreeDaysForUser(userId, new Date("2026-09-11T00:00:00Z"));
    expect(res.monthsMissing).toBe(2);
    expect(res.monthsWritten).toBe(1);
    expect(res.monthsIncomplete).toBe(1);
  });

  it("is exposed for meters.manage and translates an archive outage", async () => {
    await endpoints.putMeterHomeLocation({ label: "Musterstadt", lat: 48.137, lon: 11.575 });
    await createHeatingMeter(userId, "2026-07-01T00:00:00Z");
    setArchiveClient({
      async dailyMeanTemperature() {
        throw new OpenMeteoUnavailableError("open-meteo archive answered 503");
      },
    });
    await expect(endpoints.fetchDegreeDays()).rejects.toMatchObject({ code: "unavailable" });
    setAuth(String(userId), ["meters.view"]);
    await expect(endpoints.fetchDegreeDays()).rejects.toMatchObject({ code: "permission_denied" });
  });
});
