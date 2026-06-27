import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeBankcontact,
  financeDepotTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import {
  createDepotTransaction,
  deleteDepotTransaction,
  listDepotTransactions,
} from "./depot-transactions";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeDepotTransaction);
  await db.delete(financeTransaction);
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

async function grant(
  accountId: number,
  userId: number,
  level: "read" | "write",
) {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level,
  });
}

function baseCreate(accountId: number) {
  return {
    id: accountId,
    isin: "DE000A1EWWW0",
    wkn: "A1EWWW",
    name: "ADIDAS",
    kind: "buy" as const,
    executed_at: "2026-05-10",
    amount: 5,
    price: 200,
    gross_amount: 1000,
    fees: 9.9,
    net_amount: 1009.9,
  };
}

describe("finance/depot-transactions — create", () => {
  it("creates a manual buy with write ACL and inherits account currency", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 2, "write");
    setAuth("2", ["finance.view"]);

    const tx = await createDepotTransaction(baseCreate(accountId));

    expect(tx.id).toBeGreaterThan(0);
    expect(tx.kind).toBe("buy");
    expect(tx.isin).toBe("DE000A1EWWW0");
    expect(tx.executed_at).toBe("2026-05-10");
    expect(tx.amount).toBe("5.00000000");
    expect(tx.price).toBe("200.000000");
    expect(tx.gross_amount).toBe("1000.00");
    expect(tx.fees).toBe("9.90");
    expect(tx.net_amount).toBe("1009.90");
    expect(tx.currency).toBe("EUR");
    expect(tx.source).toBe("manual");
    expect(tx.linked_transaction_id).toBeNull();
  });

  it("rejects an invalid kind", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    await expect(
      createDepotTransaction({
        ...baseCreate(accountId),
        kind: "nonsense" as never,
      }),
    ).rejects.toThrow(/invalid kind/);
  });

  it("rejects a malformed executed_at", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    await expect(
      createDepotTransaction({
        ...baseCreate(accountId),
        executed_at: "10.05.2026",
      }),
    ).rejects.toThrow(/executed_at must be YYYY-MM-DD/);
  });

  it("requires at least one of isin/wkn/name", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    await expect(
      createDepotTransaction({
        id: accountId,
        kind: "buy",
        executed_at: "2026-05-10",
        isin: "",
        wkn: "  ",
        name: null,
      }),
    ).rejects.toThrow(/isin, wkn or name/);
  });

  it("denies create with only read ACL", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 2, "read");
    setAuth("2", ["finance.view"]);

    await expect(createDepotTransaction(baseCreate(accountId))).rejects.toThrow(
      /write access required/,
    );
  });

  it("returns 404 for an account the caller has no ACL on", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    setAuth("2", ["finance.view"]);

    await expect(createDepotTransaction(baseCreate(accountId))).rejects.toThrow(
      /not found/,
    );
  });

  it("requires finance.view permission", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    setAuth("1", []);

    await expect(createDepotTransaction(baseCreate(accountId))).rejects.toThrow(
      /missing permission/,
    );
  });

  it("admin may create without an explicit ACL row", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    setAuth("9", ["finance.view", "finance.admin"]);

    const tx = await createDepotTransaction(baseCreate(accountId));
    expect(tx.id).toBeGreaterThan(0);
  });
});

describe("finance/depot-transactions — list", () => {
  it("lists transactions newest-first and filters by isin", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    await createDepotTransaction({
      ...baseCreate(accountId),
      executed_at: "2026-05-01",
    });
    await createDepotTransaction({
      ...baseCreate(accountId),
      executed_at: "2026-05-20",
    });
    await createDepotTransaction({
      id: accountId,
      isin: "US0378331005",
      name: "APPLE",
      kind: "dividend",
      executed_at: "2026-05-10",
      net_amount: 12.5,
    });

    const all = await listDepotTransactions({ id: accountId });
    expect(all.items).toHaveLength(3);
    expect(all.items.map((i) => i.executed_at)).toEqual([
      "2026-05-20",
      "2026-05-10",
      "2026-05-01",
    ]);

    const adidasOnly = await listDepotTransactions({
      id: accountId,
      isin: "DE000A1EWWW0",
    });
    expect(adidasOnly.items).toHaveLength(2);
    expect(adidasOnly.items.every((i) => i.isin === "DE000A1EWWW0")).toBe(true);
  });

  it("allows a read-only ACL user to list", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);
    await createDepotTransaction(baseCreate(accountId));

    await grant(accountId, 2, "read");
    setAuth("2", ["finance.view"]);
    const resp = await listDepotTransactions({ id: accountId });
    expect(resp.items).toHaveLength(1);
  });

  it("returns 404 for an account the caller has no ACL on", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    setAuth("2", ["finance.view"]);
    await expect(listDepotTransactions({ id: accountId })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("finance/depot-transactions — delete", () => {
  it("deletes a manual transaction with write ACL", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    const tx = await createDepotTransaction(baseCreate(accountId));
    const resp = await deleteDepotTransaction({ txId: tx.id });
    expect(resp.deleted).toBe(true);

    const remaining = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, accountId));
    expect(remaining).toHaveLength(0);
  });

  it("refuses to delete a non-manual (derived) transaction", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);

    const [row] = await db
      .insert(financeDepotTransaction)
      .values({
        account_id: accountId,
        isin: "DE000A1EWWW0",
        name: "ADIDAS",
        kind: "buy",
        executed_at: "2026-05-10",
        source: "giro-derived",
      })
      .returning();

    await expect(deleteDepotTransaction({ txId: row.id })).rejects.toThrow(
      /only manually entered/,
    );
  });

  it("denies delete with only read ACL", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertDepot(bcId);
    await grant(accountId, 1, "write");
    setAuth("1", ["finance.view"]);
    const tx = await createDepotTransaction(baseCreate(accountId));

    await grant(accountId, 2, "read");
    setAuth("2", ["finance.view"]);
    await expect(deleteDepotTransaction({ txId: tx.id })).rejects.toThrow(
      /write access required/,
    );
  });

  it("returns 404 for a missing transaction", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(deleteDepotTransaction({ txId: 999999 })).rejects.toThrow(
      /not found/,
    );
  });
});
