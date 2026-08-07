import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeAccountBalance,
  financeBankcontact,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import {
  cleanupExpiredTanSessions,
  completeTanSession,
} from "./tan-sessions";
import * as fintsClient from "./fints-client";
import * as statementPersist from "./statement-persist";
import type { DialogResult } from "./types";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return {
    ...actual,
    runSynchronize: vi.fn(),
    takeCachedClient: vi.fn(),
    resumeFetchAfterTan: vi.fn(),
    runFetchAccounts: vi.fn(),
  };
});

vi.mock("./statement-persist", async (orig) => {
  const actual = await orig<typeof import("./statement-persist")>();
  return {
    ...actual,
    persistFetchResult: vi.fn(),
  };
});

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (existing.length > 0) return;
  // Raw INSERT so we can pick the id explicitly — users is a serial PK.
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
  vi.mocked(fintsClient.takeCachedClient).mockReset();
  vi.mocked(fintsClient.resumeFetchAfterTan).mockReset();
  vi.mocked(fintsClient.runFetchAccounts).mockReset();
  vi.mocked(statementPersist.persistFetchResult).mockReset();
});

async function insertSession(opts: {
  userId: number;
  bankcontactId: number;
  expiresAt?: Date;
  fintsTanRef?: string;
}): Promise<string> {
  await ensureUser(opts.userId);
  const ref = randomUUID();
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 10 * 60_000);
  await db.insert(financeTanSession).values({
    tan_reference: ref,
    user_id: opts.userId,
    bankcontact_id: opts.bankcontactId,
    banking_information: {
      bi: { systemId: "sys-stored" },
      fintsTanRef: opts.fintsTanRef ?? "fints-ref-xyz",
    },
    challenge: "stored-challenge",
    expires_at: expiresAt.toISOString(),
  });
  return ref;
}

async function insertStatementsSession(opts: {
  userId: number;
  bankcontactId: number;
  withFetchContext?: boolean;
}): Promise<string> {
  await ensureUser(opts.userId);
  const ref = randomUUID();
  await db.insert(financeTanSession).values({
    tan_reference: ref,
    user_id: opts.userId,
    bankcontact_id: opts.bankcontactId,
    kind: "statements",
    banking_information: { fintsTanRef: "statement-ref" },
    challenge: "photoTAN",
    fetch_context: opts.withFetchContext === false
      ? null
      : {
          currentAccountNumber: "A",
          remainingAccountNumbers: ["B"],
          linkedAccountNumbers: ["A", "B"],
        },
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  await db
    .update(financeBankcontact)
    .set({ last_sync_status: "tan-required" })
    .where(eq(financeBankcontact.id, opts.bankcontactId));
  return ref;
}

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

// ---------- complete ----------

describe("finance/tan-sessions — complete (happy path)", () => {
  it("calls runSynchronize with stored bankingInformation + fintsTanRef + user TAN, then deletes the session", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({
      userId: 42,
      bankcontactId: bcId,
      fintsTanRef: "fints-ref-xyz",
    });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
      bankingInformation: { systemId: "sys-post-tan" },
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });
    expect(response.state).toBe("idle");

    expect(fintsClient.runSynchronize).toHaveBeenCalledWith(bcId, {
      tanReference: "fints-ref-xyz",
      tanAnswer: "123456",
      bankingInformation: { systemId: "sys-stored" },
    });

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(0);
  });

  it("passes undefined TAN through for decoupled methods (pushTAN)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
    });

    await completeTanSession({ tanReference: ref });

    const arg = vi.mocked(fintsClient.runSynchronize).mock.calls[0]?.[1];
    expect(arg?.tanAnswer).toBeUndefined();
  });
});

