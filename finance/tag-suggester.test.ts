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
import * as llmClient from "./llm-client";
import {
  suggestTagsBatch,
  suggestTagsForTransaction,
} from "./tag-suggester";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

vi.mock("./llm-client", async (orig) => {
  const actual = await orig<typeof import("./llm-client")>();
  return {
    ...actual,
    embed: vi.fn(),
    suggestTags: vi.fn(),
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
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  __resetRateLimiterForTests();
  setAuth("1", []);
  vi.mocked(llmClient.embed).mockReset();
  vi.mocked(llmClient.suggestTags).mockReset();
});

async function createAccount(): Promise<number> {
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
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  return a.id;
}

async function insertTx(
  accountId: number,
  overrides: Partial<typeof financeTransaction.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2024-08-15",
      amount: "42.00",
      currency_code: "EUR",
      dedupe_hash: `h-${Math.random()}`,
      purpose: "Kaffee",
      counterparty: "Bistro",
      ...overrides,
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

async function insertTag(
  name: string,
  source: "user" | "ai",
): Promise<number> {
  const [row] = await db
    .insert(financeTag)
    .values({ name, source })
    .returning({ id: financeTag.id });
  return row.id;
}

/**
 * Seeds one historical transaction with a pre-computed embedding and
 * the supplied user tags so that loadNeighbours has something to work
 * with. Returns the transaction id.
 */
async function seedNeighbour(
  accountId: number,
  vector: number[],
  userTags: string[],
  overrides: Partial<typeof financeTransaction.$inferInsert> = {},
): Promise<number> {
  const txId = await insertTx(accountId, overrides);
  const literal = `[${vector.join(",")}]`;
  await db.execute(
    sql`INSERT INTO finance_transaction_embedding (transaction_id, embedding) VALUES (${txId}, ${literal}::vector)`,
  );
  for (const name of userTags) {
    let [tag] = await db
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(eq(financeTag.name, name))
      .limit(1);
    if (!tag) tag = { id: await insertTag(name, "user") };
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: tag.id, transaction_id: txId });
  }
  return txId;
}

function vec(fill: number, length = 768): number[] {
  return Array.from({ length }, () => fill);
}

// ================= Pipeline =================

describe("tag-suggester — happy path", () => {
  it("accepts vocabulary tags, writes AI-source tag join with confidence", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.1), ["urlaub", "italien-2024"]);
    const newTx = await insertTx(acc, { purpose: "Hotel Firenze" });

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.1));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "urlaub", confidence: 0.82 },
      { tag: "italien-2024", confidence: 0.67 },
    ]);

    const ok = await suggestTagsForTransaction(newTx);
    expect(ok).toBe(true);

    const joins = await db
      .select({
        name: financeTag.name,
        source: financeTag.source,
        confidence: financeTagTransaction.confidence,
      })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, newTx));
    const aiJoins = joins.filter((j) => j.source === "ai");
    expect(aiJoins).toHaveLength(2);
    expect(aiJoins.map((j) => j.name).sort()).toEqual([
      "italien-2024",
      "urlaub",
    ]);
    expect(aiJoins.every((j) => j.confidence !== null)).toBe(true);
  });

  it("persists a row in finance_transaction_embedding", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);
    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.3));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([]);

    await suggestTagsForTransaction(tx);

    const rows = (await db.execute(
      sql`SELECT transaction_id FROM finance_transaction_embedding WHERE transaction_id = ${tx}`,
    )) as any;
    const arr = Array.isArray(rows) ? rows : rows.rows;
    expect(arr).toHaveLength(1);
  });

  it("picks nearest neighbours (closer vectors win over further ones)", async () => {
    const acc = await createAccount();
    // Close neighbour with tag 'miete'
    await seedNeighbour(acc, vec(0.4), ["miete"]);
    // Far neighbour with tag 'gehalt'
    await seedNeighbour(acc, vec(-1.0), ["gehalt"]);
    const tx = await insertTx(acc);
    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.41));

    let capturedTags: string[] = [];
    vi.mocked(llmClient.suggestTags).mockImplementation(async (input) => {
      capturedTags = input.examples.flatMap((e) => e.user_tags);
      return [];
    });

    await suggestTagsForTransaction(tx);
    // First neighbour in the list should be the closer one
    expect(capturedTags[0]).toBe("miete");
  });
});

