import { describe, it, expect, beforeEach, vi } from "vitest";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeBankcontact,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
} from "../db/schema";
import { sql } from "drizzle-orm";
import { probeTanMethods, runSynchronize, type FintsClientSurface } from "./fints-client";
import type { DialogResult } from "./types";

// lib-fints is mocked at module level so the wrapper's mapping/retry
// logic can be exercised without talking to a bank. The test-seam
// `clientFactory` injected into `runSynchronize` then replaces the
// stubbed constructor with per-test behaviour.
vi.mock("lib-fints", () => ({
  FinTSClient: class FinTSClient {
    constructor(public config: any) {}
    synchronize() { throw new Error("not used — factory override"); }
    synchronizeWithTan(_ref: string, _tan?: string) {
      throw new Error("not used — factory override");
    }
    selectTanMethod(_id: number) { /* no-op */ }
  },
  FinTSConfig: {
    forFirstTimeUse: vi.fn((_pid, _pver, _url, _blz, _uid, _pin) => ({
      bankingInformation: { systemId: "sys-new", bankMessages: [] },
    })),
    fromBankingInformation: vi.fn((_pid, _pver, info, _uid, _pin, _tid) => ({
      bankingInformation: info,
    })),
  },
}));

beforeEach(async () => {
  // Leftovers from preceding test files would break the delete
  // cascade (finance_account → finance_bankcontact is RESTRICT), so
  // drain the finance graph from leaves inward.
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
});

/**
 * Insert a bankcontact row for the current test and return its id. By
 * default credentials_encrypted is NULL — the wrapper short-circuits the
 * decrypt path, so tests don't need real encryption material unless
 * they're specifically exercising it.
 */
