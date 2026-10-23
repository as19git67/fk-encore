import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeDepotTransaction,
  financeQuote,
  financeQuoteSymbol,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  financeUserPref,
  users,
} from "../db/schema";
import { getPortfolioAnalysis, getPortfolioSettings, savePortfolioSettings } from "./portfolio-analysis";
import { getPortfolioPosition } from "./portfolio";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeDepotTransaction);
  await db.delete(financeQuote);
  await db.delete(financeQuoteSymbol);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeUserPref);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", ["finance.view", "finance.admin"]);
  await ensureUser(1);
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function typeId(kind: "depot" | "giro"): Promise<number> {
  const [row] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, kind))
    .limit(1);
  return row.id;
}

async function insertAccount(
  bcId: number,
  kind: "depot" | "giro",
  label: string,
): Promise<number> {
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bcId,
      type_id: await typeId(kind),
      currency_code: "EUR",
      account_number: `${kind}-${label}`,
      label,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function grantRead(accountId: number, userId: number) {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level: "read",
  });
}

async function insertHolding(opts: {
  accountId: number;
  asOf: string;
  isin?: string | null;
  wkn?: string | null;
  name: string;
  amount: string;
  price: string;
  value: string;
  acquisitionPrice?: string | null;
}): Promise<void> {
  await db.insert(financeAccountHolding).values({
    account_id: opts.accountId,
    as_of: opts.asOf,
    isin: opts.isin ?? null,
    wkn: opts.wkn ?? null,
    name: opts.name,
    amount: opts.amount,
    price: opts.price,
    value: opts.value,
    currency: "EUR",
    acquisition_price: opts.acquisitionPrice ?? null,
  });
}

