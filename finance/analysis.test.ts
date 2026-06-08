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
import { aggregate, query, transactions, periodTransactions } from "./analysis";
import * as llmClient from "./llm-client";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

vi.mock("./llm-client", async (orig) => {
  const actual = await orig<typeof import("./llm-client")>();
  return {
    ...actual,
    parseAnalysisQuery: vi.fn(),
  };
});

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
  __resetRateLimiterForTests();
  setAuth("1", []);
  vi.mocked(llmClient.parseAnalysisQuery).mockReset();
});

// ----------------------------------------------------------------------
// Fixture: two accounts, six transactions covering a small tag space.
//
// Italien-Urlaub: two transactions in Aug 2024 tagged [urlaub, italien-2024]
// Alltag: two transactions tagged [alltag]
// Gehalt: one transaction tagged [gehalt]
// Irrelevant: one transaction without tags (baseline for OR / AND tests)
// ----------------------------------------------------------------------

async function seedFixture(): Promise<{ accountAId: number; accountBId: number }> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [accA] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "A",
      label: "Giro A",
    })
    .returning({ id: financeAccount.id });
  const [accB] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "B",
      label: "Giro B",
    })
    .returning({ id: financeAccount.id });

  // Tags
  const [urlaub] = await db
    .insert(financeTag)
    .values({ name: "urlaub", source: "user" })
    .returning({ id: financeTag.id });
  const [italien] = await db
    .insert(financeTag)
    .values({ name: "italien-2024", source: "user" })
    .returning({ id: financeTag.id });
  const [alltag] = await db
    .insert(financeTag)
    .values({ name: "alltag", source: "user" })
    .returning({ id: financeTag.id });
  const [gehalt] = await db
    .insert(financeTag)
    .values({ name: "gehalt", source: "user" })
    .returning({ id: financeTag.id });

  async function tx(
    accountId: number,
    bookingDate: string,
    amount: string,
    purpose: string,
    counterparty: string,
    tagIds: number[],
  ) {
    const [t] = await db
      .insert(financeTransaction)
      .values({
        account_id: accountId,
        booking_date: bookingDate,
        amount,
        currency_code: "EUR",
        purpose,
        counterparty,
        dedupe_hash: `h-${Math.random()}-${Date.now()}`,
      })
      .returning({ id: financeTransaction.id });
    for (const tagId of tagIds) {
      await db
        .insert(financeTagTransaction)
        .values({ tag_id: tagId, transaction_id: t.id });
    }
  }

  await tx(accA.id, "2024-08-10", "-340.00", "Hotel Firenze", "Hotel Firenze", [urlaub.id, italien.id]);
  await tx(accA.id, "2024-08-12", "-89.50", "Trenitalia", "Trenitalia", [urlaub.id, italien.id]);
  await tx(accA.id, "2024-09-05", "-47.30", "Supermarkt", "REWE", [alltag.id]);
  await tx(accA.id, "2024-09-20", "-52.20", "Supermarkt", "REWE", [alltag.id]);
  await tx(accB.id, "2024-08-15", "3800.00", "Gehalt August", "AG GmbH", [gehalt.id]);
  await tx(accA.id, "2024-07-01", "-12.00", "Irrelevant", "Irgendwer", []);

  return { accountAId: accA.id, accountBId: accB.id };
}

async function grantAdmin() {
  setAuth("1", ["finance.view", "finance.admin"]);
}

// ======================================================================
// /aggregate
// ======================================================================

describe("finance/analysis — aggregate (AND semantics)", () => {
  it("sums two tags with AND, ignoring rows that carry only one of them", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: ["urlaub", "italien-2024"],
        op: "AND",
      },
    });

    expect(result.total.count).toBe(2);
    // -340 + -89.50 = -429.50
    expect(Number(result.total.sum)).toBeCloseTo(-429.5, 2);
    expect(result.byPeriod).toHaveLength(1);
    expect(result.byPeriod[0]).toMatchObject({
      period: "2024-08",
      count: 2,
    });
  });
});

describe("finance/analysis — aggregate (OR semantics)", () => {
  it("unions transactions tagged with any of the listed tags", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: ["alltag", "gehalt"], op: "OR" },
    });

    // 2 alltag + 1 gehalt
    expect(result.total.count).toBe(3);
  });
});

describe("finance/analysis — aggregate (timespan)", () => {
  it("restricts to bookings inside the [from, to] window inclusive", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        timespan: { from: "2024-08-01", to: "2024-08-31" },
      },
    });

    // All 2024-08 entries: 2x italien + 1x gehalt = 3
    expect(result.total.count).toBe(3);
  });
});