async function insertBankcontact(
  overrides: Partial<typeof financeBankcontact.$inferInsert> = {},
): Promise<number> {
  // tan_method defaults to "942" — the fresh-path sync requires a
  // picked TAN method before the second synchronize() call (see
  // lib-fints README §2). Tests that specifically exercise the
  // "missing tan_method" branch can override with `tan_method: null`.
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Sparkasse Test",
      blz: "12345678",
      login: "user-42",
      server_url: "https://hbci.test/fints",
      tan_method: "942",
      credentials_encrypted: null,
      ...overrides,
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

/** Build a minimal FintsClientSurface that returns the given response. */
function mockClient(
  response: {
    success: boolean;
    requiresTan: boolean;
    tanChallenge?: string;
    tanReference?: string;
    tanMediaName?: string;
    bankAnswers?: Array<{ code: number; text: string }>;
  },
  bankingInformation: Record<string, unknown> = { systemId: "sys-1" },
  // Default matches the default tan_method "942" on insertBankcontact;
  // tests that exercise unknown-method branches override with [].
  availableTanMethods: Array<{ id: number; name: string; isDecoupled: boolean }> = [
    { id: 942, name: "pushTAN", isDecoupled: true },
  ],
): FintsClientSurface {
  const resp = { bankAnswers: [], ...response };
  return {
    synchronize: vi.fn(async () => resp as any),
    synchronizeWithTan: vi.fn(async () => resp as any),
    selectTanMethod: vi.fn(),
    config: { bankingInformation, availableTanMethods } as any,
    // Not exercised in the sync-dialog tests; the runFetchAccounts
    // tests below override these via their own custom mocks.
    getAccountStatements: vi.fn(),
    getAccountStatementsWithTan: vi.fn(),
    getAccountBalance: vi.fn(),
    getAccountBalanceWithTan: vi.fn(),
  };
}

describe("fints-client — response mapping", () => {
  it("maps success + !requiresTan → state=idle", async () => {
    const id = await insertBankcontact();
    const result = await runSynchronize(id, {
      clientFactory: () => mockClient({ success: true, requiresTan: false }),
      sleep: async () => {},
    });
    expect(result.state).toBe("idle");
    expect(result.bankingInformation).toEqual({ systemId: "sys-1" });
    expect(result.errorCode).toBeUndefined();
  });

  it("maps requiresTan=true → state=tan-required with challenge/reference", async () => {
    const id = await insertBankcontact();
    const result = await runSynchronize(id, {
      clientFactory: () =>
        mockClient({
          success: true,
          requiresTan: true,
          tanChallenge: "Bitte in pushTAN bestätigen",
          tanReference: "tanref-abc",
          tanMediaName: "Pixel 7",
        }),
      sleep: async () => {},
    });
    expect(result.state).toBe("tan-required");
    expect(result.tanChallenge).toBe("Bitte in pushTAN bestätigen");
    expect(result.tanReference).toBe("tanref-abc");
    expect(result.tanMediaName).toBe("Pixel 7");
    expect(result.bankingInformation).toBeDefined();
  });

  it("maps FinTS code 9910 (wrong PIN) → state=error with errorCode '9910'", async () => {
    const id = await insertBankcontact();
    const result = await runSynchronize(id, {
      clientFactory: () =>
        mockClient({
          success: false,
          requiresTan: false,
          bankAnswers: [
            { code: 9910, text: "PIN falsch" },
          ],
        }),
      sleep: async () => {},
    });
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("9910");
    expect(result.errorMessage).toBe("PIN falsch");
  });

  it("picks the first non-zero bankAnswer code when multiple are present", async () => {
    const id = await insertBankcontact();
    const result = await runSynchronize(id, {
      clientFactory: () =>
        mockClient({
          success: false,
          requiresTan: false,
          bankAnswers: [
            { code: 0, text: "info" },
            { code: 9050, text: "Fehler" },
            { code: 9010, text: "ignored" },
          ],
        }),
      sleep: async () => {},
    });
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("9050");
    expect(result.errorMessage).toBe("Fehler");
  });
});

describe("fints-client — resume path", () => {
  it("calls synchronizeWithTan with the tanReference on resume, not synchronize", async () => {
    const id = await insertBankcontact();
    const client = mockClient({ success: true, requiresTan: false });
    let capturedRef: string | undefined;
    let capturedTan: string | undefined;

    (client.synchronizeWithTan as any).mockImplementation(
      async (ref: string, tan?: string) => {
        capturedRef = ref;
        capturedTan = tan;
        return { success: true, requiresTan: false, bankAnswers: [] } as any;
      },
    );

    await runSynchronize(id, {
      tanReference: "tanref-xyz",
      tanAnswer: "123456",
      bankingInformation: { systemId: "saved" },
      clientFactory: () => client,
      sleep: async () => {},
    });

    expect(client.synchronize).not.toHaveBeenCalled();
    expect(client.synchronizeWithTan).toHaveBeenCalledOnce();
    expect(capturedRef).toBe("tanref-xyz");
    expect(capturedTan).toBe("123456");
  });

  it("passes undefined TAN through for decoupled methods (pushTAN)", async () => {
    const id = await insertBankcontact();
    const client = mockClient({ success: true, requiresTan: false });
    let capturedTan: string | undefined = "NOT-CALLED" as any;

    (client.synchronizeWithTan as any).mockImplementation(
      async (_ref: string, tan?: string) => {
        capturedTan = tan;
        return { success: true, requiresTan: false, bankAnswers: [] } as any;
      },
    );

    await runSynchronize(id, {
      tanReference: "tanref-decoupled",
      // no tanAnswer
      bankingInformation: { systemId: "saved" },
      clientFactory: () => client,
      sleep: async () => {},
    });

    expect(capturedTan).toBeUndefined();
  });
});

describe("fints-client — retry behaviour", () => {
  it("retries transport errors up to 2 times with backoff, then returns error state", async () => {
    const id = await insertBankcontact();
    const sleep = vi.fn(async (_ms: number) => {});
    const factory = vi.fn(() => {
      const c = mockClient({ success: false, requiresTan: false });
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      return c;
    });

    const result = await runSynchronize(id, {
      clientFactory: factory,
      sleep,
    });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("transport");
    expect(result.errorMessage).toContain("3 attempts");
    // 2 sleep calls between 3 attempts
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it("succeeds on the third attempt if the first two fail transiently", async () => {
    const id = await insertBankcontact();
    const c = mockClient({ success: true, requiresTan: false });
    (c.synchronize as any)
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({
        success: true,
        requiresTan: false,
        bankAnswers: [],
      } as any);

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("idle");
  });
});

describe("fints-client — bankcontact loading", () => {
  it("throws when the bankcontact id does not exist", async () => {
    await expect(
      runSynchronize(999_999, {
        clientFactory: () => mockClient({ success: true, requiresTan: false }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/not found/);
  });

  it("calls selectTanMethod when tan_method is set on the bankcontact (fresh dialog only)", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient({ success: true, requiresTan: false });

    await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(c.selectTanMethod).toHaveBeenCalledWith(942);
  });

  it("performs two synchronize() calls on the fresh path (BPD, then UPD)", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient({ success: true, requiresTan: false });

    await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(c.synchronize).toHaveBeenCalledTimes(2);
    expect(c.selectTanMethod).toHaveBeenCalledWith(942);
    // selectTanMethod must run between the two syncs — the mocks are
    // all vi.fn so their invocation order is recorded globally.
    const syncOrder = (c.synchronize as any).mock.invocationCallOrder;
    const selectOrder = (c.selectTanMethod as any).mock.invocationCallOrder;
    expect(selectOrder[0]).toBeGreaterThan(syncOrder[0]);
    expect(selectOrder[0]).toBeLessThan(syncOrder[1]);
  });

  it("returns state=error when tan_method is missing on a fresh sync", async () => {
    const id = await insertBankcontact({ tan_method: null });
    const c = mockClient({ success: true, requiresTan: false });

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("no-tan-method");
    // First sync still ran (to retrieve BPD); the second must have
    // been skipped because there is no TAN method to select.
    expect(c.synchronize).toHaveBeenCalledTimes(1);
    expect(c.selectTanMethod).not.toHaveBeenCalled();
  });

  it("short-circuits without the second sync if the first requires TAN", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient({
      success: true,
      requiresTan: true,
      tanChallenge: "Bitte bestätigen",
      tanReference: "first-sync-tan",
    });

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("tan-required");
    expect(result.tanReference).toBe("first-sync-tan");
    expect(c.synchronize).toHaveBeenCalledTimes(1);
    expect(c.selectTanMethod).not.toHaveBeenCalled();
  });

  it("returns errorCode=unknown-tan-method (no retry) when the id is not in the bank's list", async () => {
    // Admin configured 904 but the bank only offers 942 / 910 — without
    // the pre-check lib-fints would throw "TAN Method '904' is not
    // supported" synchronously, which the retry loop would mis-classify
    // as a transport error.
    const id = await insertBankcontact({ tan_method: "904" });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = mockClient(
      { success: true, requiresTan: false },
      { systemId: "sys" },
      [
        { id: 942, name: "pushTAN", isDecoupled: true },
        { id: 910, name: "chipTAN", isDecoupled: false },
      ],
    );

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("unknown-tan-method");
    expect(result.errorMessage).toMatch(/904/);
    expect(result.errorMessage).toMatch(/942 \(pushTAN\)/);
    expect(result.errorMessage).toMatch(/910 \(chipTAN\)/);
    // Only the first (BPD-only) sync must have run — the validation
    // short-circuits before we reach selectTanMethod/the second sync.
    expect(c.synchronize).toHaveBeenCalledTimes(1);
    expect(c.selectTanMethod).not.toHaveBeenCalled();
    // And — crucially — we didn't retry: no sleep between attempts.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports the empty-list edge case cleanly when the bank didn't return any methods", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient(
      { success: true, requiresTan: false },
      { systemId: "sys" },
      [], // empty availableTanMethods
    );

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("unknown-tan-method");
    expect(result.errorMessage).toMatch(/none returned by bank/);
  });
});

// ======================================================================
// runFetchAccounts — fetch statements + balance per account
// ======================================================================

import { runFetchAccounts } from "./fints-client";

function clientWith(
  accounts: Array<{
    accountNumber: string;
    iban?: string;
    accountType?: string;
    currency?: string;
    holder1?: string;
  }>,
  overrides: Partial<FintsClientSurface> = {},
): FintsClientSurface {
  const base = mockClient({ success: true, requiresTan: false }, {
    systemId: "sys",
    upd: { bankAccounts: accounts },
  } as any);
  return { ...base, ...overrides };
}

function stmtResp(transactions: any[], flags: Partial<{ success: boolean; requiresTan: boolean }> = {}) {
  return {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    statements: [{ transactions }],
    ...flags,
  } as any;
}

function balResp(balance: { date: Date; currency: string; balance: number } | null, flags: Partial<{ success: boolean; requiresTan: boolean }> = {}) {
  return {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    balance: balance ?? undefined,
    ...flags,
  } as any;
}

describe("runFetchAccounts — happy path", () => {
  it("maps statements + balance per account", async () => {
    const c = clientWith(
      [
        {
          accountNumber: "1234567890",
          iban: "DE12",
          accountType: "CheckingAccount",
          currency: "EUR",
          holder1: "Max Mustermann",
        },
      ],
      {
        getAccountStatements: vi.fn(async () =>
          stmtResp([
            {
              valueDate: new Date("2026-04-24"),
              entryDate: new Date("2026-04-24"),
              amount: -42.5,
              purpose: "Kaffee",
              remoteName: "Bistro",
              remoteIdentifier: "DE99",
              bankReference: "REF-001",
            },
          ]),
        ),
        getAccountBalance: vi.fn(async () =>
          balResp({
            date: new Date("2026-04-24T06:00:00Z"),
            currency: "EUR",
            balance: 2341.5,
          }),
        ),
      },
    );

    const result = await runFetchAccounts(c);
    expect(result.partial).toBe(false);
    expect(result.accounts).toHaveLength(1);
    const a = result.accounts[0];
    expect(a.accountNumber).toBe("1234567890");
    expect(a.iban).toBe("DE12");
    expect(a.accountKind).toBe("giro");
    expect(a.label).toContain("Max Mustermann");
    expect(a.transactions).toHaveLength(1);
    expect(a.transactions[0]).toMatchObject({
      bookingDate: "2026-04-24",
      amount: "-42.50",
      purpose: "Kaffee",
      counterparty: "Bistro",
      counterpartyIban: "DE99",
      fintsId: "REF-001",
    });
    expect(a.balance).toEqual({
      asOf: "2026-04-24",
      amount: "2341.50",
      currency: "EUR",
    });
    expect(a.errors).toEqual([]);
  });

  it("maps multiple accounts in sequence", async () => {
    const c = clientWith(
      [
        { accountNumber: "A", accountType: "CheckingAccount", currency: "EUR" },
        { accountNumber: "B", accountType: "SavingsAccount", currency: "EUR" },
      ],
      {
        getAccountStatements: vi.fn(async () => stmtResp([])),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 0 }),
        ),
      },
    );
    const r = await runFetchAccounts(c);
    expect(r.accounts.map((a) => a.accountNumber)).toEqual(["A", "B"]);
    expect(r.accounts[1].accountKind).toBe("tagesgeld");
  });

  it("returns an empty result when the bank has no accounts yet", async () => {
    const c = clientWith([]);
    const r = await runFetchAccounts(c);
    expect(r.accounts).toEqual([]);
    expect(r.partial).toBe(false);
  });
});