describe("finance/tan-sessions — complete (error / retry paths)", () => {
  it("updates the session with the new challenge when the bank returns tan-required again (wrong TAN)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "tan-required",
      bankingInformation: { systemId: "sys-retry" },
      tanChallenge: "Falsche TAN, bitte erneut",
      tanReference: "fints-ref-v2",
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "wrong",
    });
    expect(response.state).toBe("tan-required");
    if (response.state !== "tan-required") throw new Error("type narrow");
    expect(response.tanReference).toBe(ref); // same public handle
    expect(response.challenge).toBe("Falsche TAN, bitte erneut");

    // Session still there, banking_information + challenge updated
    const [after] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(after).toBeDefined();
    expect(after.challenge).toBe("Falsche TAN, bitte erneut");
    expect(after.banking_information).toMatchObject({
      bi: { systemId: "sys-retry" },
      fintsTanRef: "fints-ref-v2",
    });
  });

  it("deletes the session and returns error when the dialog errors out terminally", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "error",
      errorCode: "9050",
      errorMessage: "Dialog abgebrochen",
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });
    expect(response).toEqual({
      state: "error",
      errorCode: "9050",
      errorMessage: "Dialog abgebrochen",
    });

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(0);
  });
});

describe("finance/tan-sessions — TAN demanded again right after the init TAN", () => {
  it("persists a statements session instead of reporting a clean 'idle'", async () => {
    // comdirect (photoTAN) answers the init dialog's TAN, then wants a
    // second, per-query TAN for the statement fetch that follows. That
    // challenge has to become a kind="statements" session — otherwise
    // the UI closes the dialog as if the sync had finished and the next
    // sync starts over at the very same TAN.
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
      client: {} as never,
    });
    vi.mocked(fintsClient.runFetchAccounts).mockResolvedValue({
      accounts: [],
      partial: true,
      pendingTan: {
        tanReference: "fints-stmt-ref",
        tanChallenge: "photoTAN für Umsatzabfrage",
        accountNumber: "A",
        remainingAccountNumbers: ["B"],
      },
    });
    vi.mocked(statementPersist.persistFetchResult).mockResolvedValue({
      accounts_seen: 0,
      accounts_matched: 0,
      accounts_closed: 0,
      accounts_unknown: 0,
      transactions_inserted: 0,
      transactions_skipped_duplicate: 0,
      balances_written: 0,
      holdings_written: 0,
      unknown: [],
      errors: [],
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });

    expect(response.state).toBe("tan-required");
    const [session] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.bankcontact_id, bcId));
    expect(session).toBeDefined();
    expect(session.kind).toBe("statements");
    expect(session.user_id).toBe(42);
    expect(session.challenge).toBe("photoTAN für Umsatzabfrage");
  });
});

