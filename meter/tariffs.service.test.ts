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
