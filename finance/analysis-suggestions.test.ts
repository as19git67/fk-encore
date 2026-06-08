import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  users,
  financeSavedAnalysis,
  financeTag,
  financeAccountAccess,
  financeAccount,
  financeAccountType,
  financeTransaction,
  financeTagTransaction,
  financeBankcontact,
} from "../db/schema";
import { _computeFingerprint } from "./analysis-suggestions";

// -----------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------

async function cleanAll(): Promise<void> {
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeSavedAnalysis);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(financeTag);
  await db.delete(users);
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`sug${id}@test.local`}, ${`SugUser${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedAccount(userId: number): Promise<number> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "TestBank", blz: "12345", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "SUG-A",
      label: "Suggestion Test",
    })
    .returning({ id: financeAccount.id });
  await db.insert(financeAccountAccess).values({
    user_id: userId,
    account_id: acc.id,
    level: "admin",
  });
  return acc.id;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("analysis-suggestions — fingerprint", () => {
  it("produces deterministic hashes", () => {
    const ast = { tags: ["a", "b"], op: "AND" as const };
    const fp1 = _computeFingerprint(ast);
    const fp2 = _computeFingerprint(ast);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(32);
  });

  it("ignores tag order", () => {
    const fp1 = _computeFingerprint({ tags: ["b", "a"], op: "AND" as const });
    const fp2 = _computeFingerprint({ tags: ["a", "b"], op: "AND" as const });
    expect(fp1).toBe(fp2);
  });

  it("differs by op", () => {
    const fp1 = _computeFingerprint({ tags: ["a"], op: "AND" as const });
    const fp2 = _computeFingerprint({ tags: ["a"], op: "OR" as const });
    expect(fp1).not.toBe(fp2);
  });

  it("differs by kind", () => {
    const fp1 = _computeFingerprint({ tags: ["a"], op: "AND" as const, kind: "event" });
    const fp2 = _computeFingerprint({ tags: ["a"], op: "AND" as const, kind: "ongoing" });
    expect(fp1).not.toBe(fp2);
  });

  it("uses relativeTimespan over timespan when present", () => {
    const ast1 = {
      tags: ["a"],
      op: "AND" as const,
      relativeTimespan: { type: "this_year" as const },
      timespan: { from: "2026-01-01", to: "2026-12-31" },
    };
    const ast2 = {
      tags: ["a"],
      op: "AND" as const,
      relativeTimespan: { type: "this_year" as const },
      timespan: { from: "2025-01-01", to: "2025-12-31" },
    };
    expect(_computeFingerprint(ast1)).toBe(_computeFingerprint(ast2));
  });
});

describe("analysis-suggestions — DB integration", () => {
  beforeEach(async () => {
    await cleanAll();
    await ensureUser(100);
  });

  it("fingerprint unique index prevents duplicates", async () => {
    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, ast, source, fingerprint)
      VALUES (100, 'Test', '{"tags":["a"],"op":"AND"}'::jsonb, 'ai', 'fp-dup-test')
    `);

    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, ast, source, fingerprint)
      VALUES (100, 'Updated', '{"tags":["a"],"op":"AND"}'::jsonb, 'ai', 'fp-dup-test')
      ON CONFLICT (user_id, fingerprint) WHERE fingerprint IS NOT NULL
      DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    `);

    const rows = (
      await db.execute(
        sql`SELECT name FROM finance_saved_analysis WHERE user_id = 100 AND fingerprint = 'fp-dup-test'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe("Updated");
  });

  it("preserves seen_at on upsert", async () => {
    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, ast, source, fingerprint, seen_at)
      VALUES (100, 'Seen', '{"tags":[],"op":"AND"}'::jsonb, 'ai', 'fp-seen-test', NOW())
    `);

    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, ast, source, fingerprint)
      VALUES (100, 'Refreshed', '{"tags":[],"op":"AND"}'::jsonb, 'ai', 'fp-seen-test')
      ON CONFLICT (user_id, fingerprint) WHERE fingerprint IS NOT NULL
      DO UPDATE SET name = EXCLUDED.name, summary = EXCLUDED.summary, updated_at = NOW()
    `);

    const rows = (
      await db.execute(
        sql`SELECT name, seen_at FROM finance_saved_analysis WHERE user_id = 100 AND fingerprint = 'fp-seen-test'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe("Refreshed");
    expect((rows[0] as any).seen_at).not.toBeNull();
  });

  it("different users can have same fingerprint", async () => {
    await ensureUser(101);
    await db.execute(sql`
      INSERT INTO finance_saved_analysis
        (user_id, name, ast, source, fingerprint)
      VALUES
        (100, 'A', '{"tags":[],"op":"AND"}'::jsonb, 'ai', 'fp-multi'),
        (101, 'B', '{"tags":[],"op":"AND"}'::jsonb, 'ai', 'fp-multi')
    `);

    const rows = (
      await db.execute(
        sql`SELECT user_id FROM finance_saved_analysis WHERE fingerprint = 'fp-multi' ORDER BY user_id`,
      )
    ).rows;
    expect(rows).toHaveLength(2);
  });
});

describe("analysis-suggestions — LLM prompt", () => {
  it("generateAnalysisSuggestions validates LLM response shape", async () => {
    const { generateAnalysisSuggestions } = await import("./llm-client");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [
          {
            name: "Lebensmittel dieses Jahr",
            question: "Wie viel gebe ich für Lebensmittel aus?",
            ast: {
              tags: ["Lebensmittel"],
              op: "AND",
              kind: "ongoing",
              interval: "month",
              relativeTimespan: { type: "this_year" },
            },
          },
          { name: "Invalid", question: "Q" },
          { name: "No Tags", question: "Q", ast: { tags: ["nonexistent"], op: "AND" } },
        ],
      }),
    });

    try {
      const results = await generateAnalysisSuggestions({
        availableTags: ["Lebensmittel", "Transport"],
        tagSummary: [],
        topCounterparties: [],
        existingNames: [],
        dataRange: { from: "2025-01-01", to: "2026-06-08" },
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Lebensmittel dieses Jahr");
      expect(results[0].ast.tags).toEqual(["Lebensmittel"]);
      expect(results[0].ast.relativeTimespan).toEqual({ type: "this_year" });
      expect(results[0].ast.timespan).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns empty array on LLM failure", async () => {
    const { generateAnalysisSuggestions } = await import("./llm-client");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    try {
      const results = await generateAnalysisSuggestions({
        availableTags: ["a"],
        tagSummary: [],
        topCounterparties: [],
        existingNames: [],
        dataRange: { from: "2025-01-01", to: "2026-01-01" },
      });
      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("filters tags against vocabulary", async () => {
    const { generateAnalysisSuggestions } = await import("./llm-client");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [
          {
            name: "Mixed",
            question: "Q",
            ast: {
              tags: ["valid", "invalid", "valid2"],
              op: "OR",
              kind: "ongoing",
              interval: "month",
              timespan: { from: "2026-01-01", to: "2026-12-31" },
            },
          },
        ],
      }),
    });

    try {
      const results = await generateAnalysisSuggestions({
        availableTags: ["valid", "valid2"],
        tagSummary: [],
        topCounterparties: [],
        existingNames: [],
        dataRange: { from: "2025-01-01", to: "2026-06-08" },
      });

      expect(results).toHaveLength(1);
      expect(results[0].ast.tags).toEqual(["valid", "valid2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
