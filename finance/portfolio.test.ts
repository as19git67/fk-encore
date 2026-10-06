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
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import { getPortfolio, getPortfolioPosition, listPortfolioTransactions } from "./portfolio";

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

describe("finance/portfolio — getPortfolio", () => {
  it("returns an empty portfolio without depots", async () => {
    const resp = await getPortfolio({});
    expect(resp.accounts).toEqual([]);
    expect(resp.positions).toEqual([]);
    expect(resp.years).toEqual([]);
    expect(resp.summary.market_value).toBe("0.00");
    expect(resp.summary.as_of).toBeNull();
  });

  it("aggregates one position held in two depots and values it with the bank's Einstandskurs", async () => {
    const bc = await insertBankcontact();
    const d1 = await insertAccount(bc, "depot", "Depot 1");
    const d2 = await insertAccount(bc, "depot", "Depot 2");
    // A giro account must not show up as a depot.
    await insertAccount(bc, "giro", "Giro");

    await insertHolding({
      accountId: d1,
      asOf: "2026-09-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "10",
      price: "100.00",
      value: "1000.00",
      acquisitionPrice: "80.00",
    });
    await insertHolding({
      accountId: d2,
      asOf: "2026-09-10",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "5",
      price: "110.00",
      value: "550.00",
      acquisitionPrice: "90.00",
    });

    const resp = await getPortfolio({});
    expect(resp.accounts.map((a) => a.label)).toEqual(["Depot 1", "Depot 2"]);
    expect(resp.summary.as_of).toBe("2026-09-10");
    expect(resp.positions).toHaveLength(1);

    const pos = resp.positions[0];
    expect(pos.key).toBe(ISIN_A);
    expect(pos.open).toBe(true);
    expect(pos.account_ids).toEqual([d1, d2]);
    expect(Number(pos.amount)).toBe(15);
    expect(pos.value).toBe("1550.00");
    // 10 × 80 + 5 × 90
    expect(pos.cost_basis).toBe("1250.00");
    expect(pos.cost_basis_source).toBe("bank");
    expect(pos.unrealized_gain).toBe("300.00");
    expect(pos.unrealized_gain_pct).toBe("24.00");
    expect(pos.weight_pct).toBe("100.00");
    // Newest snapshot wins for the price.
    expect(pos.price).toBe("110.000000");
    expect(pos.price_as_of).toBe("2026-09-10");

    expect(resp.summary.market_value).toBe("1550.00");
    expect(resp.summary.cost_basis).toBe("1250.00");
    expect(resp.summary.cost_basis_complete).toBe(true);
    expect(resp.summary.unrealized_gain).toBe("300.00");
    expect(resp.summary.open_positions).toBe(1);
    expect(resp.summary.closed_positions).toBe(0);
  });

  it("folds sells, dividends, fees and taxes into positions, years and the summary", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");

    // Alpha: bought 10 @ 100 in 2024, sold 4 @ 150 in 2025, dividend in 2026.
    await insertTx({
      accountId: depot,
      kind: "buy",
      executedAt: "2024-03-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "10",
      price: "100.00",
      net: "-1005.00",
      fees: "5.00",
    });
    await insertTx({
      accountId: depot,
      kind: "sell",
      executedAt: "2025-06-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "4",
      price: "150.00",
      net: "590.00",
      fees: "5.00",
      tax: "5.00",
    });
    await insertTx({
      accountId: depot,
      kind: "dividend",
      executedAt: "2026-04-01",
      isin: ISIN_A,
      name: "Alpha AG",
      net: "12.50",
      tax: "4.50",
    });
    // Beta: bought and fully sold — a closed position.
    await insertTx({
      accountId: depot,
      kind: "buy",
      executedAt: "2025-01-10",
      isin: ISIN_B,
      name: "Beta ETF",
      amount: "2",
      price: "50.00",
      net: "-100.00",
    });
    await insertTx({
      accountId: depot,
      kind: "sell",
      executedAt: "2025-02-10",
      isin: ISIN_B,
      name: "Beta ETF",
      amount: "2",
      price: "40.00",
      net: "80.00",
    });
    // Current snapshot holds only Alpha; no Einstandskurs → WAC from buys.
    await insertHolding({
      accountId: depot,
      asOf: "2026-09-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "6",
      price: "120.00",
      value: "720.00",
    });

    const resp = await getPortfolio({});
    expect(resp.positions.map((p) => [p.key, p.open])).toEqual([
      [ISIN_A, true],
      [ISIN_B, false],
    ]);

    const alpha = resp.positions[0];
    // The buy's fees belong to its cost: 1005 / 10 = 100.50 a share.
    expect(alpha.cost_basis).toBe("603.00");
    expect(alpha.cost_basis_source).toBe("tx-wac");
    expect(alpha.unrealized_gain).toBe("117.00");
    // 590 proceeds − 4 × 100.50 cost
    expect(alpha.realized_gain).toBe("188.00");
    expect(alpha.realized_gain_complete).toBe(true);
    expect(alpha.income).toBe("12.50");
    expect(alpha.fees).toBe("10.00");
    expect(alpha.taxes).toBe("9.50");
    expect(alpha.total_return).toBe("317.50");
    expect(alpha.buy_count).toBe(1);
    expect(alpha.sell_count).toBe(1);
    expect(alpha.dividend_count).toBe(1);
    expect(alpha.first_transaction_at).toBe("2024-03-01");
    expect(alpha.last_transaction_at).toBe("2026-04-01");

    const beta = resp.positions[1];
    expect(beta.amount).toBeNull();
    expect(beta.value).toBeNull();
    expect(beta.cost_basis).toBeNull();
    expect(beta.realized_gain).toBe("-20.00");
    expect(beta.total_return).toBe("-20.00");

    expect(resp.summary.realized_gain).toBe("168.00");
    expect(resp.summary.income).toBe("12.50");
    expect(resp.summary.fees).toBe("10.00");
    expect(resp.summary.taxes).toBe("9.50");
    expect(resp.summary.total_return).toBe("297.50");
    expect(resp.summary.open_positions).toBe(1);
    expect(resp.summary.closed_positions).toBe(1);
    expect(resp.summary.transaction_count).toBe(5);

    expect(resp.years.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    const y2024 = resp.years[2];
    expect(y2024.fees).toBe("5.00");
    expect(y2024.net_invested).toBe("1005.00");
    const y2025 = resp.years[1];
    expect(y2025.realized).toBe("168.00");
    expect(y2025.sell_count).toBe(2);
    expect(y2025.fees).toBe("5.00");
    expect(y2025.taxes).toBe("5.00");
    // 100 buy − 590 sell − 80 sell
    expect(y2025.net_invested).toBe("-570.00");
    const y2026 = resp.years[0];
    expect(y2026.income).toBe("12.50");
    expect(y2026.dividend_count).toBe(1);
    expect(y2026.taxes).toBe("4.50");
  });

  it("flags an open position without any cost basis instead of guessing", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");
    await insertHolding({
      accountId: depot,
      asOf: "2026-09-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "6",
      price: "120.00",
      value: "720.00",
    });

    const resp = await getPortfolio({});
    expect(resp.positions[0].cost_basis).toBeNull();
    expect(resp.positions[0].unrealized_gain).toBeNull();
    expect(resp.summary.cost_basis_complete).toBe(false);
    expect(resp.summary.unrealized_gain_pct).toBeNull();
  });

  it("limits non-admins to depots on their ACL and keeps the selector complete", async () => {
    const bc = await insertBankcontact();
    const mine = await insertAccount(bc, "depot", "Mine");
    const other = await insertAccount(bc, "depot", "Other");
    await grantRead(mine, 7);
    await insertHolding({
      accountId: mine,
      asOf: "2026-09-01",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "1",
      price: "10.00",
      value: "10.00",
    });
    await insertHolding({
      accountId: other,
      asOf: "2026-09-01",
      isin: ISIN_B,
      name: "Beta ETF",
      amount: "1",
      price: "99.00",
      value: "99.00",
    });

    setAuth("7", ["finance.view"]);
    const resp = await getPortfolio({});
    expect(resp.accounts.map((a) => a.id)).toEqual([mine]);
    expect(resp.positions.map((p) => p.key)).toEqual([ISIN_A]);

    // Asking for the other depot explicitly does not leak it either.
    const narrowed = await getPortfolio({ accounts: `${mine},${other}` });
    expect(narrowed.positions.map((p) => p.key)).toEqual([ISIN_A]);
    expect(narrowed.accounts.map((a) => a.id)).toEqual([mine]);
  });

  it("rejects a malformed accounts parameter", async () => {
    await expect(getPortfolio({ accounts: "1,x" })).rejects.toThrow(/comma-separated/);
  });
});

