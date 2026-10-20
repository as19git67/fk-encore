/**
 * Sums with subtotals by tag or period: the arithmetic, the endpoint over a
 * filter and over a rule Sammelmappe that keeps its grouping. Synthetic
 * bookings only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documentCollections,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTag,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";
import { computeTotals, NO_TAG, OTHER_TAGS, type TotalsBooking } from "./transaction-totals";
import { transactionTotals } from "./transaction-totals-api";
import { createRuleCollection, setCollectionRule } from "../collections/collections";

const USER = 991700;
const OTHER = 991701;
const TAGS = ["Handwerk-1700", "Garten-1700"];

function b(id: number, date: string, amount: string, tags: string[] = [], currency = "EUR"): TotalsBooking {
  return { id, booking_date: date, amount, currency_code: currency, tags };
}

describe("computeTotals", () => {
  const bookings = [
    b(1, "2026-01-15", "-100.10", ["Handwerk"]),
    b(2, "2026-02-03", "-50.00", ["Garten"]),
    b(3, "2026-02-20", "-0.20", ["Handwerk", "Garten"]),
    b(4, "2026-04-01", "200.00"),
    b(5, "2026-04-02", "-9.99", [], "USD"),
  ];

  it("sums in cents and keeps other currencies out of the total", () => {
    const t = computeTotals(bookings, { group_by: "none" });
    expect(t.currency).toBe("EUR");
    expect(t.count).toBe(4);
    expect(t.total).toBe(4970);
    expect(t.groups).toEqual([]);
    expect(t.other_currencies).toEqual([{ currency: "USD", count: 1, total: -999 }]);
    expect(t.first_date).toBe("2026-01-15");
    expect(t.last_date).toBe("2026-04-01");
  });

  it("groups by month, quarter and year in date order", () => {
    expect(computeTotals(bookings, { group_by: "month" }).groups).toEqual([
      { key: "2026-01", label: "Januar 2026", count: 1, sum: -10010 },
      { key: "2026-02", label: "Februar 2026", count: 2, sum: -5020 },
      { key: "2026-04", label: "April 2026", count: 1, sum: 20000 },
    ]);
    expect(computeTotals(bookings, { group_by: "quarter" }).groups.map((g) => [g.label, g.sum])).toEqual([
      ["Q1 2026", -15030],
      ["Q2 2026", 20000],
    ]);
    expect(computeTotals(bookings, { group_by: "year" }).groups).toEqual([
      { key: "2026", label: "2026", count: 4, sum: 4970 },
    ]);
  });

  it("groups by tag, counts a booking in each of its tags and says so", () => {
    const t = computeTotals(bookings, { group_by: "tag" });
    expect(t.groups.map((g) => [g.label, g.count, g.sum])).toEqual([
      ["Handwerk", 2, -10030],
      ["Garten", 2, -5020],
      [NO_TAG, 1, 20000],
    ]);
    expect(t.overlapping).toBe(true);
    expect(t.total).toBe(4970);
  });

  it("limits tag groups to the named tags, the rest under Sonstige", () => {
    const t = computeTotals(bookings, { group_by: "tag", tags: ["Handwerk"] });
    expect(t.groups.map((g) => [g.label, g.count, g.sum])).toEqual([
      ["Handwerk", 2, -10030],
      [OTHER_TAGS, 1, -5000],
      [NO_TAG, 1, 20000],
    ]);
    expect(t.overlapping).toBe(false);
  });
});

function setAuth(userID: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions: ["module.finance", "finance.view"] } as never);
}

async function ensureUser(id: number) {
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`);
}

async function account(label: string): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [row] = await db.insert(financeAccount)
    .values({ type_id: type.id, currency_code: "EUR", account_number: `AN-${label}`, label })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function booking(accountId: number, date: string, amount: string, counterparty: string, tags: string[] = []): Promise<number> {
  const [row] = await db.insert(financeTransaction)
    .values({ account_id: accountId, booking_date: `${date}T00:00:00`, amount, currency_code: "EUR", counterparty, purpose: "Rechnung", dedupe_hash: `test-1700-${accountId}-${date}-${amount}` })
    .returning({ id: financeTransaction.id });
  for (const name of tags) {
    const [t] = await db.insert(financeTag).values({ name, source: "user" })
      .onConflictDoUpdate({ target: [financeTag.name, financeTag.source], set: { name } })
      .returning({ id: financeTag.id });
    await db.insert(financeTagTransaction).values({ tag_id: t.id, transaction_id: row.id });
  }
  return row.id;
}

describe("transaction totals endpoint", () => {
  beforeEach(async () => {
    await ensureUser(USER);
    await ensureUser(OTHER);
    await db.delete(documentCollections).where(inArray(documentCollections.user_id, [USER, OTHER]));
    const accounts = await db.select({ id: financeAccount.id }).from(financeAccount).where(inArray(financeAccount.label, ["Giro 1700", "Fremd 1700"]));
    const ids = accounts.map((a) => a.id);
    if (ids.length) {
      await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, ids));
      await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, ids));
      await db.delete(financeAccount).where(inArray(financeAccount.id, ids));
    }
    for (const name of TAGS) await db.delete(financeTag).where(eq(financeTag.name, name));

    const mine = await account("Giro 1700");
    const foreign = await account("Fremd 1700");
    await db.insert(financeAccountAccess).values({ account_id: mine, user_id: USER, level: "read" });
    await db.insert(financeAccountAccess).values({ account_id: foreign, user_id: OTHER, level: "read" });
    await booking(mine, "2026-03-02", "-120.50", "Musterfirma Haustechnik", [TAGS[0]]);
    await booking(mine, "2026-05-10", "-80.00", "Musterfirma Haustechnik", [TAGS[0], TAGS[1]]);
    await booking(mine, "2026-05-11", "-15.00", "Beispiel Gartenmarkt", [TAGS[1]]);
    await booking(foreign, "2026-05-12", "-999.00", "Musterfirma Haustechnik", [TAGS[0]]);
    setAuth(USER);
  });

  it("sums only readable bookings matching the list's search", async () => {
    const t = await transactionTotals({ criteria: { text: "Musterfirma" }, group_by: "quarter" });
    expect(t.count).toBe(2);
    expect(t.total).toBe(-20050);
    expect(t.groups.map((g) => [g.label, g.sum])).toEqual([["Q1 2026", -12050], ["Q2 2026", -8000]]);
  });

  it("refuses a request that names no bookings", async () => {
    await expect(transactionTotals({ group_by: "tag" })).rejects.toThrow(/criteria or collection_id/);
  });

  it("sums a rule Sammelmappe by tag and keeps its grouping when the filter changes", async () => {
    const created = await createRuleCollection({
      name: "Haus 2026",
      rule: { type: "transaction", criteria: { from: "2026-01-01", to: "2026-12-31", direction: "out" }, totals: { group_by: "tag", tags: [TAGS[0]] } },
    });
    expect(created.collection.total).toBe(3);
    expect(created.collection.rule).toMatchObject({ type: "transaction", totals: { group_by: "tag", tags: [TAGS[0]] } });

    const t = await transactionTotals({ collection_id: created.collection.id, group_by: "tag", group_tags: [TAGS[0]] });
    expect(t.total).toBe(-21550);
    expect(t.groups.map((g) => [g.label, g.count, g.sum])).toEqual([[TAGS[0], 2, -20050], [OTHER_TAGS, 1, -1500]]);

    const changed = await setCollectionRule({ id: created.collection.id, rule: { type: "transaction", criteria: { text: "Gartenmarkt" } } });
    expect(changed.collection.rule).toMatchObject({ totals: { group_by: "tag", tags: [TAGS[0]] } });

    // Someone else's private folder sums to nothing.
    setAuth(OTHER);
    const foreign = await transactionTotals({ collection_id: created.collection.id });
    expect(foreign.count).toBe(0);
  });
});
