import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeCurrency,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastScenario,
  financeForecastSnapshot,
  financeTransaction,
  users,
} from "../db/schema";
import { createItem, createPerson, createScenario, updateItem } from "./forecast";
import { adoptActuals, createSnapshot, getPlanActual, removeSnapshot } from "./forecast-snapshots";
import {
  actualsFromTransactions,
  actualsWindow,
  plannedAt,
  plannedSpendingMonthly,
  snapshotDueHouseholds,
  type TxLite,
} from "./forecast-snapshots.service";

// Every person, account, amount and date below is invented.

function as(userID: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions: ["finance.view"] });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

const createdAccounts: number[] = [];

beforeEach(async () => {
  await db.delete(financeForecastSnapshot);
  await db.delete(financeForecastScenario);
  await db.delete(financeForecastItem);
  await db.delete(financeForecastMilestone);
  await db.delete(financeForecastPerson);
  if (createdAccounts.length) {
    const ids = createdAccounts.splice(0);
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, ids));
    await db.delete(financeAccount).where(inArray(financeAccount.id, ids));
  }
  await db.delete(users);
  await ensureUser(1);
  as(1);
});

async function account(kind: string, label: string, iban: string | null, balance: number): Promise<number> {
  await db.insert(financeCurrency).values({ code: "EUR", symbol: "€" }).onConflictDoNothing();
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, kind as never));
  const [acc] = await db
    .insert(financeAccount)
    .values({ type_id: type.id, currency_code: "EUR", account_number: `${kind}-${Date.now()}-${Math.random()}`, label, iban })
    .returning();
  createdAccounts.push(acc.id);
  await db.insert(financeAccountAccess).values({ account_id: acc.id, user_id: 1, level: "read" });
  await db.insert(financeAccountBalance).values({ account_id: acc.id, as_of: new Date().toISOString(), balance: balance.toFixed(2), source: "manual" });
  return acc.id;
}

async function booking(accountId: number, monthsBack: number, amount: number, counterpartyIban: string | null = null): Promise<void> {
  const d = new Date();
  d.setUTCDate(15);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  await db.insert(financeTransaction).values({
    account_id: accountId,
    booking_date: `${d.toISOString().slice(0, 10)}T00:00:00`,
    amount: amount.toFixed(2),
    currency_code: "EUR",
    counterparty_iban: counterpartyIban,
    dedupe_hash: `fc-snap-${Date.now()}-${Math.random()}`,
  });
}

describe("plan vs. actual — pure helpers", () => {
  it("interpolates what a snapshot expected for a date", () => {
    const series = [
      { year: 2026, liquid: 120, wealth: 220 },
      { year: 2027, liquid: 144, wealth: 244 },
    ];
    const start = { liquid: 100, wealth: 200 };
    // Taken in July 2026: half a year to the year end, from 100 to 120.
    expect(plannedAt(series, "2026-07-01T10:00:00Z", start, "2026-10-01")).toEqual({ liquid: 110, wealth: 210 });
    expect(plannedAt(series, "2026-07-01T10:00:00Z", start, "2027-07-01")).toEqual({ liquid: 132, wealth: 232 });
    expect(plannedAt(series, "2026-07-01T10:00:00Z", start, "2028-01-01")).toEqual({ liquid: 144, wealth: 244 });
    expect(plannedAt(series, "2026-07-01T10:00:00Z", start, "2026-03-01")).toBeNull();
    expect(plannedAt(series, "2026-07-01T10:00:00Z", start, "2029-01-01")).toBeNull();
  });

  it("leaves out moves between the household's own accounts and averages the rest", () => {
    const txs: TxLite[] = [
      { accountId: 1, date: "2026-01-05", amount: 3_000, counterpartyIban: null }, // salary
      { accountId: 1, date: "2026-01-06", amount: -1_800, counterpartyIban: null }, // spending
      { accountId: 1, date: "2026-01-07", amount: -500, counterpartyIban: "DE00 0000 0000 0000 0000 02" }, // to own savings by IBAN
      { accountId: 1, date: "2026-01-20", amount: -300, counterpartyIban: null }, // to the depot: mirrored below
      { accountId: 3, date: "2026-01-22", amount: 300, counterpartyIban: null },
      { accountId: 1, date: "2026-02-05", amount: 3_000, counterpartyIban: null },
      { accountId: 1, date: "2026-02-06", amount: -2_200, counterpartyIban: null },
      { accountId: 2, date: "2026-02-28", amount: 12.5, counterpartyIban: null }, // interest
    ];
    const f = actualsFromTransactions(txs, ["DE00000000000000000002"], 2);
    expect(f.transfersExcluded).toBe(3);
    expect(f.inflowMonthly).toBeCloseTo((6_000 + 12.5) / 2, 6);
    expect(f.outflowMonthly).toBeCloseTo(4_000 / 2, 6);
    expect(f.savingsMonthly).toBeCloseTo((6_012.5 - 4_000) / 2, 6);
  });

  it("covers the last twelve full months", () => {
    expect(actualsWindow(new Date("2026-09-15T12:00:00Z"))).toEqual({ since: "2025-09-01", until: "2026-09-01" });
    expect(actualsWindow(new Date("2026-01-03T00:00:00Z"), 3)).toEqual({ since: "2025-10-01", until: "2026-01-01" });
  });

  it("adds up the scenario's spending per month", () => {
    expect(
      plannedSpendingMonthly([
        { id: 1, type: "living_expense", label: "L", personId: null, amount: 2_500 },
        { id: 2, type: "expense", label: "E", personId: null, amount: 1_200, frequency: "yearly", growthRate: null },
        { id: 3, type: "expense", label: "M", personId: null, amount: 50, frequency: "monthly", growthRate: null },
        { id: 4, type: "expense", label: "O", personId: null, amount: 9_999, frequency: "once", growthRate: null },
      ]),
    ).toBe(2_650);
  });
});

