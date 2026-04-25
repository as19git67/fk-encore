import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import {
  batchTag,
  createTransaction,
  getTransaction,
  listTransactions,
  promoteAiTag,
} from "./transactions";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", []);
});

async function createAccounts(): Promise<{ a: number; b: number }> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "T", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [a] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "A",
      label: "Giro A",
    })
    .returning({ id: financeAccount.id });
  const [b] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "B",
      label: "Giro B",
    })
    .returning({ id: financeAccount.id });
  return { a: a.id, b: b.id };
}

async function grant(accountId: number, userId: number, level: "read" | "write") {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level,
  });
}

async function insertTx(
  accountId: number,
  overrides: Partial<typeof financeTransaction.$inferInsert> = {},
): Promise<number> {
  const bookingDate = overrides.booking_date ?? "2024-08-15";
  const amount = overrides.amount ?? "100.00";
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: bookingDate,
      amount,
      currency_code: "EUR",
      dedupe_hash: `hash-${accountId}-${bookingDate}-${amount}-${Math.random()}`,
      ...overrides,
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

async function insertTag(
  name: string,
  source: "user" | "ai" = "user",
): Promise<number> {
  const [row] = await db
    .insert(financeTag)
    .values({ name, source })
    .returning({ id: financeTag.id });
  return row.id;
}

// ================= LIST =================

describe("finance/transactions — list (ACL filter)", () => {
  it("returns only transactions on accounts the caller has ACL for", async () => {
    const { a, b } = await createAccounts();
    await insertTx(a);
    await insertTx(a);
    await insertTx(b);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const { items, total } = await listTransactions({});
    expect(total).toBe(2);
    expect(items.every((i) => i.account_id === a)).toBe(true);
  });

  it("returns empty when the user has no ACL entries", async () => {
    const { a } = await createAccounts();
    await insertTx(a);

    setAuth("99", ["finance.view"]);
    await ensureUser(99);
    const { items } = await listTransactions({});
    expect(items).toHaveLength(0);
  });

  it("finance.admin sees transactions across all accounts", async () => {
    const { a, b } = await createAccounts();
    await insertTx(a);
    await insertTx(b);

    setAuth("1", ["finance.view", "finance.admin"]);
    const { total } = await listTransactions({});
    expect(total).toBe(2);
  });

  it("filters by explicit accountId (falls back to empty when not in ACL)", async () => {
    const { a, b } = await createAccounts();
    await insertTx(a);
    await insertTx(b);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const onlyB = await listTransactions({ accountId: b });
    expect(onlyB.items).toHaveLength(0);
  });

  it("filters by date range (inclusive)", async () => {
    const { a } = await createAccounts();
    await insertTx(a, { booking_date: "2024-07-01" });
    await insertTx(a, { booking_date: "2024-08-15" });
    await insertTx(a, { booking_date: "2024-09-30" });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const july = await listTransactions({
      from: "2024-07-01",
      to: "2024-08-31",
    });
    expect(july.total).toBe(2);
  });

  it("annotates each transaction with its tags", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    const tagId = await insertTag("miete", "user");
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: tagId, transaction_id: txId });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const { items } = await listTransactions({});
    expect(items[0].tags).toEqual([
      { name: "miete", source: "user", confidence: null },
    ]);
  });

  it("orders by booking_date desc", async () => {
    const { a } = await createAccounts();
    await insertTx(a, { booking_date: "2024-07-01" });
    await insertTx(a, { booking_date: "2024-09-30" });
    await insertTx(a, { booking_date: "2024-08-15" });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const { items } = await listTransactions({});
    expect(items.map((i) => i.booking_date)).toEqual([
      "2024-09-30",
      "2024-08-15",
      "2024-07-01",
    ]);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(listTransactions({})).rejects.toThrow(/permission/);
  });
});

// ================= GET =================

describe("finance/transactions — get", () => {
  it("returns the transaction for an ACL-enabled user", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await getTransaction({ id: txId });
    expect(result.id).toBe(txId);
  });

  it("404s for a transaction the user has no ACL for", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    setAuth("7", ["finance.view"]);
    await ensureUser(7);

    await expect(getTransaction({ id: txId })).rejects.toThrow(/not found/);
  });

  it("404s for unknown id", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(getTransaction({ id: 999_999 })).rejects.toThrow(/not found/);
  });
});

// ================= CREATE =================

