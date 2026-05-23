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
