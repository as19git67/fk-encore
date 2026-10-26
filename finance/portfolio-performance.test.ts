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
  users,
} from "../db/schema";
import { getPortfolioPerformance } from "./portfolio-performance";

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
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", ["finance.view", "finance.admin"]);
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
  // The portfolio covers the caller's own depots (a `write` entry); the
  // default caller, user 1, owns every account a test creates.
  await ensureUser(1);
  await db.insert(financeAccountAccess).values({ account_id: row.id, user_id: 1, level: "write" });
  return row.id;
}

async function grantOwn(accountId: number, userId: number) {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level: "write",
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

describe("finance/portfolio — performance", () => {
  it("returns no groups without depots", async () => {
    const resp = await getPortfolioPerformance({});
    expect(resp.groups).toEqual([]);
    expect(resp.period).toBe("1Y");
    expect(resp.mixed_currency).toBe(false);
  });

  it("adds two depots into one series and chains the returns across a buy", async () => {
    const bc = await insertBankcontact();
    const d1 = await insertAccount(bc, "depot", "Depot 1");
    const d2 = await insertAccount(bc, "depot", "Depot 2");
    await insertTx({ accountId: d1, kind: "buy", executedAt: "2026-02-02", isin: ISIN_A, amount: "10", price: "100", net: "-1000" });
    await insertHolding({ accountId: d1, asOf: "2026-02-02", isin: ISIN_A, name: "Alpha AG", amount: "10", price: "100", value: "1000" });
    // +10 %, then the second depot buys, then +10 % again.
    await insertQuotes(ISIN_A, [
      { at: "2026-02-03T16:00:00Z", price: "110" },
      { at: "2026-02-04T16:00:00Z", price: "110" },
      { at: "2026-02-05T16:00:00Z", price: "121" },
    ]);
    await insertTx({ accountId: d2, kind: "buy", executedAt: "2026-02-04", isin: ISIN_A, amount: "5", price: "110", net: "-550" });
    await insertTx({ accountId: d2, kind: "dividend", executedAt: "2026-02-05", isin: ISIN_A, net: "0" });

    const resp = await getPortfolioPerformance({ period: "max" });
    expect(resp.groups).toHaveLength(1);
    const g = resp.groups[0]!;
    expect(g.currency).toBe("EUR");
    expect(g.account_ids.sort()).toEqual([d1, d2].sort());
    expect(g.from).toBe("2026-02-02");
    expect(g.end_value).toBe((15 * 121).toFixed(2));
    expect(g.twr_pct).toBe("21.00");
    expect(g.net_flow).toBe("1550.00");
    expect(g.gaps).toEqual([]);
    expect(g.points.map((p) => p.day)).toEqual(["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"]);
    expect(g.points.at(-1)!.invested).toBe("1550.00");
    expect(g.xirr_pct).not.toBeNull();
    expect(g.positions.map((p) => p.key)).toEqual([ISIN_A]);
    expect(g.positions[0]!.twr_pct).toBe("21.00");
  });

  it("limits non-admins to the depots on their ACL", async () => {
    const bc = await insertBankcontact();
    const mine = await insertAccount(bc, "depot", "Mine");
    const other = await insertAccount(bc, "depot", "Other");
    await grantOwn(mine, 7);
    await insertHolding({ accountId: mine, asOf: "2026-03-02", isin: ISIN_A, name: "Alpha AG", amount: "1", price: "10", value: "10" });
    await insertHolding({ accountId: other, asOf: "2026-03-02", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "99", value: "99" });

    setAuth("7", ["finance.view"]);
    const resp = await getPortfolioPerformance({ period: "max", accounts: `${mine},${other}` });
    expect(resp.groups).toHaveLength(1);
    expect(resp.groups[0]!.account_ids).toEqual([mine]);
    expect(resp.groups[0]!.end_value).toBe("10.00");
    expect(resp.groups[0]!.positions.map((p) => p.key)).toEqual([ISIN_A]);
    await expect(getPortfolioPerformance({ period: "max", position: ISIN_B })).rejects.toThrow(/not found/);
  });

  it("returns one position alone on request", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");
    await insertHolding({ accountId: depot, asOf: "2026-03-02", isin: ISIN_A, name: "Alpha AG", amount: "2", price: "50", value: "100" });
    await insertHolding({ accountId: depot, asOf: "2026-03-02", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "10", value: "10" });
    await insertHolding({ accountId: depot, asOf: "2026-03-03", isin: ISIN_A, name: "Alpha AG", amount: "2", price: "60", value: "120" });
    await insertHolding({ accountId: depot, asOf: "2026-03-03", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "5", value: "5" });

    const one = await getPortfolioPerformance({ period: "max", position: ISIN_A });
    expect(one.groups).toHaveLength(1);
    expect(one.groups[0]!.positions).toEqual([]);
    expect(one.groups[0]!.twr_pct).toBe("20.00");
    expect(one.groups[0]!.end_value).toBe("120.00");

    const all = await getPortfolioPerformance({ period: "max" });
    expect(all.groups[0]!.twr_pct).toBe(((125 / 110 - 1) * 100).toFixed(2));
  });

  it("keeps depots of different currencies apart", async () => {
    const bc = await insertBankcontact();
    const eur = await insertAccount(bc, "depot", "Euro");
    const usd = await insertAccount(bc, "depot", "Dollar");
    await db.update(financeAccount).set({ currency_code: "USD" }).where(eq(financeAccount.id, usd));
    await insertHolding({ accountId: eur, asOf: "2026-03-02", isin: ISIN_A, name: "Alpha AG", amount: "1", price: "10", value: "10" });
    await insertHolding({ accountId: usd, asOf: "2026-03-02", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "20", value: "20" });

    const resp = await getPortfolioPerformance({ period: "max" });
    expect(resp.mixed_currency).toBe(true);
    expect(resp.groups.map((g) => [g.currency, g.end_value]).sort()).toEqual([
      ["EUR", "10.00"],
      ["USD", "20.00"],
    ]);
  });

  it("rejects an unknown period", async () => {
    await expect(getPortfolioPerformance({ period: "2W" })).rejects.toThrow(/period must be one of/);
  });
});