describe("finance/portfolio — listPortfolioTransactions", () => {
  async function seed(): Promise<{ d1: number; d2: number }> {
    const bc = await insertBankcontact();
    const d1 = await insertAccount(bc, "depot", "Depot 1");
    const d2 = await insertAccount(bc, "depot", "Depot 2");
    await insertTx({
      accountId: d1,
      kind: "buy",
      executedAt: "2025-01-10",
      isin: ISIN_A,
      name: "Alpha AG",
      amount: "10",
      price: "100.00",
      net: "-1000.00",
      fees: "5.00",
    });
    await insertTx({
      accountId: d1,
      kind: "dividend",
      executedAt: "2025-05-10",
      isin: ISIN_A,
      name: "Alpha AG",
      net: "20.00",
      tax: "5.00",
    });
    await insertTx({
      accountId: d2,
      kind: "buy",
      executedAt: "2025-03-10",
      wkn: "BBB222",
      name: "Beta ETF",
      amount: "2",
      price: "50.00",
      net: "-100.00",
    });
    return { d1, d2 };
  }

  it("lists across depots, newest first, with labels, keys and sums", async () => {
    const { d1, d2 } = await seed();
    const resp = await listPortfolioTransactions({});
    expect(resp.total).toBe(3);
    expect(resp.items.map((i) => i.executed_at)).toEqual([
      "2025-05-10",
      "2025-03-10",
      "2025-01-10",
    ]);
    expect(resp.items[0].account_id).toBe(d1);
    expect(resp.items[0].account_label).toBe("Depot 1");
    expect(resp.items[1].account_id).toBe(d2);
    expect(resp.items[1].position_key).toBe("BBB222");
    expect(resp.sums.net_amount).toBe("-1080.00");
    expect(resp.sums.fees).toBe("5.00");
    expect(resp.sums.taxes).toBe("5.00");
  });

  it("filters by kind, position, account, text and date", async () => {
    const { d2 } = await seed();

    const dividends = await listPortfolioTransactions({ kind: "dividend" });
    expect(dividends.items.map((i) => i.kind)).toEqual(["dividend"]);

    const alpha = await listPortfolioTransactions({ position: ISIN_A });
    expect(alpha.total).toBe(2);

    const beta = await listPortfolioTransactions({ accounts: String(d2) });
    expect(beta.items.map((i) => i.name)).toEqual(["Beta ETF"]);

    const text = await listPortfolioTransactions({ q: "beta" });
    expect(text.total).toBe(1);

    const range = await listPortfolioTransactions({ from: "2025-02-01", to: "2025-04-01" });
    expect(range.items.map((i) => i.executed_at)).toEqual(["2025-03-10"]);

    await expect(listPortfolioTransactions({ kind: "lottery" })).rejects.toThrow(/invalid kind/);
    await expect(listPortfolioTransactions({ from: "2025-05-01", to: "2025-01-01" })).rejects.toThrow(/before/);
  });

  it("sorts and paginates", async () => {
    await seed();
    const byAmount = await listPortfolioTransactions({ sortBy: "net_amount", sortDir: "asc" });
    expect(byAmount.items.map((i) => i.net_amount)).toEqual(["-1000.00", "-100.00", "20.00"]);

    const page = await listPortfolioTransactions({ limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].executed_at).toBe("2025-01-10");
  });

  it("hides depots a non-admin may not read", async () => {
    const { d1 } = await seed();
    await grantRead(d1, 9);
    setAuth("9", ["finance.view"]);
    const resp = await listPortfolioTransactions({});
    expect(resp.total).toBe(2);
    expect(resp.items.every((i) => i.account_id === d1)).toBe(true);
  });
});

