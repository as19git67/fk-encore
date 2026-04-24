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
import { aggregate, query } from "./analysis";
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
    expect(result.byMonth).toHaveLength(1);
    expect(result.byMonth[0]).toMatchObject({
      month: "2024-08",
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
