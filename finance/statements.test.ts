import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { sql } from "drizzle-orm";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeBankcontact,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import { triggerSync } from "./statements";
import * as fintsClient from "./fints-client";
import type { DialogResult } from "./types";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

// Mock the wrapper — endpoint tests only care about its contract, not
// its implementation. The dedicated fints-client.test.ts covers the
// mapping logic itself.
vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return {
    ...actual,
    runSynchronize: vi.fn(),
    runFetchAccounts: vi.fn(),
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
  // Drain the finance graph from leaves inward so FK RESTRICTs don't
  // trip when a previous test file left transactions/balances behind.
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  __resetRateLimiterForTests();
  setAuth("1", []);
  vi.mocked(fintsClient.runSynchronize).mockReset();
  vi.mocked(fintsClient.runFetchAccounts).mockReset();
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Test",
      blz: "12345678",
      login: "u",
      server_url: "https://x",
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

function mockResult(r: DialogResult) {
  vi.mocked(fintsClient.runSynchronize).mockResolvedValue(r);
}

describe("finance/statements — triggerSync", () => {
  it("requires finance.accounts.manage", async () => {
    setAuth("1", []);
    const id = await insertBankcontact();
    await expect(triggerSync({ bankcontactId: id })).rejects.toThrow(
      /permission/,
    );
  });

  it("404s for unknown bankcontact id", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(triggerSync({ bankcontactId: 999_999 })).rejects.toThrow(
      /not found/,
    );
  });

  it("returns state=idle when the dialog finishes cleanly", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const id = await insertBankcontact();
    // No client on the mocked result — triggerSync will short-circuit
    // fetchAndPersist to zero-counters. Real clients are exercised via
    // the dedicated fints-client test.
    mockResult({ state: "idle", bankingInformation: { systemId: "sys-1" } });

    const response = await triggerSync({ bankcontactId: id });
    expect(response.state).toBe("idle");
    if (response.state !== "idle") throw new Error("type narrow");
    expect(response.accounts_seen).toBe(0);
    expect(response.transactions_inserted).toBe(0);

    const sessions = await db.select().from(financeTanSession);
    expect(sessions).toHaveLength(0);
  });

  it("persists a TAN session and returns tan-required with our UUID, not the FinTS handle", async () => {
    setAuth("7", ["finance.accounts.manage"]);
    await ensureUser(7);
    const id = await insertBankcontact();
    mockResult({
      state: "tan-required",
      bankingInformation: { systemId: "sys-1" },
      tanChallenge: "Bitte in pushTAN bestätigen",
      tanReference: "fints-ref-xyz",
      tanMediaName: "Pixel 7",
    });

    const response = await triggerSync({ bankcontactId: id });
    expect(response.state).toBe("tan-required");
    if (response.state !== "tan-required") throw new Error("type narrow");
    expect(response.challenge).toBe("Bitte in pushTAN bestätigen");
    expect(response.tanMediaName).toBe("Pixel 7");
    // The public reference is a UUID, not the lib-fints handle
    expect(response.tanReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.tanReference).not.toBe("fints-ref-xyz");

    const [session] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, response.tanReference));
    expect(session.user_id).toBe(7);
    expect(session.bankcontact_id).toBe(id);
    expect(session.challenge).toBe("Bitte in pushTAN bestätigen");
    expect(session.banking_information).toMatchObject({
      bi: { systemId: "sys-1" },
      fintsTanRef: "fints-ref-xyz",
    });
    // expires_at ≈ now + 10 min (we allow a 1s tolerance)
    const expiresMs = new Date(session.expires_at).getTime();
    const expected = Date.now() + 10 * 60_000;
    expect(Math.abs(expiresMs - expected)).toBeLessThan(1000);
  });

  it("surfaces an error state without creating a TAN session", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const id = await insertBankcontact();
    mockResult({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const response = await triggerSync({ bankcontactId: id });
    expect(response).toEqual({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const sessions = await db.select().from(financeTanSession);
    expect(sessions).toHaveLength(0);
  });

  it("returns the bank's unknown accounts in unknown_accounts (no auto-create)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    await ensureUser(42);
    const bcId = await insertBankcontact();

    // A stand-in live client — the only field fetchAndPersist reads
    // on its way into the mocked runFetchAccounts is its truthiness.
    const dummyClient = { stub: true };
    mockResult({
      state: "idle",
      bankingInformation: { systemId: "sys-1" },
      client: dummyClient,
    });
    vi.mocked(fintsClient.runFetchAccounts).mockResolvedValue({
      accounts: [
        {
          accountNumber: "CHECK-01",
          iban: "DE00000000000000000001",
          accountKind: "giro",
          currency: "EUR",
          label: "Giro Max",
          balance: null,
          transactions: [],
          errors: [],
        },
      ],
      partial: false,
    });

    const response = await triggerSync({ bankcontactId: bcId });
    expect(response.state).toBe("idle");
    if (response.state !== "idle") throw new Error("type narrow");

    expect(response.accounts_seen).toBe(1);
    expect(response.accounts_matched).toBe(0);
    expect(response.accounts_unknown).toBe(1);
    expect(response.unknown_accounts).toEqual([
      {
        accountNumber: "CHECK-01",
        iban: "DE00000000000000000001",
        accountKind: "giro",
        currency: "EUR",
        label: "Giro Max",
      },
    ]);

    // Nothing auto-created: no finance_account row, no ACL rows.
    const accounts = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, bcId));
    expect(accounts).toHaveLength(0);
    const acl = await db.select().from(financeAccountAccess);
    expect(acl).toHaveLength(0);
  });
});