describe("finance/tan-sessions — statement TAN status", () => {
  const emptyStats = {
    accounts_seen: 2,
    accounts_matched: 2,
    accounts_closed: 0,
    accounts_unknown: 0,
    transactions_inserted: 3,
    transactions_skipped_duplicate: 1,
    balances_written: 2,
    holdings_written: 0,
    unknown: [],
    errors: [],
  };

  it.each([
    { partial: false, expected: "ok" },
    { partial: true, expected: "partial" },
  ])(
    "replaces tan-required with $expected after a successful resume",
    async ({ partial, expected }) => {
      setAuth("42", ["finance.accounts.manage"]);
      const bcId = await insertBankcontact();
      const ref = await insertStatementsSession({
        userId: 42,
        bankcontactId: bcId,
      });
      vi.mocked(fintsClient.takeCachedClient).mockReturnValue({} as never);
      vi.mocked(fintsClient.resumeFetchAfterTan).mockResolvedValue({
        accounts: [],
        partial,
      });
      vi.mocked(statementPersist.persistFetchResult).mockResolvedValue(emptyStats);

      const response = await completeTanSession({
        tanReference: ref,
        tan: "123456",
      });

      expect(response.state).toBe("idle");
      const [contact] = await db
        .select({
          status: financeBankcontact.last_sync_status,
          syncedAt: financeBankcontact.last_sync_at,
        })
        .from(financeBankcontact)
        .where(eq(financeBankcontact.id, bcId));
      expect(contact.status).toBe(expected);
      expect(contact.syncedAt).not.toBeNull();
    },
  );

  it("resumes the queued accounts with the same linked-only / from-date plan", async () => {
    // Without the plan the queued accounts are fetched unfiltered and
    // without a `from` — an SCA push for accounts nobody linked, and an
    // out-of-90-day-window query for the linked ones, i.e. a fresh TAN
    // challenge per account.
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const [type] = await db
      .select({ id: financeAccountType.id })
      .from(financeAccountType)
      .where(eq(financeAccountType.kind, "giro"))
      .limit(1);
    await db.insert(financeAccount).values({
      bankcontact_id: bcId,
      fints_account_number: "A",
      type_id: type.id,
      currency_code: "EUR",
      account_number: "A",
      label: "Girokonto",
    });
    const ref = await insertStatementsSession({
      userId: 42,
      bankcontactId: bcId,
    });
    vi.mocked(fintsClient.takeCachedClient).mockReturnValue({} as never);
    vi.mocked(fintsClient.resumeFetchAfterTan).mockResolvedValue({
      accounts: [],
      partial: false,
    });
    vi.mocked(statementPersist.persistFetchResult).mockResolvedValue(emptyStats);

    await completeTanSession({ tanReference: ref, tan: "123456" });

    const arg = vi.mocked(fintsClient.resumeFetchAfterTan).mock.calls[0]?.[1];
    expect(arg?.linkedAccountNumbers).toEqual(new Set(["A"]));
    expect(arg?.defaultFrom).toBeInstanceOf(Date);
    // Inside PSD2's 90-day read-only window, so the bank has no reason
    // to demand another TAN for the queued accounts.
    const daysBack =
      (Date.now() - (arg!.defaultFrom as Date).getTime()) / 86_400_000;
    expect(daysBack).toBeLessThan(90);
  });

  it("keeps tan-required when the bank returns a follow-up challenge", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertStatementsSession({
      userId: 42,
      bankcontactId: bcId,
    });
    vi.mocked(fintsClient.takeCachedClient).mockReturnValue({} as never);
    vi.mocked(fintsClient.resumeFetchAfterTan).mockResolvedValue({
      accounts: [],
      partial: true,
      pendingTan: {
        tanReference: "statement-ref-2",
        tanChallenge: "Noch eine TAN",
        accountNumber: "A",
        remainingAccountNumbers: [],
      },
    });
    vi.mocked(statementPersist.persistFetchResult).mockResolvedValue(
      emptyStats,
    );

    const response = await completeTanSession({
      tanReference: ref,
      tan: "wrong",
    });

    expect(response.state).toBe("tan-required");
    const [contact] = await db
      .select({ status: financeBankcontact.last_sync_status })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(contact.status).toBe("tan-required");
  });

  it("replaces tan-required with a terminal error when the live client is gone", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertStatementsSession({
      userId: 42,
      bankcontactId: bcId,
    });
    vi.mocked(fintsClient.takeCachedClient).mockReturnValue(null);

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });

    expect(response).toMatchObject({
      state: "error",
      errorCode: "live-client-evicted",
    });
    const [contact] = await db
      .select({ status: financeBankcontact.last_sync_status })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(contact.status).toBe("error:live-client-evicted");
  });
});

describe("finance/tan-sessions — complete (access & expiry)", () => {
  it("404s for an unknown tanReference without calling fints-client", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    await expect(
      completeTanSession({ tanReference: randomUUID(), tan: "x" }),
    ).rejects.toThrow(/not found/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();
  });

  it("refuses a session owned by a different user (returns the same 'not found' to prevent enumeration)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 99, bankcontactId: bcId });

    await expect(
      completeTanSession({ tanReference: ref, tan: "x" }),
    ).rejects.toThrow(/not found/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();
  });

  it("returns deadline_exceeded for an expired session (row stays for cleanup cron)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({
      userId: 42,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      completeTanSession({ tanReference: ref, tan: "x" }),
    ).rejects.toThrow(/expired/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(1);
  });

  it("requires finance.accounts.manage", async () => {
    setAuth("42", []);
    await expect(
      completeTanSession({ tanReference: randomUUID(), tan: "x" }),
    ).rejects.toThrow(/permission/);
  });
});

// ---------- cleanup cron ----------

describe("finance/tan-sessions — cleanupExpiredTanSessions", () => {
  it("deletes only rows past expires_at", async () => {
    const bcId = await insertBankcontact();
    const past = await insertSession({
      userId: 1,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() - 5_000),
    });
    const future = await insertSession({
      userId: 1,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const { deleted } = await cleanupExpiredTanSessions();
    expect(deleted).toBe(1);

    const rows = await db.select().from(financeTanSession);
    expect(rows.map((r) => r.tan_reference)).toEqual([future]);
    void past; // kept for readability of the test intent
  });
});