describe("plan vs. actual — snapshots and actuals", () => {
  it("keeps a snapshot, compares it with today and reads the bookings", async () => {
    const giro = await account("giro", "Giro Beispiel", "DE00 0000 0000 0000 0000 01", 4_000);
    const tg = await account("tagesgeld", "Tagesgeld Beispiel", "DE00 0000 0000 0000 0000 02", 26_000);
    const person = await createPerson({ label: "A", birthDate: "1970-01-01" });
    await createItem({ personId: person.id, type: "salary", label: "Gehalt", data: { amount: 3_000 } });
    const living = await createItem({ type: "living_expense", label: "Leben", data: { amount: 2_000 } });
    const asset = await createItem({ type: "asset", label: "Tagesgeld", data: { pot: "cash" } });
    await updateItem({ id: asset.id, linkedAccountId: tg });
    // Twelve months of salary, spending and a monthly move to the savings account.
    for (let m = 1; m <= 12; m++) {
      await booking(giro, m, 3_000);
      await booking(giro, m, -2_100);
      await booking(giro, m, -500, "DE00 0000 0000 0000 0000 02");
      await booking(tg, m, 500, "DE00 0000 0000 0000 0000 01");
    }

    const snap = await createSnapshot({});
    expect(snap.scenarioName).toBe("Standardannahmen");
    expect(snap.startLiquid).toBe(26_000);
    expect(snap.series.length).toBeGreaterThan(20);
    expect(snap.plannedNow?.liquid).toBeCloseTo(26_000, 0);

    const saved = await createScenario({ name: "Vorsichtig", config: { defaultReturnRate: 0.02 } });
    const snap2 = await createSnapshot({ scenarioId: saved.id });
    expect(snap2.scenarioId).toBe(saved.id);
    await expect(createSnapshot({ scenarioId: 99999 })).rejects.toThrow(/not found/);

    const pa = await getPlanActual();
    expect(pa.snapshots.map((s) => s.id).sort()).toEqual([snap.id, snap2.id].sort());
    expect(pa.now.liquid).toBe(26_000);
    expect(pa.actuals?.flows.months).toBe(12);
    expect(pa.actuals?.flows.inflowMonthly).toBe(3_000);
    expect(pa.actuals?.flows.outflowMonthly).toBe(2_100);
    expect(pa.actuals?.flows.savingsMonthly).toBe(900);
    expect(pa.actuals?.flows.transfersExcluded).toBe(24);
    expect(pa.actuals?.plannedSpending).toBe(2_000);
    expect(pa.actuals?.livingItemId).toBe(living.id);

    await adoptActuals({ itemId: living.id, monthly: 2_100 });
    const [row] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, living.id));
    expect(row.data.amount).toBe(2_100);
    await expect(adoptActuals({ itemId: asset.id, monthly: 1 })).rejects.toThrow(/not found/);

    await removeSnapshot({ id: snap.id });
    expect((await getPlanActual()).snapshots.map((s) => s.id)).toEqual([snap2.id]);
    await expect(removeSnapshot({ id: snap.id })).rejects.toThrow(/not found/);
  });

  it("takes the monthly snapshots once per household and scenario", async () => {
    const person = await createPerson({ label: "A", birthDate: "1970-01-01" });
    await createItem({ personId: person.id, type: "salary", label: "Gehalt", data: { amount: 3_000 } });
    await createScenario({ name: "Früh", config: { endAge: 90 } });
    const now = new Date();
    expect(await snapshotDueHouseholds(now)).toBe(2); // defaults + one saved scenario
    expect(await snapshotDueHouseholds(now)).toBe(0); // not due again
    const later = new Date(now.getTime() + 28 * 86_400_000);
    expect(await snapshotDueHouseholds(later)).toBe(2);
    const rows = await db.select().from(financeForecastSnapshot);
    expect(rows.every((r) => r.source === "cron")).toBe(true);
    expect(rows).toHaveLength(4);
  });
});