describe("finance/portfolio — getPortfolioPosition", () => {
  it("returns the position with depot shares, history, sales and years", async () => {
    const bc = await insertBankcontact();
    const d1 = await insertAccount(bc, "depot", "Depot 1");
    const d2 = await insertAccount(bc, "depot", "Depot 2");

    await insertTx({ accountId: d1, kind: "buy", executedAt: "2024-03-01", isin: ISIN_A, name: "Alpha AG", amount: "10", price: "100.00", net: "-1005.00", fees: "5.00" });
    await insertTx({ accountId: d1, kind: "sell", executedAt: "2025-06-01", isin: ISIN_A, name: "Alpha AG", amount: "4", price: "150.00", net: "590.00", fees: "5.00", tax: "5.00" });
    await insertTx({ accountId: d1, kind: "dividend", executedAt: "2026-04-01", isin: ISIN_A, name: "Alpha AG", net: "12.50", tax: "4.50" });
    await insertTx({ accountId: d2, kind: "buy", executedAt: "2025-09-01", isin: ISIN_A, name: "Alpha AG", amount: "2", price: "130.00", net: "-260.00" });
    // Unrelated position must not leak into the detail.
    await insertTx({ accountId: d2, kind: "buy", executedAt: "2025-09-02", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "10.00", net: "-10.00" });

    await insertHolding({ accountId: d1, asOf: "2026-08-01", isin: ISIN_A, name: "Alpha AG", amount: "6", price: "110.00", value: "660.00" });
    await insertHolding({ accountId: d1, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "6", price: "120.00", value: "720.00" });
    await insertHolding({ accountId: d2, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "2", price: "121.00", value: "242.00", acquisitionPrice: "130.00" });
    await insertHolding({ accountId: d2, asOf: "2026-09-01", isin: ISIN_B, name: "Beta ETF", amount: "1", price: "11.00", value: "11.00" });

    const resp = await getPortfolioPosition({ key: ISIN_A });
    expect(resp.position.key).toBe(ISIN_A);
    expect(Number(resp.position.amount)).toBe(8);
    expect(resp.position.value).toBe("962.00");
    // 6 × 100.50 (WAC with the buy's fees) + 2 × 130 (bank)
    expect(resp.position.cost_basis).toBe("863.00");
    expect(resp.position.cost_basis_source).toBe("tx-wac");

    expect(resp.accounts.map((a) => [a.account_label, a.cost_basis, a.cost_basis_source])).toEqual([
      ["Depot 1", "603.00", "tx-wac"],
      ["Depot 2", "260.00", "bank"],
    ]);

    expect(resp.history.map((h) => [h.as_of, h.amount && Number(h.amount), h.value])).toEqual([
      ["2026-08-01", 6, "660.00"],
      ["2026-09-01", 8, "962.00"],
    ]);

    expect(resp.sales).toHaveLength(1);
    expect(resp.sales[0].quantity).toBe("4.00000000");
    expect(resp.sales[0].cost).toBe("402.00");
    expect(resp.sales[0].proceeds).toBe("590.00");
    expect(resp.sales[0].gain).toBe("188.00");
    expect(resp.sales[0].cost_per_unit).toBe("100.500000");

    expect(resp.transactions.map((t) => t.kind)).toEqual(["dividend", "buy", "sell", "buy"]);
    expect(resp.transactions.every((t) => t.position_key === ISIN_A)).toBe(true);

    expect(resp.years.map((y) => [y.year, y.realized, y.income, y.fees, y.taxes, y.sell_count, y.dividend_count])).toEqual([
      [2026, "0.00", "12.50", "0.00", "4.50", 0, 1],
      [2025, "188.00", "0.00", "5.00", "5.00", 1, 0],
      [2024, "0.00", "0.00", "5.00", "0.00", 0, 0],
    ]);
  });

  it("404s for an unknown key and for a depot outside the ACL", async () => {
    const bc = await insertBankcontact();
    const depot = await insertAccount(bc, "depot", "Depot");
    await insertHolding({ accountId: depot, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "1", price: "10.00", value: "10.00" });

    await expect(getPortfolioPosition({ key: "NOPE" })).rejects.toThrow(/not found/);

    await ensureUser(5);
    setAuth("5", ["finance.view"]);
    await expect(getPortfolioPosition({ key: ISIN_A })).rejects.toThrow(/not found/);
  });
});