describe("finance/transactions — create (manual booking)", () => {
  it("requires write ACL on the target account", async () => {
    const { a } = await createAccounts();
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    await expect(
      createTransaction({
        account_id: a,
        booking_date: "2024-08-15",
        amount: 100,
      }),
    ).rejects.toThrow(/write access/);
  });

  it("succeeds for a write-level user", async () => {
    const { a } = await createAccounts();
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "write");
    const result = await createTransaction({
      account_id: a,
      booking_date: "2024-08-15",
      amount: -42.5,
      purpose: "Kaffee",
      tags: ["alltag"],
    });
    expect(result.amount).toBe("-42.50");
    expect(result.purpose).toBe("Kaffee");
    expect(result.tags.map((t) => t.name)).toContain("alltag");
  });

  it("finance.admin can book on any account", async () => {
    const { a } = await createAccounts();
    setAuth("1", ["finance.view", "finance.admin"]);
    const result = await createTransaction({
      account_id: a,
      booking_date: "2024-08-15",
      amount: 100,
    });
    expect(result.id).toBeGreaterThan(0);
  });

  it("rejects zero amount", async () => {
    const { a } = await createAccounts();
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      createTransaction({
        account_id: a,
        booking_date: "2024-08-15",
        amount: 0,
      }),
    ).rejects.toThrow(/non-zero/);
  });

  it("catches duplicate bookings via dedupe_hash unique index", async () => {
    const { a } = await createAccounts();
    setAuth("1", ["finance.view", "finance.admin"]);
    const args = {
      account_id: a,
      booking_date: "2024-08-15",
      amount: 100,
      purpose: "same",
    };
    await createTransaction(args);
    await expect(createTransaction(args)).rejects.toThrow(/duplicate/);
  });

  it("404s on unknown account", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      createTransaction({
        account_id: 999_999,
        booking_date: "2024-08-15",
        amount: 100,
      }),
    ).rejects.toThrow(/account.*not found/);
  });
});

// ================= PROMOTE =================

describe("finance/transactions — promoteAiTag", () => {
  it("moves an AI-join to a user-join and creates a user tag if missing", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    const aiTagId = await insertTag("urlaub", "ai");
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: aiTagId, transaction_id: txId, confidence: "0.620" });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await promoteAiTag({ id: txId, tag: "urlaub" });
    expect(result.promoted).toBe(true);

    // AI join gone
    const joins = await db
      .select()
      .from(financeTagTransaction)
      .where(eq(financeTagTransaction.transaction_id, txId));
    const sources = new Set(
      (
        await db
          .select({ source: financeTag.source })
          .from(financeTag)
          .where(
            // any tag that's linked to this tx
            // (there should be just one)
            eq(financeTag.name, "urlaub"),
          )
      ).map((r) => r.source),
    );
    expect(joins).toHaveLength(1);
    expect(sources).toContain("user");
  });

  it("is idempotent when the user-tag already exists", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    await insertTag("urlaub", "user");

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await promoteAiTag({ id: txId, tag: "urlaub" });
    expect(result.tags.find((t) => t.name === "urlaub")?.source).toBe("user");
  });

  it("404s for a transaction the caller has no ACL for", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    setAuth("7", ["finance.view"]);
    await ensureUser(7);
    await expect(
      promoteAiTag({ id: txId, tag: "x" }),
    ).rejects.toThrow(/not found/);
  });
});

// ================= BATCH-TAG =================

describe("finance/transactions — batchTag", () => {
  it("adds tags across the selection and reports counters", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a, { booking_date: "2024-08-10" });
    const t2 = await insertTx(a, { booking_date: "2024-08-11" });
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await batchTag({
      transaction_ids: [t1, t2],
      add: ["urlaub", "italien-2024"],
    });
    expect(result).toEqual({
      affected_transactions: 2,
      added_links: 4, // 2 tx × 2 tags
      removed_links: 0,
    });
  });

  it("silently skips transactions outside the caller's ACL", async () => {
    const { a, b } = await createAccounts();
    const t1 = await insertTx(a);
    const t2 = await insertTx(b);
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await batchTag({
      transaction_ids: [t1, t2],
      add: ["urlaub"],
    });
    expect(result.affected_transactions).toBe(1);
    expect(result.added_links).toBe(1);
  });

  it("remove drops only user-tags (AI suggestions stay)", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a);
    const userTagId = await insertTag("alltag", "user");
    const aiTagId = await insertTag("alltag", "ai");
    await db.insert(financeTagTransaction).values([
      { tag_id: userTagId, transaction_id: t1 },
      { tag_id: aiTagId, transaction_id: t1, confidence: "0.400" },
    ]);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await batchTag({
      transaction_ids: [t1],
      remove: ["alltag"],
    });
    expect(result.removed_links).toBe(1);

    const joins = await db
      .select({ tag_id: financeTagTransaction.tag_id })
      .from(financeTagTransaction)
      .where(eq(financeTagTransaction.transaction_id, t1));
    expect(joins).toHaveLength(1);
    expect(joins[0].tag_id).toBe(aiTagId);
  });

  it("replace clears all existing user-tags before adding", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a);
    const old = await insertTag("alltag", "user");
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: old, transaction_id: t1 });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await batchTag({
      transaction_ids: [t1],
      add: ["urlaub"],
      replace: true,
    });
    expect(result.removed_links).toBe(1);
    expect(result.added_links).toBe(1);
  });

  it("rejects empty transaction_ids", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      batchTag({ transaction_ids: [], add: ["x"] }),
    ).rejects.toThrow(/transaction_ids/);
  });

  it("rejects when neither add nor remove nor replace is supplied", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      batchTag({ transaction_ids: [1] }),
    ).rejects.toThrow(/add \/ remove \/ replace/);
  });
});
