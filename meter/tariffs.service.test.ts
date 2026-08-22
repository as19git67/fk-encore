import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";

import db from "../db/database";
import { users } from "../db/schema";
import {
  createElectricityTariff,
  listElectricityTariffs,
  updateElectricityTariff,
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
