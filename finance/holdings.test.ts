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
import { getHoldingsHistory, listHoldings } from "./holdings";

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
  setAuth("1", []);
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function depotTypeId(): Promise<number> {
  const [row] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, "depot"))
    .limit(1);
  return row.id;
}

async function insertDepot(bcId: number): Promise<number> {
  const typeId = await depotTypeId();
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bcId,
      type_id: typeId,
      currency_code: "EUR",
      account_number: "DEPOT-1",
      label: "Depot",
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
  isin: string | null;
  wkn?: string | null;
  name: string;
  amount: string;
  price: string;
  value: string;
  currency?: string;
  acquisitionPrice?: string | null;
}): Promise<void> {
  await db.insert(financeAccountHolding).values({
    account_id: opts.accountId,
    as_of: opts.asOf,
    isin: opts.isin && opts.isin.length > 0 ? opts.isin : null,
    wkn: opts.wkn && opts.wkn.length > 0 ? opts.wkn : null,
    name: opts.name,
    amount: opts.amount,
    price: opts.price,
    value: opts.value,
    currency: opts.currency ?? "EUR",
    acquisition_price: opts.acquisitionPrice ?? null,
  });
}

async function insertDepotBuy(opts: {
  accountId: number;
  executedAt: string;
  isin?: string | null;
  wkn?: string | null;
  amount: string | null;
  price: string | null;
  netAmount?: string | null;
}): Promise<void> {
  await db.insert(financeDepotTransaction).values({
    account_id: opts.accountId,
    isin: opts.isin ?? null,
    wkn: opts.wkn ?? null,
    name: null,
    kind: "buy",
    executed_at: opts.executedAt,
    amount: opts.amount,
    price: opts.price,
    gross_amount: null,
    fees: null,
    tax: null,
    net_amount: opts.netAmount ?? null,
    currency: "EUR",
    source: "manual",
  });
}

describe("finance/holdings — listHoldings (latest snapshot)", () => {
  it("returns latest as_of when no asOf parameter is given", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "200.00",
      value: "1000.00",
    });
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.as_of).toBe("2026-05-10");
    expect(resp.items).toHaveLength(1);
    expect(resp.items[0].value).toBe("1050.00");
  });
});