describe("finance/analysis — aggregate (amountRange)", () => {
  it("filters by amount bounds (signed)", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        amountRange: { min: 0 },
      },
    });

    // Only the positive entry (gehalt)
    expect(result.total.count).toBe(1);
    expect(Number(result.total.sum)).toBeCloseTo(3800, 2);
  });
});

describe("finance/analysis — aggregate (top counterparties)", () => {
  it("orders top counterparties by ABS(sum) desc", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
    });

    // |gehalt 3800| > |hotel 340| > |trenitalia 89.5| > …
    expect(result.topCounterparties[0].name).toBe("AG GmbH");
    expect(Number(result.topCounterparties[0].sum)).toBeCloseTo(3800, 2);
  });
});

describe("finance/analysis — aggregate (byTag breakdown)", () => {
  it("breaks the unfiltered set down by every user tag, ordered by ABS(sum) desc", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
    });

    const byName = Object.fromEntries(result.byTag.map((r) => [r.tag, r]));
    // urlaub & italien-2024 each on the two Aug rows: -340 + -89.50
    expect(byName["urlaub"]).toMatchObject({ count: 2 });
    expect(Number(byName["urlaub"].sum)).toBeCloseTo(-429.5, 2);
    expect(byName["italien-2024"]).toMatchObject({ count: 2 });
    expect(Number(byName["italien-2024"].sum)).toBeCloseTo(-429.5, 2);
    expect(byName["alltag"]).toMatchObject({ count: 2 });
    expect(Number(byName["alltag"].sum)).toBeCloseTo(-99.5, 2);
    expect(byName["gehalt"]).toMatchObject({ count: 1 });
    expect(Number(byName["gehalt"].sum)).toBeCloseTo(3800, 2);

    // |gehalt 3800| is the largest, so it leads.
    expect(result.byTag[0].tag).toBe("gehalt");
  });

  it("excludes the filter tags from the breakdown but surfaces co-occurring tags", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: ["urlaub"], op: "AND" },
    });

    const names = result.byTag.map((r) => r.tag);
    expect(names).not.toContain("urlaub");
    // The two urlaub rows also carry italien-2024 → it shows through.
    expect(names).toContain("italien-2024");
    const italien = result.byTag.find((r) => r.tag === "italien-2024")!;
    expect(italien.count).toBe(2);
    expect(Number(italien.sum)).toBeCloseTo(-429.5, 2);
  });
});

describe("finance/analysis — aggregate (kind round-trip)", () => {
  it("echoes a valid kind back in the result AST", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: ["urlaub"], op: "AND", kind: "event" },
    });
    expect(result.ast.kind).toBe("event");
  });

  it("drops an invalid kind instead of forwarding it", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND", kind: "nonsense" as any },
    });
    expect(result.ast.kind).toBeUndefined();
  });
});

describe("finance/analysis — transactions (tag drill-down)", () => {
  it("lists the transactions carrying a tag within the filter, newest first", async () => {
    await seedFixture();
    await grantAdmin();

    const { transactions: rows } = await transactions({
      ast: { tags: [], op: "AND" },
      tag: "urlaub",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].counterparty).toBe("Trenitalia");
    expect(rows[0].bookingDate).toBe("2024-08-12");
    expect(rows[1].counterparty).toBe("Hotel Firenze");
    expect(Number(rows[1].amount)).toBeCloseTo(-340, 2);
  });

  it("honours the surrounding AST filter (timespan)", async () => {
    await seedFixture();
    await grantAdmin();

    const { transactions: rows } = await transactions({
      ast: { tags: [], op: "AND", timespan: { from: "2024-08-11", to: "2024-08-31" } },
      tag: "urlaub",
    });

    // Only Trenitalia (08-12) falls inside the window; Hotel (08-10) drops out.
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty).toBe("Trenitalia");
  });

  it("scopes to accessible accounts for non-admins", async () => {
    const { accountAId } = await seedFixture();
    await ensureUser(7);
    await db.insert(financeAccountAccess).values({
      account_id: accountAId,
      user_id: 7,
      level: "read",
    });
    setAuth("7", ["finance.view"]);

    // gehalt lives on account B, which user 7 cannot read.
    const { transactions: rows } = await transactions({
      ast: { tags: [], op: "AND" },
      tag: "gehalt",
    });
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty tag", async () => {
    await grantAdmin();
    await expect(
      transactions({ ast: { tags: [], op: "AND" }, tag: "  " }),
    ).rejects.toThrow(/tag/);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(
      transactions({ ast: { tags: [], op: "AND" }, tag: "urlaub" }),
    ).rejects.toThrow(/permission/);
  });
});

