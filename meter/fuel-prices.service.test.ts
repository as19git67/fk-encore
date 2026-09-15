import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { meterDevices, meterElectricityTariffs, meterReadings, meters, users } from "../db/schema";
import {
  computeMonthlyFuelPrices,
  fillPetrolPricesForUser,
  monthRange,
  userIdsWithChargingMeter,
  MIN_WEEKS_PER_MONTH,
} from "./fuel-prices.service";
import {
  setOilBulletinClient,
  resetOilBulletinClient,
  OilBulletinUnavailableError,
  type BulletinFuel,
  type OilBulletinClient,
  type WeeklyFuelPrice,
} from "./oil-bulletin-client";
import { listElectricityTariffs, importTariffEntries } from "./tariffs.service";
import * as endpoints from "./fuel-prices";

/** Weekly prices every seven days from `first`, all at `eurPerLitre`. */
function weeklyFrom(first: string, count: number, eurPerLitre: number): WeeklyFuelPrice[] {
  const start = new Date(`${first}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(start.getTime() + i * 7 * 86_400_000);
    return { week: day.toISOString().slice(0, 10), eurPerLitre };
  });
}

describe("computeMonthlyFuelPrices", () => {
  it("averages the weeks of a month", () => {
    const rows = computeMonthlyFuelPrices([
      { week: "2026-01-05", eurPerLitre: 1.7 },
      { week: "2026-01-12", eurPerLitre: 1.8 },
      { week: "2026-01-19", eurPerLitre: 1.9 },
      { week: "2026-01-26", eurPerLitre: 2.0 },
    ]);
    expect(rows).toEqual([{ month: "2026-01", eurPerLitre: 1.85, weeks: 4 }]);
  });

  it("rounds to the tenth of a cent", () => {
    const rows = computeMonthlyFuelPrices([
      { week: "2026-02-02", eurPerLitre: 1.7771 },
      { week: "2026-02-09", eurPerLitre: 1.7772 },
      { week: "2026-02-16", eurPerLitre: 1.7773 },
    ]);
    expect(rows[0].eurPerLitre).toBe(1.777);
  });

  it("drops a month with too few surveyed weeks", () => {
    const sparse = weeklyFrom("2026-03-02", MIN_WEEKS_PER_MONTH - 1, 1.8);
    const full = weeklyFrom("2026-04-06", MIN_WEEKS_PER_MONTH, 1.9);
    expect(computeMonthlyFuelPrices([...sparse, ...full]).map((r) => r.month)).toEqual(["2026-04"]);
  });

  it("orders the months oldest first and ignores an unparsable week", () => {
    const rows = computeMonthlyFuelPrices([
      ...weeklyFrom("2026-05-04", 4, 1.9),
      ...weeklyFrom("2026-01-05", 4, 1.7),
      { week: "not-a-day", eurPerLitre: 9 },
    ]);
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-05"]);
  });
});

describe("monthRange", () => {
  it("lists months inclusive across a year boundary", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("returns the single month when both ends match", () => {
    expect(monthRange("2026-03", "2026-03")).toEqual(["2026-03"]);
  });
});

// ── Fill + endpoint against the database ────────────────────────────────────

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
      email: `fuel-${Date.now()}-${Math.random()}@example.com`,
      name: "Fuel Price Tester",
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

async function createChargingMeter(ownerId: number, firstReading: string): Promise<number> {
  const [meter] = await db
    .insert(meters)
    .values({
      name: "Wallbox",
      type: "electricity",
      unit: "kWh",
      role: "ev_charger_total",
      owner_user_id: ownerId,
    })
    .returning({ id: meters.id });
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: meter.id, installed_at: "2020-01-01T00:00:00Z", start_value: "0" })
    .returning({ id: meterDevices.id });
  // A second reading a month on, so a series exists whatever the first date is.
  const later = new Date(new Date(firstReading).getTime() + 30 * 86_400_000).toISOString();
  await db.insert(meterReadings).values([
    { device_id: device.id, value: "0", taken_at: firstReading, entered_by: ownerId },
    { device_id: device.id, value: "900", taken_at: later, entered_by: ownerId },
  ]);
  return meter.id;
}

/** Bulletin stub: a fixed weekly series, and it counts how often it was asked. */
class FakeBulletin implements OilBulletinClient {
  calls: Array<{ country: string; fuel: BulletinFuel }> = [];
  constructor(private readonly weeks: WeeklyFuelPrice[]) {}
  async weeklyPrices(country: string, fuel: BulletinFuel) {
    this.calls.push({ country, fuel });
    return this.weeks;
  }
}

/** Four weeks a month for January through March 2026, a different price each. */
function quarterOf2026(): WeeklyFuelPrice[] {
  return [
    ...weeklyFrom("2026-01-05", 4, 1.7),
    ...weeklyFrom("2026-02-02", 4, 1.8),
    ...weeklyFrom("2026-03-02", 4, 1.9),
  ];
}

let bulletin: FakeBulletin;

beforeEach(async () => {
  userId = await createUser();
  cleanupUserIds.push(userId);
  setAuth(String(userId), ALL);
  bulletin = new FakeBulletin(quarterOf2026());
  setOilBulletinClient(bulletin);
});

afterEach(async () => {
  resetOilBulletinClient();
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

async function petrolRows(ownerId: number) {
  return (await listElectricityTariffs(ownerId))
    .filter((row) => row.kind === "petrol_price")
    .map((row) => ({ validFrom: row.validFrom.slice(0, 10), amount: row.amount }))
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
}

describe("fillPetrolPricesForUser", () => {
  it("writes one row per month from the first charging reading on", async () => {
    await createChargingMeter(userId, "2026-02-10T00:00:00Z");

    const result = await fillPetrolPricesForUser(userId);

    expect(result).toEqual({
      from: "2026-02",
      to: "2026-03",
      monthsMissing: 2,
      monthsWritten: 2,
      monthsIncomplete: 0,
    });
    expect(await petrolRows(userId)).toEqual([
      { validFrom: "2026-02-01", amount: 1.8 },
      { validFrom: "2026-03-01", amount: 1.9 },
    ]);
  });

  it("asks the bulletin for the configured country and fuel", async () => {
    await createChargingMeter(userId, "2026-03-01T00:00:00Z");
    await fillPetrolPricesForUser(userId);
    expect(bulletin.calls).toEqual([{ country: "DE", fuel: "euro95" }]);
  });

  it("never overwrites a price that is already there", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    // A hand-entered correction for February: what this household actually paid.
    await importTariffEntries(userId, [
      { kind: "petrol_price", validFrom: "2026-02-01", amount: 1.65, unit: "eur_per_l" },
    ]);

    const result = await fillPetrolPricesForUser(userId);

    expect(result.monthsMissing).toBe(2);
    expect(result.monthsWritten).toBe(2);
    expect(await petrolRows(userId)).toEqual([
      { validFrom: "2026-01-01", amount: 1.7 },
      { validFrom: "2026-02-01", amount: 1.65 },
      { validFrom: "2026-03-01", amount: 1.9 },
    ]);
  });

  it("is idempotent — a second run writes nothing", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    await fillPetrolPricesForUser(userId);

    const again = await fillPetrolPricesForUser(userId);

    expect(again.monthsMissing).toBe(0);
    expect(again.monthsWritten).toBe(0);
    expect(await petrolRows(userId)).toHaveLength(3);
  });

  it("counts a month the bulletin has not published in full as incomplete", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    // February only got two weeks, so it is not averaged — but it still sits
    // inside the range and must be reported as missing, not silently dropped.
    setOilBulletinClient(
      new FakeBulletin([
        ...weeklyFrom("2026-01-05", 4, 1.7),
        ...weeklyFrom("2026-02-02", MIN_WEEKS_PER_MONTH - 1, 1.8),
        ...weeklyFrom("2026-03-02", 4, 1.9),
      ]),
    );

    const result = await fillPetrolPricesForUser(userId);

    expect(result).toEqual({
      from: "2026-01",
      to: "2026-03",
      monthsMissing: 3,
      monthsWritten: 2,
      monthsIncomplete: 1,
    });
    expect((await petrolRows(userId)).map((r) => r.validFrom)).toEqual([
      "2026-01-01",
      "2026-03-01",
    ]);
  });

  it("does nothing without a wallbox meter, and does not call the bulletin", async () => {
    const result = await fillPetrolPricesForUser(userId);
    expect(result.from).toBeNull();
    expect(result.monthsWritten).toBe(0);
    expect(bulletin.calls).toEqual([]);
  });

  it("does nothing when charging started after the bulletin's last month", async () => {
    await createChargingMeter(userId, "2026-08-01T00:00:00Z");
    const result = await fillPetrolPricesForUser(userId);
    expect(result).toEqual({
      from: "2026-08",
      to: "2026-03",
      monthsMissing: 0,
      monthsWritten: 0,
      monthsIncomplete: 0,
    });
    expect(await petrolRows(userId)).toEqual([]);
  });

  it("reuses a series it was handed instead of downloading again", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    const monthly = computeMonthlyFuelPrices(quarterOf2026());

    const result = await fillPetrolPricesForUser(userId, monthly);

    expect(result.monthsWritten).toBe(3);
    expect(bulletin.calls).toEqual([]);
  });
});

describe("userIdsWithChargingMeter", () => {
  it("lists the owner of a wallbox meter once", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    await createChargingMeter(userId, "2026-02-02T00:00:00Z");
    expect(await userIdsWithChargingMeter()).toContain(userId);
    expect((await userIdsWithChargingMeter()).filter((id) => id === userId)).toHaveLength(1);
  });

  it("leaves out a household without one", async () => {
    expect(await userIdsWithChargingMeter()).not.toContain(userId);
  });
});

describe("petrol price endpoints", () => {
  it("fills through the endpoint", async () => {
    await createChargingMeter(userId, "2026-03-01T00:00:00Z");
    const result = await endpoints.fetchPetrolPrices();
    expect(result.monthsWritten).toBe(1);
  });

  it("turns a bulletin outage into unavailable", async () => {
    await createChargingMeter(userId, "2026-01-05T00:00:00Z");
    setOilBulletinClient({
      async weeklyPrices() {
        throw new OilBulletinUnavailableError("oil bulletin page answered 503");
      },
    });
    await expect(endpoints.fetchPetrolPrices()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses a caller without the manage permission", async () => {
    setAuth(String(userId), ["meters.view"]);
    await expect(endpoints.fetchPetrolPrices()).rejects.toThrow();
  });

  it("runs the job over the households that have a wallbox", async () => {
    await createChargingMeter(userId, "2026-02-02T00:00:00Z");
    const result = await endpoints.runPetrolPricesJob();
    expect(result.users).toBeGreaterThanOrEqual(1);
    expect(result.failures).toBe(0);
    expect(await petrolRows(userId)).toHaveLength(2);
    // One download for the whole run, however many households take part.
    expect(bulletin.calls).toHaveLength(1);
  });

  it("reports a failure instead of throwing when the bulletin is down", async () => {
    await createChargingMeter(userId, "2026-02-02T00:00:00Z");
    setOilBulletinClient({
      async weeklyPrices() {
        throw new OilBulletinUnavailableError("oil bulletin workbook answered 500");
      },
    });
    const result = await endpoints.runPetrolPricesJob();
    expect(result.failures).toBe(1);
    expect(result.monthsWritten).toBe(0);
  });
});

describe("meter_electricity_tariffs source", () => {
  it("records where a fetched price came from", async () => {
    await createChargingMeter(userId, "2026-03-01T00:00:00Z");
    await fillPetrolPricesForUser(userId);
    const [row] = await db
      .select()
      .from(meterElectricityTariffs)
      .where(eq(meterElectricityTariffs.owner_user_id, userId));
    expect(row.source).toMatchObject({
      provider: "eu-weekly-oil-bulletin",
      country: "DE",
      fuel: "euro95",
      weeks: 4,
    });
  });
});