describe("runFetchAccounts — mid-flight TAN and bank errors", () => {
  it("records a soft error and sets partial=true when statements need TAN", async () => {
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () =>
          stmtResp([], { requiresTan: true, success: true }),
        ),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 10 }),
        ),
      },
    );
    const r = await runFetchAccounts(c);
    expect(r.partial).toBe(true);
    expect(r.accounts[0].errors).toContain("statements-tan-required");
    expect(r.accounts[0].transactions).toEqual([]);
    // Balance still tried
    expect(r.accounts[0].balance?.amount).toBe("10.00");
  });

  it("records a soft error on a bank-side statement failure", async () => {
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => ({
          success: false,
          requiresTan: false,
          bankAnswers: [{ code: 9050, text: "nicht verfügbar" }],
          statements: [],
        })),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 0 }),
        ),
      },
    );
    const r = await runFetchAccounts(c);
    expect(r.accounts[0].errors[0]).toMatch(/statements-error:9050/);
  });

  it("swallows a thrown exception from getAccountBalance and keeps going", async () => {
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => stmtResp([])),
        getAccountBalance: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    );
    const r = await runFetchAccounts(c);
    expect(r.accounts[0].errors.some((e) => /balance-exception/.test(e))).toBe(true);
    expect(r.accounts[0].balance).toBeNull();
  });
});