describe("finance/analysis — aggregate (ACL)", () => {
  it("non-admin sees only transactions on accessible accounts", async () => {
    const { accountAId } = await seedFixture();
    // User 7 gets read access on account A only (5 transactions)
    await ensureUser(7);
    await db.insert(financeAccountAccess).values({
      account_id: accountAId,
      user_id: 7,
      level: "read",
    });
    setAuth("7", ["finance.view"]);

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
    });
    // Without account B gehalt row, count = 5
    expect(result.total.count).toBe(5);
  });

  it("non-admin with no ACL gets empty aggregate", async () => {
    await seedFixture();
    setAuth("99", ["finance.view"]);
    await ensureUser(99);

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
    });
    expect(result.total.count).toBe(0);
    expect(Number(result.total.sum)).toBe(0);
  });
});

describe("finance/analysis — aggregate (accountIds restriction)", () => {
  it("intersects the caller-supplied accountIds with the ACL scope", async () => {
    const { accountAId, accountBId } = await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
      accountIds: [accountBId],
    });
    // Only account B = 1 row (gehalt)
    expect(result.total.count).toBe(1);
    void accountAId;
  });
});

describe("finance/analysis — aggregate (permission)", () => {
  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(
      aggregate({ ast: { tags: [], op: "AND" } }),
    ).rejects.toThrow(/permission/);
  });

  it("rejects a bad AST", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(
      aggregate({ ast: "nope" as any }),
    ).rejects.toThrow(/ast/);
  });
});

// ======================================================================
// /query
// ======================================================================

describe("finance/analysis — query (LLM parse + aggregate)", () => {
  it("passes the available user-tag vocabulary to the LLM and aggregates the result", async () => {
    await seedFixture();
    await grantAdmin();

    vi.mocked(llmClient.parseAnalysisQuery).mockResolvedValue({
      tags: ["urlaub", "italien-2024"],
      op: "AND",
      timespan: { from: "2024-08-01", to: "2024-08-31" },
    });

    const result = await query({
      question: "Was habe ich im Italien-Urlaub 2024 ausgegeben?",
    });

    expect(llmClient.parseAnalysisQuery).toHaveBeenCalledOnce();
    const [, availableTags] = vi.mocked(llmClient.parseAnalysisQuery).mock.calls[0];
    expect(availableTags).toContain("urlaub");
    expect(availableTags).toContain("italien-2024");
    expect(availableTags).toContain("alltag");
    expect(availableTags).toContain("gehalt");

    expect(result.ast.tags).toEqual(["urlaub", "italien-2024"]);
    expect(result.total.count).toBe(2);
  });

  it("forwards the AI-detected event/ongoing kind into the result", async () => {
    await seedFixture();
    await grantAdmin();

    vi.mocked(llmClient.parseAnalysisQuery).mockResolvedValue({
      tags: ["urlaub", "italien-2024"],
      op: "AND",
      kind: "event",
    });

    const result = await query({ question: "Was hat der Italien-Urlaub gekostet?" });
    expect(result.ast.kind).toBe("event");
  });

  it("returns 503 when llm-service is unavailable", async () => {
    await grantAdmin();
    vi.mocked(llmClient.parseAnalysisQuery).mockRejectedValue(
      new llmClient.LlmServiceUnavailableError("timeout"),
    );
    await expect(
      query({ question: "egal" }),
    ).rejects.toThrow(/llm-service unavailable/);
  });

  it("rejects empty questions", async () => {
    await grantAdmin();
    await expect(
      query({ question: "" }),
    ).rejects.toThrow(/non-empty/);
  });
});

// ======================================================================
// /aggregate — interval (yearly grouping)
// ======================================================================

describe("finance/analysis — aggregate (interval)", () => {
  it("groups by year when interval is 'year'", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND", interval: "year" },
    });

    expect(result.byPeriod.length).toBeGreaterThan(0);
    expect(result.byPeriod[0].period).toMatch(/^\d{4}$/);
    expect(result.ast.interval).toBe("year");
  });

  it("groups by month by default", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND" },
    });

    expect(result.byPeriod.length).toBeGreaterThan(0);
    expect(result.byPeriod[0].period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("echoes the interval field back in the result AST", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: { tags: [], op: "AND", interval: "month" },
    });
    expect(result.ast.interval).toBe("month");
  });
});

// ======================================================================
// /aggregate — relativeTimespan
// ======================================================================

describe("finance/analysis — aggregate (relativeTimespan)", () => {
  it("resolves relativeTimespan and sets concrete timespan", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        relativeTimespan: { type: "this_year" },
      },
    });

    expect(result.ast.relativeTimespan).toEqual({ type: "this_year" });
    expect(result.ast.timespan).toBeDefined();
    expect(result.ast.timespan!.from).toMatch(/^\d{4}-01-01$/);
  });

  it("strips invalid relativeTimespan types", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        relativeTimespan: { type: "bogus" as any },
      },
    });

    expect(result.ast.relativeTimespan).toBeUndefined();
  });
});

