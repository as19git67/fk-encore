import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";

import db from "../db/database";
import { users } from "../db/schema";
import {
  createElectricityTariff,
  importTariffEntries,
  listElectricityTariffs,
  updateElectricityTariff,
  type TariffImportEntry,
  type UpsertElectricityTariffInput,
} from "./tariffs.service";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

let userId: number;
const cleanupUserIds: number[] = [];

beforeEach(async () => {
  const [row] = await db
    .insert(users)
    .values({
      email: `tariff-test-${Date.now()}-${Math.random()}@example.com`,
      name: "Tariff Tester",
      password_hash: "x",
    })
    .returning({ id: users.id });
  userId = row.id;
  cleanupUserIds.push(userId);
  setAuth(String(userId), ["meters.view", "meters.manage"]);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

function sewagePrice(overrides: Partial<UpsertElectricityTariffInput> = {}): UpsertElectricityTariffInput {
  return {
    kind: "sewage_price",
    validFrom: "2022-01-01",
    amount: 2.79,
    unit: "eur_per_m3",
    taxStatus: "gross",
    ...overrides,
  };
}

describe("createElectricityTariff", () => {
  it("creates a tariff entry", async () => {
    const tariff = await createElectricityTariff(userId, sewagePrice());
    expect(tariff).toMatchObject({ kind: "sewage_price", amount: 2.79, unit: "eur_per_m3" });
  });

  it("rejects a duplicate (kind, validFrom, unit, name) with a clear, catchable error", async () => {
    // Same input submitted twice — the exact shape of the reported #792 bug
    // (entering the same assumption twice from the tariff dialog).
    await createElectricityTariff(userId, sewagePrice());

    await expect(createElectricityTariff(userId, sewagePrice())).rejects.toMatchObject({
      code: "already_exists",
    });
  });

  it("allows the same kind again once the unit differs", async () => {
    await createElectricityTariff(userId, sewagePrice());
    await expect(
      createElectricityTariff(userId, sewagePrice({ unit: "eur" })),
    ).resolves.toMatchObject({ unit: "eur" });
  });

  it("allows the same kind again once validFrom differs", async () => {
    await createElectricityTariff(userId, sewagePrice());
    const second = await createElectricityTariff(userId, sewagePrice({ validFrom: "2023-01-01" }));
    expect(second.validFrom.startsWith("2023-01-01")).toBe(true);
  });

  it("rejects an unknown tariff kind", async () => {
    await expect(
      createElectricityTariff(userId, sewagePrice({ kind: "not_a_kind" as any })),
    ).rejects.toThrow(APIError);
  });
});

describe("updateElectricityTariff", () => {
  it("rejects renaming an entry onto an existing (kind, validFrom, unit, name)", async () => {
    const first = await createElectricityTariff(userId, sewagePrice());
    const second = await createElectricityTariff(userId, sewagePrice({ validFrom: "2023-01-01" }));

    await expect(
      updateElectricityTariff(userId, second.id, sewagePrice()),
    ).rejects.toMatchObject({ code: "already_exists" });

    // The original entry must be untouched by the failed update.
    const remaining = await listElectricityTariffs(userId);
    expect(remaining.find((t) => t.id === first.id)?.validFrom.startsWith("2022-01-01")).toBe(true);
  });

  it("allows updating an entry's own amount without tripping the duplicate check", async () => {
    const tariff = await createElectricityTariff(userId, sewagePrice());
    const updated = await updateElectricityTariff(userId, tariff.id, sewagePrice({ amount: 3.1 }));
    expect(updated.amount).toBe(3.1);
  });
});

describe("importTariffEntries", () => {
  function petrol(validFrom: string, amount: number): TariffImportEntry {
    return { kind: "petrol_price", validFrom, amount, unit: "eur_per_l", taxStatus: "gross" };
  }

  it("imports a historical series in one go", async () => {
    const result = await importTariffEntries(userId, [
      petrol("2021-11-01", 1.68),
      petrol("2021-12-01", 1.605),
      petrol("2022-01-01", 1.67),
    ]);

    expect(result).toMatchObject({ created: 3, updated: 0, failed: 0 });
    const stored = await listElectricityTariffs(userId);
    expect(stored.filter((t) => t.kind === "petrol_price")).toHaveLength(3);
  });

  it("updates instead of duplicating when the same file is imported again", async () => {
    await importTariffEntries(userId, [petrol("2021-11-01", 1.68)]);
    const again = await importTariffEntries(userId, [petrol("2021-11-01", 1.72)]);

    expect(again).toMatchObject({ created: 0, updated: 1, failed: 0 });
    const stored = await listElectricityTariffs(userId);
    expect(stored.filter((t) => t.kind === "petrol_price")).toHaveLength(1);
    // The corrected value wins — that is the point of re-importing.
    expect(stored.find((t) => t.kind === "petrol_price")?.amount).toBe(1.72);
  });

  it("reports the position of a bad row and imports the rest", async () => {
    const result = await importTariffEntries(userId, [
      petrol("2021-11-01", 1.68),
      { ...petrol("2021-12-01", 1.6), kind: "petrol_pric" },
      { ...petrol("2022-01-01", 1.67), unit: "eur_per_litre" },
      { ...petrol("2022-02-01", 1.74), validFrom: "not-a-date" },
      petrol("2022-03-01", 2.069),
    ]);

    expect(result).toMatchObject({ created: 2, updated: 0, failed: 3 });
    expect(result.errors.map((e) => e.index)).toEqual([1, 2, 3]);
    const stored = await listElectricityTariffs(userId);
    expect(stored.filter((t) => t.kind === "petrol_price")).toHaveLength(2);
  });

  it("rejects an empty file rather than reporting a successful no-op", async () => {
    await expect(importTariffEntries(userId, [])).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("refuses a file far larger than any real price history", async () => {
    const entries = Array.from({ length: 2001 }, (_, i) =>
      petrol(`20${20 + Math.floor(i / 300)}-01-01`, 1 + i / 1000),
    );
    await expect(importTariffEntries(userId, entries)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("keeps a negative amount out of the database", async () => {
    const result = await importTariffEntries(userId, [{ ...petrol("2021-11-01", -1.68) }]);

    expect(result).toMatchObject({ created: 0, failed: 1 });
    expect(await listElectricityTariffs(userId)).toHaveLength(0);
  });
});

// ── EnergyTariffTimeline (pure, no database) ─────────────────────────────────

import { EnergyTariffTimeline, type ElectricityTariff } from "./tariffs.service";

let tariffSeq = 0;
function entry(
  kind: ElectricityTariff["kind"],
  validFrom: string,
  amount: number,
  extra: Partial<ElectricityTariff> = {},
): ElectricityTariff {
  return {
    id: ++tariffSeq,
    kind,
    validFrom: `${validFrom}T00:00:00.000Z`,
    amount,
    unit: "eur_per_kwh",
    taxStatus: null,
    name: null,
    capacityLimitKw: null,
    source: null,
    ...extra,
  };
}

const JAN = { periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-02-01T00:00:00.000Z" };
const YEAR_2026 = { periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2027-01-01T00:00:00.000Z" };

describe("EnergyTariffTimeline — feed-in generations", () => {
  it("lets a newer feed-in row without a capacity tier replace the older one", () => {
    const timeline = new EnergyTariffTimeline([
      entry("feed_in", "2021-07-01", 0.0792),
      entry("feed_in", "2026-01-01", 0.05),
    ]);
    expect(timeline.pricesForPeriod(JAN.periodStart, JAN.periodEnd).feedInPricePerKwh).toBe(0.05);
    expect(
      timeline.pricesForPeriod("2025-06-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z").feedInPricePerKwh,
    ).toBe(0.0792);
  });

  it("picks the tier that applies to the installed capacity from the latest price list", () => {
    const timeline = new EnergyTariffTimeline([
      entry("feed_in", "2021-07-01", 0.0792, { capacityLimitKw: 10 }),
      entry("feed_in", "2021-07-01", 0.077, { capacityLimitKw: 40 }),
      entry("feed_in", "2026-01-01", 0.06, { capacityLimitKw: 10 }),
      entry("feed_in", "2026-01-01", 0.058, { capacityLimitKw: 40 }),
      entry("pv_capacity_kwp", "2021-07-01", 15, { unit: "kw" }),
    ]);
    // 15 kWp → the 40 kW tier of the 2026 list.
    expect(timeline.pricesForPeriod(JAN.periodStart, JAN.periodEnd).feedInPricePerKwh).toBe(0.058);
  });

  it("falls back to the lowest tier without a known capacity", () => {
    const timeline = new EnergyTariffTimeline([
      entry("feed_in", "2021-07-01", 0.0792, { capacityLimitKw: 10 }),
      entry("feed_in", "2021-07-01", 0.077, { capacityLimitKw: 40 }),
    ]);
    expect(timeline.pricesForPeriod(JAN.periodStart, JAN.periodEnd).feedInPricePerKwh).toBe(0.0792);
  });
});

describe("EnergyTariffTimeline — periods the tariff only partly covers", () => {
  it("prices a period whose tariff starts in the middle instead of dropping it", () => {
    const timeline = new EnergyTariffTimeline([entry("grid_import", "2026-07-01", 0.4)]);
    const costs = timeline.costsForBucket({
      ...YEAR_2026,
      gridImport: 1000,
      gridExport: 0,
      selfConsumption: 0,
      totalConsumption: 1000,
    });
    expect(costs.gridImportCostEur).toBe(400);
    expect(costs.netElectricityCostEur).toBe(400);
  });

  it("still yields nothing for a period entirely before the first tariff", () => {
    const timeline = new EnergyTariffTimeline([entry("grid_import", "2026-07-01", 0.4)]);
    const costs = timeline.costsForBucket({
      ...JAN,
      gridImport: 100,
      gridExport: 0,
      selfConsumption: 0,
      totalConsumption: 100,
    });
    expect(costs.gridImportCostEur).toBeNull();
    expect(costs.netElectricityCostEur).toBeNull();
  });

  it("weights a work-price change by days", () => {
    const timeline = new EnergyTariffTimeline([
      entry("grid_import", "2020-01-01", 0.3),
      entry("grid_import", "2026-01-16", 0.4),
    ]);
    const price = timeline.pricesForPeriod(JAN.periodStart, JAN.periodEnd).gridImportPricePerKwh!;
    expect(price).toBeCloseTo((0.3 * 15 + 0.4 * 16) / 31, 6);
  });

  it("splits a standing-charge change inside a month by days", () => {
    const timeline = new EnergyTariffTimeline([
      entry("base_price", "2020-01-01", 10, { unit: "eur_per_month" }),
      entry("base_price", "2026-01-15", 20, { unit: "eur_per_month" }),
    ]);
    const base = timeline.pricesForPeriod(JAN.periodStart, JAN.periodEnd).baseCostEur!;
    expect(base).toBeCloseTo((10 * 14 + 20 * 17) / 31, 6);
  });

  it("treats a missing standing charge as zero rather than dropping the bill", () => {
    const timeline = new EnergyTariffTimeline([
      entry("grid_import", "2020-01-01", 0.4),
      entry("feed_in", "2020-01-01", 0.08),
    ]);
    const costs = timeline.costsForBucket({
      ...JAN,
      gridImport: 300,
      gridExport: 500,
      selfConsumption: 200,
      totalConsumption: 500,
    });
    expect(costs.baseCostEur).toBeNull();
    expect(costs.netElectricityCostEur).toBe(80); // 120 − 40
    expect(costs.noPvElectricityCostEur).toBe(200);
  });
});

describe("EnergyTariffTimeline — dated assumptions", () => {
  it("does not let a future-dated value rewrite the past, but extends the first value backwards", () => {
    const timeline = new EnergyTariffTimeline([
      entry("heat_pump_scop", "2024-01-01", 3, { unit: "ratio" }),
      entry("heat_pump_scop", "2030-01-01", 5, { unit: "ratio" }),
    ]);
    expect(timeline.amountAt("heat_pump_scop", "2026-06-01T00:00:00.000Z")).toBe(3);
    expect(timeline.amountAt("heat_pump_scop", "2031-01-01T00:00:00.000Z")).toBe(5);
    expect(timeline.amountAt("heat_pump_scop", "2020-01-01T00:00:00.000Z")).toBe(3);
    expect(timeline.amountOf("heat_pump_scop")).toBe(3);
  });

  it("sums investments instead of keeping only the latest", () => {
    const timeline = new EnergyTariffTimeline([
      entry("pv_investment_net", "2021-07-01", 12000, { unit: "eur" }),
      entry("pv_investment_net", "2024-05-01", 4000, { unit: "eur" }),
    ]);
    expect(timeline.sumUntil("pv_investment_net")).toBe(16000);
    expect(timeline.sumUntil("pv_investment_net", new Date("2022-01-01T00:00:00Z"))).toBe(12000);
  });

  it("lists the entries a period actually drew on", () => {
    const timeline = new EnergyTariffTimeline([
      entry("gas_price", "2020-01-01", 0.1),
      entry("gas_price", "2026-07-01", 0.2),
      entry("gas_price", "2028-01-01", 0.3),
    ]);
    const used = timeline.entriesForPeriod("gas_price", YEAR_2026.periodStart, YEAR_2026.periodEnd);
    expect(used.map((e) => e.amount)).toEqual([0.1, 0.2]);
  });
});

describe("plausibility bounds", () => {
  it("rejects a boiler efficiency typed as a percentage", async () => {
    await expect(
      createElectricityTariff(userId, {
        kind: "boiler_efficiency",
        validFrom: "2024-01-01",
        amount: 90,
        unit: "ratio",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects a petrol consumption of zero", async () => {
    await expect(
      createElectricityTariff(userId, {
        kind: "petrol_consumption",
        validFrom: "2024-01-01",
        amount: 0,
        unit: "l_per_100km",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
