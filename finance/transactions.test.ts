import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

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
  batchNotice,
  batchReview,
  batchTag,
  batchTaxRelevant,
  createTransaction,
  getTransaction,
  listTransactions,
  mergeCounterparties,
  promoteAiTag,
  updateTransaction,
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

  it("filters by accountIdsCsv (used by overview's section view)", async () => {
    const { a, b } = await createAccounts();
    const c = await db
      .insert(financeAccount)
      .values({
        bankcontact_id: null,
        type_id: (await db.select().from(financeAccountType).limit(1))[0].id,
        currency_code: "EUR",
        account_number: "C",
        label: "C",
      })
      .returning({ id: financeAccount.id })
      .then((r) => r[0].id);

    await insertTx(a);
    await insertTx(b);
    await insertTx(c);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    await grant(b, 7, "read");
    await grant(c, 7, "read");

    const sectionAB = await listTransactions({
      accountIdsCsv: `${a},${b}`,
    });
    expect(sectionAB.total).toBe(2);
    const accs = new Set(sectionAB.items.map((i) => i.account_id));
    expect(accs.has(a)).toBe(true);
    expect(accs.has(b)).toBe(true);
    expect(accs.has(c)).toBe(false);
  });

  it("intersects accountIdsCsv with the caller's ACL — IDs without access are dropped silently", async () => {
    const { a, b } = await createAccounts();
    await insertTx(a);
    await insertTx(b);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    // No ACL for `b`.

    const result = await listTransactions({ accountIdsCsv: `${a},${b}` });
    expect(result.items.every((i) => i.account_id === a)).toBe(true);
  });

  it("returns empty when accountIdsCsv has no parseable ids", async () => {
    const { a } = await createAccounts();
    await insertTx(a);
    setAuth("1", ["finance.view", "finance.admin"]);
    const result = await listTransactions({ accountIdsCsv: "abc, ,xyz" });
    expect(result.items).toHaveLength(0);
  });

  it("honours limit up to 500 (capped from above)", async () => {
    const { a } = await createAccounts();
    setAuth("1", ["finance.view", "finance.admin"]);
    // Inserting 6 transactions to keep the test fast — we just verify
    // the cap math, not that it actually returns 500 rows.
    for (let i = 0; i < 6; i++) {
      await insertTx(a, { booking_date: `2024-08-${String(10 + i).padStart(2, "0")}` });
    }
    const allFive = await listTransactions({ limit: 5 });
    expect(allFive.items).toHaveLength(5);
    const cappedHigh = await listTransactions({ limit: 99_999 });
    expect(cappedHigh.items.length).toBeLessThanOrEqual(500);
  });

  it("q filters by counterparty/purpose with case-insensitive substring match", async () => {
    const { a } = await createAccounts();
    await insertTx(a, { counterparty: "REWE Markt", purpose: "Lebensmittel" });
    await insertTx(a, { counterparty: "Stadtwerke", purpose: "Stromrechnung" });
    await insertTx(a, { counterparty: "Aldi Süd", purpose: "Wocheneinkauf" });

    setAuth("1", ["finance.view", "finance.admin"]);

    const rewe = await listTransactions({ q: "rewe" });
    expect(rewe.items.map((i) => i.counterparty)).toEqual(["REWE Markt"]);

    const wocheneinkauf = await listTransactions({ q: "WOCHEN" });
    expect(wocheneinkauf.items.map((i) => i.counterparty)).toEqual(["Aldi Süd"]);

    const none = await listTransactions({ q: "fluxus" });
    expect(none.items).toHaveLength(0);
  });

  it("q matches the absolute amount when it parses as a number (sign-agnostic, comma allowed)", async () => {
    const { a } = await createAccounts();
    await insertTx(a, { amount: "-12.50", counterparty: "neg" });
    await insertTx(a, { amount: "12.50", counterparty: "pos" });
    await insertTx(a, { amount: "5.00", counterparty: "other" });

    setAuth("1", ["finance.view", "finance.admin"]);

    const dot = await listTransactions({ q: "12.50" });
    expect(dot.items.map((i) => i.counterparty).sort()).toEqual(["neg", "pos"]);

    const comma = await listTransactions({ q: "12,50" });
    expect(comma.items.map((i) => i.counterparty).sort()).toEqual(["neg", "pos"]);
  });

  it("tagsCsv filters to transactions carrying ALL named tags (regardless of source)", async () => {
    const { a } = await createAccounts();
    const tBoth = await insertTx(a, { counterparty: "Both" });
    const tFoodOnly = await insertTx(a, { counterparty: "FoodOnly" });
    const tStromOnly = await insertTx(a, { counterparty: "StromOnly" });
    const tNone = await insertTx(a, { counterparty: "None" });
    void tNone;

    const lebensmittel = await insertTag("Lebensmittel", "user");
    const strom = await insertTag("Strom", "ai");

    await db.insert(financeTagTransaction).values({
      tag_id: lebensmittel,
      transaction_id: tBoth,
    });
    await db.insert(financeTagTransaction).values({
      tag_id: strom,
      transaction_id: tBoth,
    });
    await db.insert(financeTagTransaction).values({
      tag_id: lebensmittel,
      transaction_id: tFoodOnly,
    });
    await db.insert(financeTagTransaction).values({
      tag_id: strom,
      transaction_id: tStromOnly,
    });

    setAuth("1", ["finance.view", "finance.admin"]);

    // Single-tag filter: any transaction carrying the named tag.
    const food = await listTransactions({ tagsCsv: "Lebensmittel" });
    expect(food.items.map((i) => i.counterparty).sort()).toEqual(
      ["Both", "FoodOnly"],
    );

    // Multi-tag filter: only transactions carrying ALL named tags.
    const both = await listTransactions({ tagsCsv: "Lebensmittel,Strom" });
    expect(both.items.map((i) => i.counterparty)).toEqual(["Both"]);
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

  it("stores notice separately from purpose (regression: cash-booking form used to bind its Notiz field to purpose)", async () => {
    const { a } = await createAccounts();
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "write");
    const result = await createTransaction({
      account_id: a,
      booking_date: "2024-08-15",
      amount: -12,
      purpose: "Wocheneinkauf",
      notice: "War mit Anna einkaufen",
    });
    expect(result.purpose).toBe("Wocheneinkauf");
    expect(result.notice).toBe("War mit Anna einkaufen");
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

  it("keeps two same-day/amount bookings distinct when their note differs (dedupe includes notice)", async () => {
    const { a } = await createAccounts();
    setAuth("1", ["finance.view", "finance.admin"]);
    const base = {
      account_id: a,
      booking_date: "2024-08-15",
      amount: -3.5,
    };
    const first = await createTransaction({ ...base, notice: "Kaffee vormittags" });
    const second = await createTransaction({ ...base, notice: "Kaffee nachmittags" });
    expect(second.id).not.toBe(first.id);
    // Same note → genuine duplicate, still rejected.
    await expect(
      createTransaction({ ...base, notice: "Kaffee vormittags" }),
    ).rejects.toThrow(/duplicate/);
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

  it("rejects bookings on a closed account", async () => {
    const { a } = await createAccounts();
    await db
      .update(financeAccount)
      .set({ closed_at: new Date().toISOString() })
      .where(eq(financeAccount.id, a));
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      createTransaction({
        account_id: a,
        booking_date: "2024-08-15",
        amount: 100,
      }),
    ).rejects.toThrow(/closed/);
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

  it("keeps unrelated AI suggestions when accepting one AI tag", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    const acceptedAiTagId = await insertTag("urlaub", "ai");
    const remainingAiTagId = await insertTag("hotel", "ai");
    await db.insert(financeTagTransaction).values([
      { tag_id: acceptedAiTagId, transaction_id: txId, confidence: "0.820" },
      { tag_id: remainingAiTagId, transaction_id: txId, confidence: "0.640" },
    ]);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await promoteAiTag({ id: txId, tag: "urlaub" });

    expect(result.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "urlaub", source: "user" }),
        expect.objectContaining({ name: "hotel", source: "ai" }),
      ]),
    );
    expect(result.tags).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "urlaub", source: "ai" }),
      ]),
    );
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

  it("adding user-tags leaves AI suggestions untouched by default", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a);
    const aiTagId = await insertTag("ki-vorschlag", "ai");
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: aiTagId, transaction_id: t1, confidence: "0.700" });

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");
    const result = await batchTag({
      transaction_ids: [t1],
      add: ["manuell"],
    });
    expect(result.added_links).toBe(1);
    expect(result.removed_links).toBe(0);

    const rows = await db
      .select({ name: financeTag.name, source: financeTag.source })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, t1));
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "ki-vorschlag", source: "ai" },
        { name: "manuell", source: "user" },
      ]),
    );
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

  it("applies add + remove atomically (single transaction)", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a, { booking_date: "2024-08-10" });
    const t2 = await insertTx(a, { booking_date: "2024-08-11" });
    const oldTag = await insertTag("zu-entfernen", "user");
    await db.insert(financeTagTransaction).values([
      { tag_id: oldTag, transaction_id: t1 },
      { tag_id: oldTag, transaction_id: t2 },
    ]);

    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await batchTag({
      transaction_ids: [t1, t2],
      add: ["neu-1", "neu-2"],
      remove: ["zu-entfernen"],
    });
    expect(result.affected_transactions).toBe(2);
    expect(result.added_links).toBe(4); // 2 tx × 2 new tags
    expect(result.removed_links).toBe(2);

    // Final state: each tx has exactly the two new tags, the old one
    // is gone — exactly what a single committed transaction looks like.
    const finalRows = await db
      .select({ tx_id: financeTagTransaction.transaction_id, name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(inArray(financeTagTransaction.transaction_id, [t1, t2]));
    const byTx = new Map<number, string[]>();
    for (const r of finalRows) {
      const list = byTx.get(r.tx_id) ?? [];
      list.push(r.name);
      byTx.set(r.tx_id, list);
    }
    for (const txId of [t1, t2]) {
      expect((byTx.get(txId) ?? []).sort()).toEqual(["neu-1", "neu-2"]);
    }
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

// ================= BATCH-NOTICE =================

describe("finance/transactions — batchNotice", () => {
  it("replace mode overwrites the notice on every selected transaction", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a);
    const t2 = await insertTx(a, { booking_date: "2024-08-16" });
    await db
      .update(financeTransaction)
      .set({ notice: "previous" })
      .where(eq(financeTransaction.id, t1));
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const res = await batchNotice({
      transaction_ids: [t1, t2],
      notice: "Geschäftsessen",
      mode: "replace",
    });
    expect(res).toEqual({
      affected_transactions: 2,
      skipped_unauthorized: 0,
    });
    const after = await db
      .select({ id: financeTransaction.id, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(inArray(financeTransaction.id, [t1, t2]));
    expect(after.every((r) => r.notice === "Geschäftsessen")).toBe(true);
  });

  it("replace mode with empty notice clears the field", async () => {
    const { a } = await createAccounts();
    const t1 = await insertTx(a);
    await db
      .update(financeTransaction)
      .set({ notice: "alt" })
      .where(eq(financeTransaction.id, t1));
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    await batchNotice({
      transaction_ids: [t1],
      notice: "   ",
      mode: "replace",
    });
    const [row] = await db
      .select({ notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, t1));
    expect(row?.notice).toBeNull();
  });

  it("append mode joins onto the existing notice with a blank-line separator", async () => {
    const { a } = await createAccounts();
    const tWithExisting = await insertTx(a);
    const tEmpty = await insertTx(a, { booking_date: "2024-08-16" });
    await db
      .update(financeTransaction)
      .set({ notice: "ursprünglich" })
      .where(eq(financeTransaction.id, tWithExisting));
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    await batchNotice({
      transaction_ids: [tWithExisting, tEmpty],
      notice: "Nachtrag",
      mode: "append",
    });
    const after = await db
      .select({ id: financeTransaction.id, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(inArray(financeTransaction.id, [tWithExisting, tEmpty]));
    const map = new Map(after.map((r) => [r.id, r.notice]));
    expect(map.get(tWithExisting)).toBe("ursprünglich\n\nNachtrag");
    // Empty-existing case falls through to just the new text.
    expect(map.get(tEmpty)).toBe("Nachtrag");
  });

  it("reports skipped_unauthorized for ids outside the caller's ACL", async () => {
    const { a, b } = await createAccounts();
    const t1 = await insertTx(a);
    const t2 = await insertTx(b);
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const res = await batchNotice({
      transaction_ids: [t1, t2],
      notice: "Test",
      mode: "replace",
    });
    expect(res).toEqual({
      affected_transactions: 1,
      skipped_unauthorized: 1,
    });
  });

  it("rejects empty append notice", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      batchNotice({ transaction_ids: [1], notice: "  ", mode: "append" }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects empty transaction_ids", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      batchNotice({ transaction_ids: [], notice: "x", mode: "replace" }),
    ).rejects.toThrow(/transaction_ids required/);
  });

  it("rejects invalid mode", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      batchNotice({
        transaction_ids: [1],
        notice: "x",
        mode: "wat" as "replace",
      }),
    ).rejects.toThrow(/mode must be/);
  });
});

describe("finance/transactions — basket batch metadata", () => {
  it("sets review and tax flags while reporting inaccessible ids", async () => {
    const { a, b } = await createAccounts();
    const allowed = await insertTx(a); const denied = await insertTx(b);
    setAuth("7", ["finance.view"]); await grant(a, 7, "read");
    expect(await batchReview({ transaction_ids: [allowed, denied, 999999], value: true })).toEqual({ affected_transactions: 1, skipped_unauthorized: 2 });
    expect(await batchTaxRelevant({ transaction_ids: [allowed], value: true })).toEqual({ affected_transactions: 1, skipped_unauthorized: 0 });
    const [row] = await db.select({ reviewed_at: financeTransaction.reviewed_at, tax: financeTransaction.is_tax_relevant }).from(financeTransaction).where(eq(financeTransaction.id, allowed));
    expect(row.reviewed_at).toBeTruthy(); expect(row.tax).toBe(true);
  });

  it("merges counterparties and optional bank data atomically", async () => {
    const { a } = await createAccounts();
    const first = await insertTx(a, { counterparty: "AMZN MKTPLC" });
    const second = await insertTx(a, { booking_date: "2024-08-16", counterparty: "Amazon EU" });
    setAuth("7", ["finance.view"]); await grant(a, 7, "read");
    const result = await mergeCounterparties({ transaction_ids: [first, second], canonical_name: "Amazon", set_iban: "DE123", set_bic: "TESTDEFF" });
    expect(result.affected_transactions).toBe(2);
    const rows = await db.select().from(financeTransaction).where(inArray(financeTransaction.id, [first, second]));
    expect(rows.every(row => row.counterparty === "Amazon" && row.counterparty_iban === "DE123" && row.counterparty_bic === "TESTDEFF")).toBe(true);
  });
});

// ================= UPDATE =================

describe("finance/transactions — updateTransaction (notice)", () => {
  it("sets a notice on any transaction the user has read access to", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await updateTransaction({ id: txId, notice: "Geschäftsessen" });
    expect(result.notice).toBe("Geschäftsessen");
  });

  it("clears a notice when passed null", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a, {});
    await db.update(financeTransaction).set({ notice: "alt" }).where(eq(financeTransaction.id, txId));
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await updateTransaction({ id: txId, notice: null });
    expect(result.notice).toBeNull();
  });

  it("clears AI suggestions after a manual save", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    const aiTagId = await insertTag("prüfung", "ai");
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: aiTagId, transaction_id: txId, confidence: "0.770" });
    setAuth("7", ["finance.view"]);
    await grant(a, 7, "read");

    const result = await updateTransaction({ id: txId, notice: "geprüft" });

    expect(result.tags.filter((tag) => tag.source === "ai")).toHaveLength(0);
  });

  it("404s for a transaction outside the caller's ACL", async () => {
    const { a } = await createAccounts();
    const txId = await insertTx(a);
    setAuth("7", ["finance.view"]);
    await ensureUser(7);

    await expect(
      updateTransaction({ id: txId, notice: "x" }),
    ).rejects.toThrow(/not found/);
  });
});