// ======================================================================
// /period-transactions
// ======================================================================

describe("finance/analysis — periodTransactions", () => {
  it("lists the transactions within a month period", async () => {
    await seedFixture();
    await grantAdmin();

    const { transactions: rows } = await periodTransactions({
      ast: { tags: [], op: "AND" },
      period: "2024-08",
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.bookingDate.startsWith("2024-08"))).toBe(true);
  });

  it("lists the transactions within a year period", async () => {
    await seedFixture();
    await grantAdmin();

    const { transactions: rows } = await periodTransactions({
      ast: { tags: [], op: "AND", interval: "year" },
      period: "2024",
    });

    expect(rows).toHaveLength(6);
  });

  it("honours AST tag filters", async () => {
    await seedFixture();
    await grantAdmin();

    const { transactions: rows } = await periodTransactions({
      ast: { tags: ["urlaub"], op: "AND" },
      period: "2024-08",
    });

    // Only the 2 urlaub-tagged rows in Aug (Hotel + Trenitalia), not gehalt
    expect(rows).toHaveLength(2);
  });

  it("rejects an empty period", async () => {
    await grantAdmin();
    await expect(
      periodTransactions({ ast: { tags: [], op: "AND" }, period: "  " }),
    ).rejects.toThrow(/period/);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(
      periodTransactions({ ast: { tags: [], op: "AND" }, period: "2024-08" }),
    ).rejects.toThrow(/permission/);
  });

  it("scopes to accessible accounts for non-admins", async () => {
    const { accountAId } = await seedFixture();
    await ensureUser(7);
    await db.insert(financeAccountAccess).values({
      account_id: accountAId,
      user_id: 7,
      level: "read",
    });
    setAuth("7", ["finance.view"]);

    const { transactions: rows } = await periodTransactions({
      ast: { tags: [], op: "AND" },
      period: "2024-08",
    });

    // Only accA transactions in Aug: Hotel + Trenitalia = 2 (gehalt is on accB)
    expect(rows).toHaveLength(2);
  });
});

// ======================================================================
// /aggregate — tagGroups (complex tag expressions)
// ======================================================================

describe("finance/analysis — aggregate (tagGroups)", () => {
  it("supports a single group (equivalent to flat tags)", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        tagGroups: [{ tags: ["urlaub", "italien-2024"], op: "AND" }],
        groupOp: "AND",
      },
    });

    expect(result.total.count).toBe(2);
    expect(Number(result.total.sum)).toBeCloseTo(-429.5, 2);
  });

  it("supports AND between groups: Restaurant AND (urlaub OR alltag)", async () => {
    await seedFixture();
    await grantAdmin();

    // urlaub-tagged rows also carry italien-2024 — testing:
    // Group 1: [urlaub] AND  Group 2: [italien-2024]
    // → only rows carrying BOTH urlaub AND italien-2024
    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        tagGroups: [
          { tags: ["urlaub"], op: "AND" },
          { tags: ["italien-2024"], op: "AND" },
        ],
        groupOp: "AND",
      },
    });

    expect(result.total.count).toBe(2);
  });

  it("supports OR between groups", async () => {
    await seedFixture();
    await grantAdmin();

    // Group 1: [urlaub] OR Group 2: [gehalt]
    // → rows tagged urlaub (2) + rows tagged gehalt (1) = 3
    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        tagGroups: [
          { tags: ["urlaub"], op: "AND" },
          { tags: ["gehalt"], op: "AND" },
        ],
        groupOp: "OR",
      },
    });

    expect(result.total.count).toBe(3);
  });

  it("supports OR within a group and AND between groups", async () => {
    await seedFixture();
    await grantAdmin();

    // (urlaub OR alltag) → 4 rows, AND with timespan 2024-08 → 2 rows (only urlaub)
    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        tagGroups: [{ tags: ["urlaub", "alltag"], op: "OR" }],
        groupOp: "AND",
        timespan: { from: "2024-08-01", to: "2024-08-31" },
      },
    });

    expect(result.total.count).toBe(2);
  });

  it("excludes all group tags from byTag breakdown", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: [],
        op: "AND",
        tagGroups: [
          { tags: ["urlaub"], op: "AND" },
          { tags: ["italien-2024"], op: "AND" },
        ],
        groupOp: "AND",
      },
    });

    const tagNames = result.byTag.map((r) => r.tag);
    expect(tagNames).not.toContain("urlaub");
    expect(tagNames).not.toContain("italien-2024");
  });

  it("falls back to flat tags when tagGroups is empty", async () => {
    await seedFixture();
    await grantAdmin();

    const result = await aggregate({
      ast: {
        tags: ["urlaub"],
        op: "AND",
        tagGroups: [],
        groupOp: "AND",
      },
    });

    expect(result.total.count).toBe(2);
  });
});