describe("runFetchAccounts — integrates with runSynchronize", () => {
  it("runSynchronize exposes the live client on state=idle so callers can fetch", async () => {
    const c = mockClient({ success: true, requiresTan: false }, {
      systemId: "sys",
      upd: {
        bankAccounts: [
          { accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" },
        ],
      },
    } as any);
    (c.getAccountStatements as any) = vi.fn(async () => stmtResp([]));
    (c.getAccountBalance as any) = vi.fn(async () =>
      balResp({ date: new Date(), currency: "EUR", balance: 0 }),
    );

    const id = await insertBankcontact();
    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });
    expect(result.state).toBe("idle");
    expect(result.client).toBeDefined();

    const fetched = await runFetchAccounts(result.client as FintsClientSurface);
    expect(fetched.accounts).toHaveLength(1);
  });
});

// ======================================================================
// probeTanMethods — first-sync TAN method lookup for the UI picker
// ======================================================================

describe("fints-client — probeTanMethods", () => {
  it("returns ok + the bank's available TAN methods after a successful first sync", async () => {
    const id = await insertBankcontact();
    const c = mockClient(
      { success: true, requiresTan: false },
      { systemId: "sys-probe" },
      [
        { id: 942, name: "pushTAN", isDecoupled: true },
        { id: 910, name: "chipTAN", isDecoupled: false },
      ],
    );

    const result = await probeTanMethods(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("ok");
    expect(result.methods).toEqual([
      { id: 942, name: "pushTAN", isDecoupled: true },
      { id: 910, name: "chipTAN", isDecoupled: false },
    ]);
    // Only one sync — the probe never reaches the UPD step.
    expect(c.synchronize).toHaveBeenCalledTimes(1);
    expect(c.selectTanMethod).not.toHaveBeenCalled();
  });

  it("returns state=tan-required when the first sync itself demands a TAN", async () => {
    const id = await insertBankcontact();
    const c = mockClient(
      {
        success: true,
        requiresTan: true,
        tanChallenge: "Bitte bestätigen",
        tanReference: "pre-probe-tan",
      },
      { systemId: "sys" },
      [],
    );

    const result = await probeTanMethods(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("tan-required");
    expect(result.errorCode).toBe("tan-before-probe");
    expect(result.methods).toBeUndefined();
  });

  it("maps a failing first sync to state=error with the bank's code", async () => {
    const id = await insertBankcontact();
    const c = mockClient(
      {
        success: false,
        requiresTan: false,
        bankAnswers: [{ code: 9010, text: "Login fehlgeschlagen" }],
      },
      { systemId: "sys" },
      [],
    );

    const result = await probeTanMethods(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("9010");
    expect(result.errorMessage).toBe("Login fehlgeschlagen");
  });

  it("retries transport errors up to 2 times before returning error state", async () => {
    const id = await insertBankcontact();
    const sleep = vi.fn(async (_ms: number) => {});
    const factory = vi.fn(() => {
      const c = mockClient({ success: true, requiresTan: false }, {}, []);
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      return c;
    });

    const result = await probeTanMethods(id, { clientFactory: factory, sleep });

    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("transport");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws notFound when the bankcontact id does not exist", async () => {
    await expect(
      probeTanMethods(999_999, {
        clientFactory: () => mockClient({ success: true, requiresTan: false }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/not found/);
  });
});