async function insertTx(opts: {
  accountId: number;
  kind: string;
  executedAt: string;
  isin?: string | null;
  wkn?: string | null;
  name?: string | null;
  amount?: string | null;
  price?: string | null;
  gross?: string | null;
  fees?: string | null;
  tax?: string | null;
  net?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(financeDepotTransaction)
    .values({
      account_id: opts.accountId,
      isin: opts.isin ?? null,
      wkn: opts.wkn ?? null,
      name: opts.name ?? null,
      kind: opts.kind,
      executed_at: opts.executedAt,
      amount: opts.amount ?? null,
      price: opts.price ?? null,
      gross_amount: opts.gross ?? null,
      fees: opts.fees ?? null,
      tax: opts.tax ?? null,
      net_amount: opts.net ?? null,
      currency: "EUR",
      source: "manual",
    })
    .returning({ id: financeDepotTransaction.id });
  return row.id;
}

const ISIN_A = "DE0000000AAA1";
const ISIN_B = "DE0000000BBB2";

async function insertQuotes(
  key: string,
  points: Array<{ at: string; price: string; kind?: "daily" | "intraday"; currency?: string | null }>,
): Promise<void> {
  await db.insert(financeQuoteSymbol).values({ position_key: key, provider: "memory", symbol: `${key}.X` }).onConflictDoNothing();
  await db.insert(financeQuote).values(
    points.map((p) => ({
      position_key: key,
      at: p.at,
      price: p.price,
      currency: p.currency === undefined ? "EUR" : p.currency,
      kind: p.kind ?? "daily",
      source: "memory",
    })),
  );
}

async function setType(key: string, type: string) {
  await db
    .insert(financeQuoteSymbol)
    .values({ position_key: key, provider: "memory", symbol: `${key}.X`, security_type: type })
    .onConflictDoUpdate({ target: financeQuoteSymbol.position_key, set: { security_type: type } });
}

describe("finance/portfolio — analysis", () => {
  it("returns nothing without depots, and the default threshold", async () => {
    const resp = await getPortfolioAnalysis({});
    expect(resp.groups).toEqual([]);
    expect(resp.savings_plans).toEqual([]);
    expect(resp.concentration_threshold_pct).toBe(10);
  });

  it("allocates by security, type and currency, flags concentration and sums the income", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");
    await insertHolding({ accountId: depot, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "10", price: "70", value: "700", acquisitionPrice: "50" });
    await insertHolding({ accountId: depot, asOf: "2026-09-01", isin: ISIN_B, name: "Beta ETF", amount: "10", price: "30", value: "300", acquisitionPrice: "30" });
    await setType(ISIN_A, "equity");
    await setType(ISIN_B, "etf");
    await insertTx({ accountId: depot, kind: "dividend", executedAt: "2026-05-10", isin: ISIN_A, net: "20" });
    await insertTx({ accountId: depot, kind: "dividend", executedAt: "2026-06-10", isin: ISIN_B, net: "6" });

    await savePortfolioSettings({ concentration_threshold_pct: 50 });
    expect((await getPortfolioSettings()).concentration_threshold_pct).toBe(50);

    const resp = await getPortfolioAnalysis({});
    expect(resp.concentration_threshold_pct).toBe(50);
    expect(resp.groups).toHaveLength(1);
    const g = resp.groups[0]!;
    expect(g.market_value).toBe("1000.00");
    expect(g.by_security.map((s) => [s.key, s.weight_pct])).toEqual([
      [ISIN_A, "70.00"],
      [ISIN_B, "30.00"],
    ]);
    expect(g.by_type.map((t) => t.label)).toEqual(["Aktien", "ETFs"]);
    expect(g.concentrated.map((s) => s.key)).toEqual([ISIN_A]);
    expect(resp.by_currency).toEqual([{ currency: "EUR", value: "1000.00", positions: 2 }]);
    expect(g.income.months.map((m) => [m.month, m.income])).toEqual(
      expect.arrayContaining([
        ["2026-05", "20.00"],
        ["2026-06", "6.00"],
      ]),
    );
    expect(g.income.years.find((y) => y.year === 2026)!.income).toBe("26.00");
    expect(g.income.ttm).toBe("26.00");
    expect(g.income.current_yield_pct).toBe("2.60");
    // Cost basis 10 × 50 + 10 × 30 = 800.
    expect(g.income.yield_on_cost_pct).toBe("3.25");
  });

  it("finds a savings plan and shows it on the position", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");
    for (const day of ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01", "2026-10-01"]) {
      await insertTx({ accountId: depot, kind: "buy", executedAt: day, isin: ISIN_B, name: "Beta ETF", amount: "1", price: "50", net: "-50" });
    }
    await insertTx({ accountId: depot, kind: "buy", executedAt: "2026-06-20", isin: ISIN_A, name: "Alpha AG", amount: "5", price: "100", net: "-500" });

    const resp = await getPortfolioAnalysis({});
    expect(resp.savings_plans).toHaveLength(1);
    expect(resp.savings_plans[0]).toMatchObject({
      account_id: depot,
      account_label: "Depot",
      key: ISIN_B,
      name: "Beta ETF",
      interval: "monthly",
      amount: "50.00",
      currency: "EUR",
      executions: 6,
      first: "2026-05-01",
      last: "2026-10-01",
    });

    const pos = await getPortfolioPosition({ key: ISIN_B });
    expect(pos.savings_plans).toHaveLength(1);
    expect(pos.savings_plans[0]).toMatchObject({ account_label: "Depot", interval: "monthly", amount: "50.00", executions: 6 });
    expect((await getPortfolioPosition({ key: ISIN_A })).savings_plans).toEqual([]);
  });

  it("keeps the threshold per user and refuses one out of range", async () => {
    await savePortfolioSettings({ concentration_threshold_pct: 25 });
    setAuth("2", ["finance.view"]);
    await ensureUser(2);
    expect((await getPortfolioSettings()).concentration_threshold_pct).toBe(10);
    await expect(savePortfolioSettings({ concentration_threshold_pct: 0 })).rejects.toThrow(/above 0/);
    await expect(savePortfolioSettings({ concentration_threshold_pct: 120 })).rejects.toThrow(/at most 100/);
  });

  it("limits non-admins to the depots on their ACL and keeps currencies apart", async () => {
    const bc = await insertBankcontact();
    const mine = await insertAccount(bc, "depot", "Mine");
    const other = await insertAccount(bc, "depot", "Other");
    const usd = await insertAccount(bc, "depot", "Dollar");
    await db.update(financeAccount).set({ currency_code: "USD" }).where(eq(financeAccount.id, usd));
    await grantRead(mine, 7);
    await grantRead(usd, 7);
    await insertHolding({ accountId: mine, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "1", price: "10", value: "10" });
    await insertHolding({ accountId: other, asOf: "2026-09-01", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "99", value: "99" });
    await insertHolding({ accountId: usd, asOf: "2026-09-01", wkn: "XYZ123", name: "Delta Inc", amount: "2", price: "20", value: "40" });

    setAuth("7", ["finance.view"]);
    const resp = await getPortfolioAnalysis({});
    expect(resp.mixed_currency).toBe(true);
    expect(resp.groups.map((g) => [g.currency, g.market_value]).sort()).toEqual([
      ["EUR", "10.00"],
      ["USD", "40.00"],
    ]);
    expect(resp.groups.flatMap((g) => g.by_security.map((s) => s.key))).not.toContain(ISIN_B);
  });
});
