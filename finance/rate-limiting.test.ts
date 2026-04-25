/**
 * Per-endpoint rate-limiting integration tests.
 *
 * Covers the six limited finance endpoints listed in
 * docs/finance-rate-limiting.md §2:
 *
 *   1. POST /finance/tan-sessions/complete   (5 / 10m, per tan_reference)
 *   2. POST /finance/bankcontacts/:id/creds  (10 / 15m, per user×bankcontact)
 *   3. POST /finance/statements              (20 / 15m, per user×bankcontact)
 *   4. POST /finance/admin/import            (3 / 60m, per user)
 *   5. POST /finance/analysis/query          (30 / 10m, per user)
 *   6. POST /finance/tags/suggest            (5 / 60m, per user)
 *
 * Each block runs: one "normal" call succeeds, then the max+1-th call
 * throws resource_exhausted. The tan-complete block additionally
 * verifies the reset-on-success behaviour (follow-up TAN counts as
 * success and clears the counter).
 *
 * The rate-limit Map is process-wide; tests reset it in beforeEach via
 * the __resetRateLimiterForTests() helper so one block's attempts
 * don't bleed into the next.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

import { setBankcontactCredentials } from "./bankcontacts";
import { completeTanSession } from "./tan-sessions";
import { triggerSync } from "./statements";
import { importFinanceData } from "./data-import";
import { query as analysisQuery } from "./analysis";
import { suggestTagsBatch } from "./tag-suggester";
import type { FinanzkraftExport } from "./import-schema";

import * as fintsClient from "./fints-client";
import * as llmClient from "./llm-client";

vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return {
    ...actual,
    runSynchronize: vi.fn(),
  };
});

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

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "RL Test",
      blz: "99999999",
      login: "rl-user",
      server_url: "https://rl.test",
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function insertTanSession(opts: {
  userId: number;
  bankcontactId: number;
}): Promise<string> {
  await ensureUser(opts.userId);
  const ref = randomUUID();
  await db.insert(financeTanSession).values({
    tan_reference: ref,
    user_id: opts.userId,
    bankcontact_id: opts.bankcontactId,
    banking_information: {
      bi: { systemId: "rl-sys" },
      fintsTanRef: "rl-fints-ref",
    },
    challenge: "rl-challenge",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return ref;
}

beforeEach(async () => {
  // Wipe the finance graph leaves-inward — same ordering other finance
  // test files use, so cross-file state can't break this suite either.
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  __resetRateLimiterForTests();
  setAuth("1", []);
  vi.mocked(fintsClient.runSynchronize).mockReset();
  vi.mocked(llmClient.parseAnalysisQuery).mockReset();
});

function expect429(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBe("resource_exhausted");
  expect((err as Error).message).toMatch(/Retry after \d+s/);
}

// -----------------------------------------------------------------------
// 1. POST /finance/tan-sessions/complete — 5 / 10m per tan_reference
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/tan-sessions/complete", () => {
  it("blocks the 6th call with the same tan_reference", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    // checkRateLimit runs BEFORE the session lookup, so a non-existent
    // reference is enough to exercise the counter without having to
    // re-insert a session between every attempt.
    const ref = randomUUID();

    for (let i = 0; i < 5; i++) {
      await expect(
        completeTanSession({ tanReference: ref, tan: `x${i}` }),
      ).rejects.toThrow(/not found/);
    }
    try {
      await completeTanSession({ tanReference: ref, tan: "over" });
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });

  it("resets the counter after a terminal success (state=idle)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertTanSession({ userId: 42, bankcontactId: bcId });

    // Four failed attempts (session deleted → handler throws
    // not-found, but the rate-limit counter still increments because
    // checkRateLimit runs first).
    await db
      .delete(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    for (let i = 0; i < 4; i++) {
      await expect(
        completeTanSession({ tanReference: ref, tan: "x" }),
      ).rejects.toThrow(/not found/);
    }

    // Re-insert the session and let the 5th call succeed → resets key.
    await db
      .insert(financeTanSession)
      .values({
        tan_reference: ref,
        user_id: 42,
        bankcontact_id: bcId,
        banking_information: {
          bi: { systemId: "rl-sys" },
          fintsTanRef: "rl-fints-ref",
        },
        challenge: "rl-challenge",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .onConflictDoNothing();
    vi.mocked(fintsClient.runSynchronize).mockResolvedValueOnce({
      state: "idle",
    });
    const r = await completeTanSession({ tanReference: ref, tan: "ok" });
    expect(r.state).toBe("idle");

    // After reset we can run 5 fresh attempts on the same key before
    // hitting 429 again.
    for (let i = 0; i < 5; i++) {
      await expect(
        completeTanSession({ tanReference: ref, tan: "x" }),
      ).rejects.toThrow(/not found/);
    }
    try {
      await completeTanSession({ tanReference: ref, tan: "over" });
      throw new Error("expected 429 after reset cycle");
    } catch (err) {
      expect429(err);
    }
  });

  it("isolates different tan_references — one session being blocked does not affect another", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const refA = randomUUID();
    const refB = randomUUID();

    for (let i = 0; i < 5; i++) {
      await expect(
        completeTanSession({ tanReference: refA, tan: `x${i}` }),
      ).rejects.toThrow(/not found/);
    }
    try {
      await completeTanSession({ tanReference: refA, tan: "over" });
      throw new Error("expected 429 for refA");
    } catch (err) {
      expect429(err);
    }

    // refB has its own independent key-space.
    await expect(
      completeTanSession({ tanReference: refB, tan: "first-on-B" }),
    ).rejects.toThrow(/not found/);
  });
});

// -----------------------------------------------------------------------
// 2. POST /finance/bankcontacts/:id/credentials — 10 / 15m
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/bankcontacts/:id/credentials", () => {
  it("blocks the 11th credential-set for the same user×bankcontact", async () => {
    setAuth("7", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();

    for (let i = 0; i < 10; i++) {
      await setBankcontactCredentials({ id: bcId, pin: `pin${i}` });
    }
    try {
      await setBankcontactCredentials({ id: bcId, pin: "pin-over" });
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });

  it("tracks different user×bankcontact pairs independently", async () => {
    setAuth("7", ["finance.accounts.manage"]);
    const bcA = await insertBankcontact();
    // Second bankcontact — separate key even for the same user.
    const [bcB] = await db
      .insert(financeBankcontact)
      .values({
        name: "RL Test B",
        blz: "88888888",
        login: "rl-user",
        server_url: "https://rl-b.test",
      })
      .returning({ id: financeBankcontact.id });

    for (let i = 0; i < 10; i++) {
      await setBankcontactCredentials({ id: bcA, pin: `a${i}` });
    }
    try {
      await setBankcontactCredentials({ id: bcA, pin: "a-over" });
      throw new Error("expected 429 for bcA");
    } catch (err) {
      expect429(err);
    }

    // bcB fresh quota.
    await expect(
      setBankcontactCredentials({ id: bcB.id, pin: "first" }),
    ).resolves.toEqual({ credentials_set: true });
  });
});

// -----------------------------------------------------------------------
// 3. POST /finance/statements — 20 / 15m per user×bankcontact
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/statements", () => {
  it("blocks the 21st manual sync for the same user×bankcontact", async () => {
    setAuth("7", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();

    // No client → fetchAndPersist returns idle zero-stats cheaply.
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
    });

    for (let i = 0; i < 20; i++) {
      const r = await triggerSync({ bankcontactId: bcId });
      expect(r.state).toBe("idle");
    }
    try {
      await triggerSync({ bankcontactId: bcId });
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });
});

// -----------------------------------------------------------------------
// 4. POST /finance/admin/import — 3 / 60m per user
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/admin/import", () => {
  it("blocks the 4th import from the same user", async () => {
    setAuth("1", ["finance.admin"]);
    const emptyExport: FinanzkraftExport = {
      version: "1",
      bankcontacts: [],
      accounts: [],
      transactions: [],
      tags: [],
      tag_links: [],
    };

    for (let i = 0; i < 3; i++) {
      await importFinanceData({ export: emptyExport });
    }
    try {
      await importFinanceData({ export: emptyExport });
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });
});

// -----------------------------------------------------------------------
// 5. POST /finance/analysis/query — 30 / 10m per user
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/analysis/query", () => {
  it("blocks the 31st LLM-backed query from the same user", async () => {
    setAuth("1", ["finance.view", "finance.admin"]); // admin → no ACL narrowing
    vi.mocked(llmClient.parseAnalysisQuery).mockResolvedValue({
      tags: [],
      op: "AND",
    });

    for (let i = 0; i < 30; i++) {
      await analysisQuery({ question: `q ${i}` });
    }
    try {
      await analysisQuery({ question: "one too many" });
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });
});

// -----------------------------------------------------------------------
// 6. POST /finance/tags/suggest — 5 / 60m per user
// -----------------------------------------------------------------------

describe("rate-limiting — POST /finance/tags/suggest", () => {
  it("blocks the 6th batch run from the same user", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);

    for (let i = 0; i < 5; i++) {
      // No transactions seeded — the endpoint returns 0/0 but still
      // goes through checkRateLimit, which is what we're exercising.
      const r = await suggestTagsBatch({});
      expect(r.attempted).toBe(0);
    }
    try {
      await suggestTagsBatch({});
      throw new Error("expected 429");
    } catch (err) {
      expect429(err);
    }
  });
});