describe("finance/portfolio — closed depots", () => {
  it("leaves closed depots out unless asked for, and counts what it hid", async () => {
    const bc = await insertBankcontact();
    const open = await insertAccount(bc, "depot", "Offen");
    const closed = await insertAccount(bc, "depot", "Geschlossen");
    await db.update(financeAccount).set({ closed_at: "2024-01-01T00:00:00Z" }).where(eq(financeAccount.id, closed));
    await insertHolding({ accountId: open, asOf: "2026-09-01", isin: ISIN_A, name: "Alpha AG", amount: "1", price: "10.00", value: "10.00" });
    await insertTx({ accountId: closed, kind: "sell", executedAt: "2023-05-01", isin: ISIN_B, name: "Beta ETF", amount: "2", price: "50.00", net: "100.00" });

    const def = await getPortfolio({});
    expect(def.accounts.map((a) => [a.label, a.closed])).toEqual([["Geschlossen", true], ["Offen", false]]);
    expect(def.closed_hidden).toBe(1);
    expect(def.positions.map((p) => p.key)).toEqual([ISIN_A]);
    expect((await listPortfolioTransactions({})).total).toBe(0);

    const all = await getPortfolio({ closed: true });
    expect(all.closed_hidden).toBe(0);
    expect(all.positions.map((p) => p.key).sort()).toEqual([ISIN_A, ISIN_B].sort());
    expect((await listPortfolioTransactions({ closed: true })).total).toBe(1);

    // Picked by id, a closed depot is in scope.
    const picked = await getPortfolio({ accounts: String(closed) });
    expect(picked.positions.map((p) => p.key)).toEqual([ISIN_B]);
    expect(picked.closed_hidden).toBe(0);
    await expect(getPortfolioPosition({ key: ISIN_B })).rejects.toThrow(/not found/);
    expect((await getPortfolioPosition({ key: ISIN_B, closed: true })).position.key).toBe(ISIN_B);
  });
});