describe("tag-suggester — filters and caps", () => {
  it("drops tags not present in the example set (vocabulary filter)", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["miete"]);
    const tx = await insertTx(acc);

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "erfunden", confidence: 0.9 },
      { tag: "miete", confidence: 0.7 },
    ]);

    await suggestTagsForTransaction(tx);
    const joins = await db
      .select({ name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, tx));
    expect(joins.map((j) => j.name)).toEqual(["miete"]);
  });

  it("drops suggestions below MIN_CONFIDENCE (0.3)", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["a", "b"]);
    const tx = await insertTx(acc);

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "a", confidence: 0.25 },
      { tag: "b", confidence: 0.8 },
    ]);

    await suggestTagsForTransaction(tx);
    const joins = await db
      .select({ name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, tx));
    expect(joins.map((j) => j.name)).toEqual(["b"]);
  });

  it("caps at 5 suggestions per transaction (highest confidence wins)", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["a", "b", "c", "d", "e", "f", "g"]);
    const tx = await insertTx(acc);

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "a", confidence: 0.50 },
      { tag: "b", confidence: 0.95 },
      { tag: "c", confidence: 0.90 },
      { tag: "d", confidence: 0.85 },
      { tag: "e", confidence: 0.80 },
      { tag: "f", confidence: 0.75 },
      { tag: "g", confidence: 0.70 },
    ]);

    await suggestTagsForTransaction(tx);
    const joins = await db
      .select({ name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, tx));
    expect(joins).toHaveLength(5);
    // highest-confidence ones should survive
    expect(joins.map((j) => j.name).sort()).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("does not overwrite an existing user-tag with an AI suggestion of the same name", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["miete"]);
    const tx = await insertTx(acc);
    // The 'miete' user tag was already inserted by seedNeighbour;
    // just look it up rather than creating a duplicate.
    const [userTag] = await db
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(eq(financeTag.name, "miete"))
      .limit(1);
    await db
      .insert(financeTagTransaction)
      .values({ tag_id: userTag.id, transaction_id: tx });

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "miete", confidence: 0.95 },
    ]);

    await suggestTagsForTransaction(tx);
    const aiJoins = await db
      .select({ source: financeTag.source })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(eq(financeTagTransaction.transaction_id, tx));
    expect(aiJoins.filter((j) => j.source === "ai")).toHaveLength(0);
  });
});

describe("tag-suggester — LlmServiceUnavailableError propagates for worker retry", () => {
  it("re-throws LlmServiceUnavailableError when embed fails (worker will defer)", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);
    vi.mocked(llmClient.embed).mockRejectedValue(
      new llmClient.LlmServiceUnavailableError("boom"),
    );

    await expect(suggestTagsForTransaction(tx)).rejects.toBeInstanceOf(
      llmClient.LlmServiceUnavailableError,
    );
  });

  it("re-throws LlmServiceUnavailableError when suggestTags fails, embedding row is preserved", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["a"]);
    const tx = await insertTx(acc);
    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockRejectedValue(
      new llmClient.LlmServiceUnavailableError("down"),
    );

    await expect(suggestTagsForTransaction(tx)).rejects.toBeInstanceOf(
      llmClient.LlmServiceUnavailableError,
    );
    // Embedding row is still there — can be reused on next try
    const rows = (await db.execute(
      sql`SELECT transaction_id FROM finance_transaction_embedding WHERE transaction_id = ${tx}`,
    )) as any;
    expect((Array.isArray(rows) ? rows : rows.rows).length).toBe(1);
  });

  it("returns true (not false) when there are no neighbours yet", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);
    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "x", confidence: 0.9 },
    ]);

    const ok = await suggestTagsForTransaction(tx);
    expect(ok).toBe(true);
    // suggestTags shouldn't have been called at all — no examples → skip
    expect(llmClient.suggestTags).not.toHaveBeenCalled();
  });
});

// ================= Batch endpoint =================

describe("tag-suggester — suggestTagsBatch endpoint", () => {
  it("processes ACL-accessible transactions and reports counters", async () => {
    const acc = await createAccount();
    await seedNeighbour(acc, vec(0.2), ["miete"]);
    const t1 = await insertTx(acc);
    const t2 = await insertTx(acc, { booking_date: "2024-09-01" });

    setAuth("7", ["finance.view"]);
    await ensureUser(7);
    await db.insert(financeAccountAccess).values({
      account_id: acc,
      user_id: 7,
      level: "read",
    });

    vi.mocked(llmClient.embed).mockResolvedValue(vec(0.2));
    vi.mocked(llmClient.suggestTags).mockResolvedValue([
      { tag: "miete", confidence: 0.9 },
    ]);

    const result = await suggestTagsBatch({});
    // t1 and t2 both processed (the seed is also included in count)
    expect(result.attempted).toBeGreaterThanOrEqual(2);
    expect(result.succeeded).toBeGreaterThanOrEqual(2);
    void t1;
    void t2;
  });

  it("returns empty when user has no ACL entries", async () => {
    const acc = await createAccount();
    await insertTx(acc);
    setAuth("99", ["finance.view"]);
    await ensureUser(99);

    const result = await suggestTagsBatch({});
    expect(result).toEqual({ attempted: 0, succeeded: 0 });
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(suggestTagsBatch({})).rejects.toThrow(/permission/);
  });
});