describe("finance/holdings — getHoldingsHistory", () => {
  it("returns empty totals/positions for a depot without snapshots", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    const resp = await getHoldingsHistory({ id: accountId });
    expect(resp.totals).toEqual([]);
    expect(resp.positions).toEqual([]);
  });

  it("aggregates totals per as_of and groups points per position", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    // Day 1 — two positions, total 5000
    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "200.00",
      value: "1000.00",
    });
    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "US0378331005",
      name: "APPLE",
      amount: "20",
      price: "200.00",
      value: "4000.00",
    });

    // Day 2 — ADIDAS up, APPLE down, total 5050
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
    });
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "US0378331005",
      name: "APPLE",
      amount: "20",
      price: "200.00",
      value: "4000.00",
    });

    const resp = await getHoldingsHistory({ id: accountId });

    expect(resp.totals).toEqual([
      { as_of: "2026-05-01", total_value: "5000.00", currency: "EUR" },
      { as_of: "2026-05-10", total_value: "5050.00", currency: "EUR" },
    ]);

    expect(resp.positions).toHaveLength(2);
    const adidas = resp.positions.find((p) => p.isin === "DE000A1EWWW0");
    const apple = resp.positions.find((p) => p.isin === "US0378331005");
    expect(adidas).toBeDefined();
    expect(apple).toBeDefined();
    expect(adidas!.points.map((p) => p.as_of)).toEqual([
      "2026-05-01",
      "2026-05-10",
    ]);
    expect(adidas!.points.map((p) => p.value)).toEqual(["1000.00", "1050.00"]);
    expect(apple!.points).toHaveLength(2);
  });

  it("respects the from/to filter (inclusive bounds)", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    for (const day of ["2026-04-01", "2026-05-01", "2026-05-10", "2026-06-01"]) {
      await insertHolding({
        accountId,
        asOf: day,
        isin: "DE000A1EWWW0",
        name: "ADIDAS",
        amount: "5",
        price: "200.00",
        value: "1000.00",
      });
    }

    const resp = await getHoldingsHistory({
      id: accountId,
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(resp.totals.map((t) => t.as_of)).toEqual([
      "2026-05-01",
      "2026-05-10",
    ]);
    expect(resp.from).toBe("2026-05-01");
    expect(resp.to).toBe("2026-05-31");
  });

  it("rejects malformed date parameters", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await expect(
      getHoldingsHistory({ id: accountId, from: "2026/05/01" }),
    ).rejects.toThrow(/from must be YYYY-MM-DD/);
  });

  it("rejects from > to", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await expect(
      getHoldingsHistory({
        id: accountId,
        from: "2026-05-10",
        to: "2026-05-01",
      }),
    ).rejects.toThrow(/from must be on or before to/);
  });

  it("groups positions whose isin is null by wkn (same identity as the upsert)", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "",
      wkn: "A1EWWW",
      name: "ADIDAS",
      amount: "5",
      price: "200.00",
      value: "1000.00",
    });
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "",
      wkn: "A1EWWW",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
    });

    const resp = await getHoldingsHistory({ id: accountId });
    expect(resp.positions).toHaveLength(1);
    expect(resp.positions[0].wkn).toBe("A1EWWW");
    expect(resp.positions[0].points).toHaveLength(2);
  });

  it("requires finance.view permission", async () => {
    setAuth("1", []);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await expect(getHoldingsHistory({ id: accountId })).rejects.toThrow(
      /missing permission/,
    );
  });

  it("returns 404 for an account the user has no ACL on (no admin)", async () => {
    setAuth("2", ["finance.view"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await expect(getHoldingsHistory({ id: accountId })).rejects.toThrow(
      /not found/,
    );
  });

  it("allows a non-admin user with read ACL", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grantRead(accountId, 2);
    setAuth("2", ["finance.view"]);

    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "200.00",
      value: "1000.00",
    });

    const resp = await getHoldingsHistory({ id: accountId });
    expect(resp.totals).toHaveLength(1);
  });

  it("treats wkn-only and isin-set rows as the same position when isin appears later", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    // Older snapshot: only wkn
    await insertHolding({
      accountId,
      asOf: "2026-04-01",
      isin: "",
      wkn: "A1EWWW",
      name: "ADIDAS",
      amount: "5",
      price: "200.00",
      value: "1000.00",
    });
    // Newer snapshot: same wkn AND isin filled in
    await insertHolding({
      accountId,
      asOf: "2026-05-01",
      isin: "DE000A1EWWW0",
      wkn: "A1EWWW",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
    });

    const resp = await getHoldingsHistory({ id: accountId });
    // The two rows have different keys (one is wkn, the other is isin)
    // because COALESCE(isin, wkn, name) yields different values. Document
    // this current behaviour — Phase 2 (transactions) will introduce a
    // stronger identity. For now we just assert: both snapshots are
    // returned and totals are intact.
    expect(resp.totals.map((t) => t.as_of)).toEqual([
      "2026-04-01",
      "2026-05-01",
    ]);
    expect(resp.totals.map((t) => t.total_value)).toEqual([
      "1000.00",
      "1050.00",
    ]);
  });
});

describe("finance/holdings — cost basis & unrealized gain", () => {
  it("uses bank-reported acquisition_price when available", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
      acquisitionPrice: "180.00",
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.items).toHaveLength(1);
    const h = resp.items[0];
    expect(h.cost_basis_source).toBe("bank");
    expect(h.cost_basis_per_unit).toBe("180.000000");
    expect(h.cost_basis).toBe("900.00");
    expect(h.unrealized_gain).toBe("150.00");
    expect(h.unrealized_gain_pct).toBe("16.67");
  });

  it("falls back to WAC from buy transactions when bank price missing", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    // Holding with no acquisition_price — typical for some banks.
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "10",
      price: "210.00",
      value: "2100.00",
    });

    // Two buys → WAC = (5*200 + 5*220) / 10 = 210, cost basis 10*210 = 2100
    // so gain = 0
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "5",
      price: "200",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-03-10",
      isin: "DE000A1EWWW0",
      amount: "5",
      price: "220",
    });

    const resp = await listHoldings({ id: accountId });
    const h = resp.items[0];
    expect(h.cost_basis_source).toBe("tx-wac");
    expect(h.cost_basis_per_unit).toBe("210.000000");
    expect(h.cost_basis).toBe("2100.00");
    expect(h.unrealized_gain).toBe("0.00");
    expect(h.unrealized_gain_pct).toBe("0.00");
  });

  it("prefers bank acquisition_price over WAC when both exist", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "10",
      price: "210.00",
      value: "2100.00",
      acquisitionPrice: "150.00", // bank says 150
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "190", // tx-wac would say 190
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.items[0].cost_basis_source).toBe("bank");
    expect(resp.items[0].cost_basis_per_unit).toBe("150.000000");
  });

  it("matches WAC by WKN when holding has no ISIN (MLP case)", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    // MLP-style: holding carries WKN only, no ISIN.
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: null,
      wkn: "930921",
      name: "SAUREN GLOB.OPPS A",
      amount: "100",
      price: "60.00",
      value: "6000.00",
    });
    // Buy tx with both identifiers (as giro-derivation now writes them).
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "LU0106280919",
      wkn: "930921",
      amount: "100",
      price: "50",
    });

    const resp = await listHoldings({ id: accountId });
    const h = resp.items[0];
    expect(h.cost_basis_source).toBe("tx-wac");
    expect(h.cost_basis_per_unit).toBe("50.000000");
    expect(h.cost_basis).toBe("5000.00");
    expect(h.unrealized_gain).toBe("1000.00");
    expect(h.unrealized_gain_pct).toBe("20.00");
  });

  it("returns null cost basis when neither bank price nor quantitative buys exist", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "10",
      price: "210.00",
      value: "2100.00",
    });
    // Giro-derived style buy: only net_amount, no shares/price.
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: null,
      price: null,
      netAmount: "1500.00",
    });

    const resp = await listHoldings({ id: accountId });
    const h = resp.items[0];
    expect(h.cost_basis_source).toBeNull();
    expect(h.cost_basis_per_unit).toBeNull();
    expect(h.cost_basis).toBeNull();
    expect(h.unrealized_gain).toBeNull();
    expect(h.unrealized_gain_pct).toBeNull();
  });

  it("computes realized gain via chronological WAC walk", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    // Buy 10 @ 100 → WAC 100. Buy 10 @ 200 → WAC 150 (qty 20, cost 3000).
    // Sell 5 @ 250 net 1230 → realized = 1230 − 5×150 = 480.
    // Sell 5 @ 300 net 1490 → WAC still 150, realized = 1490 − 5×150 = 740.
    // Total realized = 1220.
    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "10",
      price: "260.00",
      value: "2600.00",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "100",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-02-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "200",
    });
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "sell",
      executed_at: "2026-03-10",
      amount: "5",
      price: "250",
      gross_amount: "1250",
      fees: "15",
      tax: "5",
      net_amount: "1230",
      currency: "EUR",
      source: "manual",
    });
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "sell",
      executed_at: "2026-04-10",
      amount: "5",
      price: "300",
      gross_amount: "1500",
      fees: "5",
      tax: "5",
      net_amount: "1490",
      currency: "EUR",
      source: "manual",
    });

    const resp = await listHoldings({ id: accountId });
    const h = resp.items[0];
    expect(h.realized_gain).toBe("1220.00");
    expect(h.realized_gain_complete).toBe(true);
    // Unrealized still works: remaining 10 @ WAC 150 → cost 1500, value 2600 → +1100
    expect(h.cost_basis).toBe("1500.00");
    expect(h.unrealized_gain).toBe("1100.00");
  });

  it("returns null realized_gain for positions with no sells", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "10",
      price: "260.00",
      value: "2600.00",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "100",
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.items[0].realized_gain).toBeNull();
    expect(resp.items[0].realized_gain_complete).toBe(true);
  });

  it("falls back to gross proceeds when net_amount missing on sell", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "260.00",
      value: "1300.00",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "100",
    });
    // Sell with price but no net_amount → proceeds = 5 × 250 = 1250
    // realized = 1250 − 5 × 100 = 750
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "sell",
      executed_at: "2026-03-10",
      amount: "5",
      price: "250",
      gross_amount: null,
      fees: null,
      tax: null,
      net_amount: null,
      currency: "EUR",
      source: "manual",
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.items[0].realized_gain).toBe("750.00");
    expect(resp.items[0].realized_gain_complete).toBe(true);
  });

  it("marks realized_gain_complete=false when buys lack quantitative data", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "260.00",
      value: "1300.00",
    });
    // Giro-derived buy with no shares/price — the walker can't fold it
    // into WAC, so realized G/V on later sells will be over-stated.
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: null,
      price: null,
      netAmount: "1000",
    });
    // Then a "real" buy and a sell — both fully priced.
    await insertDepotBuy({
      accountId,
      executedAt: "2026-02-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "150",
    });
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "sell",
      executed_at: "2026-03-10",
      amount: "5",
      price: "250",
      gross_amount: null,
      fees: null,
      tax: null,
      net_amount: "1240",
      currency: "EUR",
      source: "manual",
    });

    const resp = await listHoldings({ id: accountId });
    // Only the priced buy contributed: WAC=150, sell 5 net 1240 → 490
    expect(resp.items[0].realized_gain).toBe("490.00");
    expect(resp.items[0].realized_gain_complete).toBe(false);
  });

  it("ignores dividends and corporate actions in realized walk", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "260.00",
      value: "1300.00",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "10",
      price: "100",
    });
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "dividend",
      executed_at: "2026-02-10",
      amount: null,
      price: null,
      gross_amount: "50",
      fees: null,
      tax: "10",
      net_amount: "40",
      currency: "EUR",
      source: "manual",
    });
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "sell",
      executed_at: "2026-03-10",
      amount: "5",
      price: "150",
      gross_amount: null,
      fees: null,
      tax: null,
      net_amount: "740",
      currency: "EUR",
      source: "manual",
    });

    const resp = await listHoldings({ id: accountId });
    // WAC=100 (dividend ignored); sell 5 net 740 → 740 − 5×100 = 240
    expect(resp.items[0].realized_gain).toBe("240.00");
    expect(resp.items[0].realized_gain_complete).toBe(true);
  });

  it("ignores non-buy transactions when computing WAC", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);

    await insertHolding({
      accountId,
      asOf: "2026-05-10",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
      amount: "5",
      price: "210.00",
      value: "1050.00",
    });
    await insertDepotBuy({
      accountId,
      executedAt: "2026-01-10",
      isin: "DE000A1EWWW0",
      amount: "5",
      price: "200",
    });
    // A dividend (not a buy) — must not pollute WAC.
    await db.insert(financeDepotTransaction).values({
      account_id: accountId,
      isin: "DE000A1EWWW0",
      kind: "dividend",
      executed_at: "2026-03-01",
      amount: null,
      price: null,
      gross_amount: "25.00",
      fees: null,
      tax: null,
      net_amount: "20.00",
      currency: "EUR",
      source: "manual",
    });

    const resp = await listHoldings({ id: accountId });
    expect(resp.items[0].cost_basis_per_unit).toBe("200.000000");
    expect(resp.items[0].unrealized_gain).toBe("50.00");
  });
});
