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
import { eq, sql } from "drizzle-orm";
import {
  __resetFintsClientCacheForTests,
  evictCachedClient,
  probeTanMethods,
  resumeFetchAfterTan,
  runSynchronize,
  type FintsClientSurface,
} from "./fints-client";
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
  __resetFintsClientCacheForTests();
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
    tanPhoto?: { mimeType: string; image: Uint8Array };
    bankAnswers?: Array<{ code: number; text: string }>;
  },
  bankingInformation: Record<string, unknown> = { systemId: "sys-1" },
  // Default matches the default tan_method "942" on insertBankcontact;
  // tests that exercise unknown-method branches override with []. The
  // default entry is NOT decoupled so the existing coupled-flow tests
  // keep their previous behaviour (UI-side TAN dialog).
  availableTanMethods: Array<{
    id: number;
    name: string;
    isDecoupled: boolean;
    decoupled?: {
      maxStatusRequests: number;
      waitingSecondsBeforeFirstStatusRequest: number;
      waitingSecondsBetweenStatusRequests: number;
    };
  }> = [{ id: 942, name: "pushTAN", isDecoupled: false }],
): FintsClientSurface {
  const resp = { bankAnswers: [], ...response };
  const config: any = { bankingInformation, availableTanMethods };
  return {
    synchronize: vi.fn(async () => resp as any),
    synchronizeWithTan: vi.fn(async () => resp as any),
    // Mirrors lib-fints: setting selectedTanMethod from
    // availableTanMethods lets the polling check work in tests.
    selectTanMethod: vi.fn((id: number) => {
      config.selectedTanMethod = availableTanMethods.find((m) => m.id === id);
    }),
    config,
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

  it("base64-encodes the lib-fints photoTAN bytes for JSON transport", async () => {
    const id = await insertBankcontact();
    // PNG header bytes — arbitrary, just need a non-trivial payload.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runSynchronize(id, {
      clientFactory: () =>
        mockClient({
          success: true,
          requiresTan: true,
          tanChallenge: "PhotoTAN scannen",
          tanReference: "ref-photo",
          tanMediaName: "PhotoTAN",
          tanPhoto: { mimeType: "image/png", image: pngBytes },
        }),
      sleep: async () => {},
    });
    expect(result.state).toBe("tan-required");
    expect(result.tanPhotoMime).toBe("image/png");
    expect(result.tanPhotoBase64).toBe(
      Buffer.from(pngBytes).toString("base64"),
    );
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

describe("fints-client — decoupled TAN polling", () => {
  // Helper: a client whose 2nd synchronize() returns requiresTan=true
  // and whose synchronizeWithTan() transitions to success after `n`
  // polls. Exercises the bank-approves-eventually path.
  function decoupledClient(
    approveAfterPolls: number,
  ): FintsClientSurface {
    const availableTanMethods = [
      {
        id: 942,
        name: "pushTAN",
        isDecoupled: true,
        decoupled: {
          maxStatusRequests: 10,
          waitingSecondsBeforeFirstStatusRequest: 2,
          waitingSecondsBetweenStatusRequests: 3,
        },
      },
    ];
    const config: any = {
      bankingInformation: { systemId: "sys-decoupled" },
      availableTanMethods,
    };
    let syncCalls = 0;
    let pollCalls = 0;
    return {
      synchronize: vi.fn(async () => {
        syncCalls++;
        // first sync → BPD (success, no TAN); second sync → TAN required.
        if (syncCalls === 1) {
          return { success: true, requiresTan: false, bankAnswers: [] } as any;
        }
        return {
          success: true,
          requiresTan: true,
          tanReference: "decoupled-ref",
          bankAnswers: [],
        } as any;
      }),
      synchronizeWithTan: vi.fn(async () => {
        pollCalls++;
        if (pollCalls >= approveAfterPolls) {
          return { success: true, requiresTan: false, bankAnswers: [] } as any;
        }
        return {
          success: true,
          requiresTan: true,
          tanReference: "decoupled-ref",
          bankAnswers: [],
        } as any;
      }),
      selectTanMethod: vi.fn((id: number) => {
        config.selectedTanMethod = availableTanMethods.find((m) => m.id === id);
      }),
      config,
      getAccountStatements: vi.fn(),
      getAccountStatementsWithTan: vi.fn(),
      getAccountBalance: vi.fn(),
      getAccountBalanceWithTan: vi.fn(),
    };
  }

  it("polls synchronizeWithTan(ref) until the bank approves, then returns state=idle", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const sleep = vi.fn(async (_ms: number) => {});
    // Bank approves on the 3rd status-check call.
    const c = decoupledClient(3);

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    expect(result.state).toBe("idle");
    expect(result.client).toBeDefined();
    // Two synchronize() calls: BPD + UPD.
    expect(c.synchronize).toHaveBeenCalledTimes(2);
    // Three poll calls until approval.
    expect(c.synchronizeWithTan).toHaveBeenCalledTimes(3);
    // TAN argument must be omitted — bank is authenticating via the
    // decoupled channel, not a user-typed code.
    expect(vi.mocked(c.synchronizeWithTan).mock.calls[0][1]).toBeUndefined();
    // Cadence honoured: 1× before-first (2s) + 2× between-requests (3s).
    // Exact sleep calls: one 2000ms + N-1 of 3000ms where N=3.
    const sleepMs = sleep.mock.calls.map((c) => c[0]);
    expect(sleepMs.filter((ms) => ms === 2000)).toHaveLength(1);
    expect(sleepMs.filter((ms) => ms === 3000)).toHaveLength(2);
  });

  it("returns state=tan-required when the user never approves (maxStatusRequests exhausted)", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const sleep = vi.fn(async (_ms: number) => {});
    // Approval would only ever come on the 100th attempt → never
    // within the 10-request budget.
    const c = decoupledClient(100);

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    expect(result.state).toBe("tan-required");
    // Full budget spent: one before-first sleep + 9 between-request
    // sleeps + 10 polls.
    expect(c.synchronizeWithTan).toHaveBeenCalledTimes(10);
  });

  it("does NOT poll coupled TAN methods — chipTAN etc. still flow through the UI", async () => {
    const id = await insertBankcontact({ tan_method: "910" });
    const sleep = vi.fn(async (_ms: number) => {});
    const availableTanMethods = [
      { id: 910, name: "chipTAN", isDecoupled: false },
    ];
    const config: any = {
      bankingInformation: { systemId: "sys-coupled" },
      availableTanMethods,
    };
    let syncCalls = 0;
    const c: FintsClientSurface = {
      synchronize: vi.fn(async () => {
        syncCalls++;
        if (syncCalls === 1) {
          return { success: true, requiresTan: false, bankAnswers: [] } as any;
        }
        return {
          success: true,
          requiresTan: true,
          tanReference: "coupled-ref",
          tanChallenge: "Karte einlegen",
          bankAnswers: [],
        } as any;
      }),
      synchronizeWithTan: vi.fn(),
      selectTanMethod: vi.fn((id: number) => {
        config.selectedTanMethod = availableTanMethods.find((m) => m.id === id);
      }),
      config,
      getAccountStatements: vi.fn(),
      getAccountStatementsWithTan: vi.fn(),
      getAccountBalance: vi.fn(),
      getAccountBalanceWithTan: vi.fn(),
    };

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    expect(result.state).toBe("tan-required");
    expect(result.tanChallenge).toBe("Karte einlegen");
    expect(c.synchronizeWithTan).not.toHaveBeenCalled();
  });
});

describe("fints-client — no retry after the bank has seen a TAN request", () => {
  // Regression for the "zwei Push-Nachrichten bei Sync"-bug: a
  // transport error during phase (b) (selectTanMethod → second
  // synchronize() → decoupled poll) must NEVER cause the retry
  // loop to rebuild a fresh FinTSConfig.forFirstTimeUse and fire
  // a second TAN push at the bank.
  it("returns state=error without re-building the dialog when the UPD sync throws", async () => {
    const id = await insertBankcontact({ tan_method: "946" });
    const sleep = vi.fn(async (_ms: number) => {});
    const availableTanMethods = [
      { id: 946, name: "pushTAN 2.0", isDecoupled: true, decoupled: {
        maxStatusRequests: 5,
        waitingSecondsBeforeFirstStatusRequest: 1,
        waitingSecondsBetweenStatusRequests: 1,
      } },
    ];
    const config: any = {
      bankingInformation: { systemId: "sys-1" },
      availableTanMethods,
    };
    let constructorCalls = 0;
    let bpdCalls = 0;
    let updCalls = 0;
    const factory = () => {
      constructorCalls++;
      let seenBpd = false;
      return {
        synchronize: vi.fn(async () => {
          if (!seenBpd) {
            seenBpd = true;
            bpdCalls++;
            return { success: true, requiresTan: false, bankAnswers: [] } as any;
          }
          updCalls++;
          throw new Error("ECONNRESET (mid-dialog)");
        }),
        synchronizeWithTan: vi.fn(),
        selectTanMethod: vi.fn((id: number) => {
          config.selectedTanMethod = availableTanMethods.find((m) => m.id === id);
        }),
        config,
        getAccountStatements: vi.fn(),
        getAccountStatementsWithTan: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountBalanceWithTan: vi.fn(),
      } as FintsClientSurface;
    };

    const result = await runSynchronize(id, {
      clientFactory: factory,
      sleep,
    });

    // Error surfaced (no-retry), with a distinct code so operators
    // can tell this apart from "bank unreachable from the start".
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("post-first-sync-transport");

    // The crucial assertions: the FinTSConfig was built exactly
    // ONCE, BPD synchronize() ran ONCE — i.e. no second dialog,
    // no second TAN push.
    expect(constructorCalls).toBe(1);
    expect(bpdCalls).toBe(1);
    expect(updCalls).toBe(1);
  });
});

describe("fints-client — warm-start path (cached bankingInformation)", () => {
  // Cached BI on the bankcontact must:
  //   - take the warm path (single synchronize() via fromBankingInformation),
  //   - never call forFirstTimeUse,
  //   - persist the updated BI back to the bankcontact on success.
  it("uses fromBankingInformation and a single sync when BI is cached", async () => {
    const id = await insertBankcontact({
      tan_method: "942",
      banking_information: { systemId: "cached-sys" } as any,
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = mockClient(
      { success: true, requiresTan: false },
      { systemId: "cached-sys-updated" },
    );

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    expect(result.state).toBe("idle");
    // Single sync — no second call, no selectTanMethod (the method id
    // is baked into the config via fromBankingInformation).
    expect(c.synchronize).toHaveBeenCalledTimes(1);
    expect(c.selectTanMethod).not.toHaveBeenCalled();
    // Updated BI was written back to the row.
    const [row] = await db
      .select({ bi: financeBankcontact.banking_information })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id));
    expect(row.bi).toEqual({ systemId: "cached-sys-updated" });
  });

  it("falls back to the cold path when the warm sync errors out (e.g. stale systemId)", async () => {
    const id = await insertBankcontact({
      tan_method: "942",
      banking_information: { systemId: "stale" } as any,
    });
    const sleep = vi.fn(async (_ms: number) => {});

    let callsOnFreshClient = 0;
    let callsOnWarmClient = 0;
    const factory = vi.fn(() => {
      // First factory call → warm client (errors), subsequent calls →
      // cold client (succeeds for both BPD and UPD).
      const isWarm = callsOnWarmClient === 0 && factory.mock.calls.length === 1;
      const c = mockClient({ success: true, requiresTan: false });
      if (isWarm) {
        (c.synchronize as any).mockImplementation(async () => {
          callsOnWarmClient++;
          return { success: false, requiresTan: false, bankAnswers: [] } as any;
        });
      } else {
        (c.synchronize as any).mockImplementation(async () => {
          callsOnFreshClient++;
          return { success: true, requiresTan: false, bankAnswers: [] } as any;
        });
      }
      return c;
    });

    const result = await runSynchronize(id, {
      clientFactory: factory,
      sleep,
    });

    expect(result.state).toBe("idle");
    // Two FinTSClient instances total: warm (errored) + cold (BPD+UPD
    // share the same client).
    expect(factory).toHaveBeenCalledTimes(2);
    expect(callsOnWarmClient).toBe(1);
    // Cold path runs BPD then UPD on the *same* client.
    expect(callsOnFreshClient).toBe(2);
  });

  it("falls back to the cold path when the warm sync throws (transport error)", async () => {
    const id = await insertBankcontact({
      tan_method: "942",
      banking_information: { systemId: "stale" } as any,
    });
    const sleep = vi.fn(async (_ms: number) => {});
    let factoryCalls = 0;

    const factory = vi.fn(() => {
      factoryCalls++;
      const c = mockClient({ success: true, requiresTan: false });
      if (factoryCalls === 1) {
        // Warm attempt throws — should be caught and fall through.
        (c.synchronize as any).mockRejectedValueOnce(new Error("ECONNRESET"));
      }
      return c;
    });

    const result = await runSynchronize(id, {
      clientFactory: factory,
      sleep,
    });

    expect(result.state).toBe("idle");
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
  });

  it("does NOT take the warm path when only banking_information is cached but tan_method is missing", async () => {
    const id = await insertBankcontact({
      tan_method: null,
      banking_information: { systemId: "cached" } as any,
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = mockClient({ success: true, requiresTan: false });

    const result = await runSynchronize(id, {
      clientFactory: () => c,
      sleep,
    });

    // Cold path takes BPD-sync but bails at "no-tan-method" before the
    // second sync.
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("no-tan-method");
    expect(c.synchronize).toHaveBeenCalledTimes(1);
  });

  it("persists BI after a successful resume too (TAN-complete path)", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient(
      { success: true, requiresTan: false },
      { systemId: "post-tan-sys" },
    );

    await runSynchronize(id, {
      tanReference: "tanref-xyz",
      tanAnswer: "123456",
      bankingInformation: { systemId: "saved-during-init" },
      clientFactory: () => c,
      sleep: async () => {},
    });

    const [row] = await db
      .select({ bi: financeBankcontact.banking_information })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id));
    expect(row.bi).toEqual({ systemId: "post-tan-sys" });
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
      bankRef: "REF-001",
    });
    expect(a.balance).toEqual({
      asOf: "2026-04-24",
      amount: "2341.50",
      currency: "EUR",
    });
    expect(a.errors).toEqual([]);
  });

  it("prioritizes remoteIdentifier but falls back to remoteAccountNumber for counterpartyIban", async () => {
    const c = clientWith(
      [
        {
          accountNumber: "1234567890",
          accountType: "CheckingAccount",
          currency: "EUR",
        },
      ],
      {
        getAccountStatements: vi.fn(async () =>
          stmtResp([
            {
              entryDate: new Date("2026-04-24"),
              amount: -10,
              purpose: "With remoteAccountNumber",
              remoteName: "Account Owner",
              remoteAccountNumber: "ACCOUNT123",
            },
            {
              entryDate: new Date("2026-04-24"),
              amount: -20,
              purpose: "With both",
              remoteName: "Both",
              remoteIdentifier: "IBAN999",
              remoteAccountNumber: "ACCOUNT999",
            },
          ]),
        ),
        getAccountBalance: vi.fn(async () => balResp(null)),
      },
    );

    const result = await runFetchAccounts(c);
    const txs = result.accounts[0].transactions;

    expect(txs[0].counterpartyIban).toBe("ACCOUNT123");
    expect(txs[1].counterpartyIban).toBe("IBAN999");
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
  it("returns pendingTan and stops the loop when statements need TAN", async () => {
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => ({
          ...stmtResp([], { requiresTan: true, success: true }),
          tanReference: "needs-tan-1",
          tanChallenge: "Bitte bestätigen",
        })),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 10 }),
        ),
      },
    );
    const r = await runFetchAccounts(c);
    expect(r.partial).toBe(true);
    expect(r.pendingTan).toBeDefined();
    expect(r.pendingTan?.tanReference).toBe("needs-tan-1");
    expect(r.pendingTan?.accountNumber).toBe("1");
    expect(r.pendingTan?.remainingAccountNumbers).toEqual([]);
    expect(r.accounts[0].transactions).toEqual([]);
    // Balance not attempted — the loop pauses on the statements TAN
    // and the resume path fetches balance after the user submits.
    expect(r.accounts[0].balance).toBeNull();
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

describe("runFetchAccounts — decoupled TAN per account", () => {
  function decoupledMethod() {
    return {
      id: 942,
      name: "pushTAN",
      isDecoupled: true,
      decoupled: {
        maxStatusRequests: 5,
        waitingSecondsBeforeFirstStatusRequest: 1,
        waitingSecondsBetweenStatusRequests: 1,
      },
    };
  }

  it("polls getAccountStatementsWithTan when the statement query needs SCA — succeeds after N polls", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => ({
          success: true,
          requiresTan: true,
          tanReference: "stmt-tan-1",
          bankAnswers: [],
          statements: [],
        })),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 100 }),
        ),
      },
    );
    // Pretend selectTanMethod was already called earlier — surface
    // the decoupled method on the config.
    (c.config as any).selectedTanMethod = decoupledMethod();

    let pollCount = 0;
    (c.getAccountStatementsWithTan as any) = vi.fn(async () => {
      pollCount++;
      if (pollCount >= 3) {
        return stmtResp([
          {
            valueDate: new Date("2026-04-01"),
            entryDate: new Date("2026-04-01"),
            amount: -10,
            purpose: "x",
            remoteName: "y",
          },
        ]);
      }
      return {
        success: true,
        requiresTan: true,
        tanReference: "stmt-tan-1",
        bankAnswers: [],
        statements: [],
      };
    });

    const r = await runFetchAccounts(c, sleep);

    expect(r.partial).toBe(false);
    expect(r.accounts[0].errors).not.toContain("statements-tan-required");
    expect(r.accounts[0].transactions).toHaveLength(1);
    // balance still ran fine without TAN
    expect(r.accounts[0].balance?.amount).toBe("100.00");
    expect(c.getAccountStatementsWithTan).toHaveBeenCalledTimes(3);
    // Cadence honoured: one before-first sleep + 2 between-requests.
    expect(sleep).toHaveBeenCalled();
  });

  it("polls getAccountBalanceWithTan when the balance query needs SCA", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => stmtResp([])),
        getAccountBalance: vi.fn(async () => ({
          success: true,
          requiresTan: true,
          tanReference: "bal-tan-1",
          bankAnswers: [],
        })),
      },
    );
    (c.config as any).selectedTanMethod = decoupledMethod();
    (c.getAccountBalanceWithTan as any) = vi.fn(async () =>
      balResp({ date: new Date(), currency: "EUR", balance: 250 }),
    );

    const r = await runFetchAccounts(c, sleep);

    expect(r.accounts[0].errors).not.toContain("balance-tan-required");
    expect(r.accounts[0].balance?.amount).toBe("250.00");
    expect(c.getAccountBalanceWithTan).toHaveBeenCalled();
  });

  it("falls through to a soft error when the decoupled budget is exhausted without approval", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => ({
          success: true,
          requiresTan: true,
          tanReference: "stmt-tan-1",
          bankAnswers: [],
          statements: [],
        })),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 1 }),
        ),
      },
    );
    (c.config as any).selectedTanMethod = decoupledMethod();
    // Always returns requiresTan=true → poll exhausts.
    (c.getAccountStatementsWithTan as any) = vi.fn(async () => ({
      success: true,
      requiresTan: true,
      tanReference: "stmt-tan-1",
      bankAnswers: [],
      statements: [],
    }));

    const r = await runFetchAccounts(c, sleep);

    // After 5 polls the response still has requiresTan=true with a
    // tanReference, which now bubbles up as pendingTan instead of a
    // soft error — the UI gets a second chance to enter a TAN.
    expect(r.partial).toBe(true);
    expect(r.pendingTan?.tanReference).toBe("stmt-tan-1");
    // Used the full budget (5 polls).
    expect(c.getAccountStatementsWithTan).toHaveBeenCalledTimes(5);
  });

  it("does NOT poll for coupled methods (chipTAN etc.) — bubbles as pendingTan", async () => {
    const c = clientWith(
      [{ accountNumber: "1", accountType: "CheckingAccount", currency: "EUR" }],
      {
        getAccountStatements: vi.fn(async () => ({
          success: true,
          requiresTan: true,
          tanReference: "stmt-tan-1",
          bankAnswers: [],
          statements: [],
        })),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 1 }),
        ),
      },
    );
    // Coupled method → no decoupled.* — pollDecoupled returns the
    // initial response unchanged.
    (c.config as any).selectedTanMethod = {
      id: 910,
      name: "chipTAN",
      isDecoupled: false,
    };

    const r = await runFetchAccounts(c);

    // Coupled method → no polling, but the loop pauses so the UI
    // can collect the TAN.
    expect(c.getAccountStatementsWithTan).not.toHaveBeenCalled();
    expect(r.pendingTan?.tanReference).toBe("stmt-tan-1");
    expect(r.partial).toBe(true);
  });
});

describe("runFetchAccounts — linked-only filter", () => {
  // Each unlinked bank-side account previously triggered its own
  // getAccountStatements call — and on a PSD2-strict bank that means
  // a per-account SCA push at the user's phone for an account they
  // don't even use. The linkedAccountNumbers Set short-circuits
  // those.
  it("only calls getAccountStatements / getAccountBalance for linked accounts", async () => {
    const c = clientWith([
      { accountNumber: "LINKED", accountType: "CheckingAccount", currency: "EUR" },
      { accountNumber: "OTHER-1", accountType: "SavingsAccount", currency: "EUR" },
      { accountNumber: "OTHER-2", accountType: "FixedDepositAccount", currency: "EUR" },
    ], {
      getAccountStatements: vi.fn(async () => stmtResp([])),
      getAccountBalance: vi.fn(async () =>
        balResp({ date: new Date(), currency: "EUR", balance: 1 }),
      ),
    });

    const r = await runFetchAccounts(c, {
      linkedAccountNumbers: new Set(["LINKED"]),
    });

    expect(r.accounts).toHaveLength(3);
    // LINKED got its statements + balance call.
    expect(c.getAccountStatements).toHaveBeenCalledTimes(1);
    expect(c.getAccountStatements).toHaveBeenCalledWith("LINKED");
    expect(c.getAccountBalance).toHaveBeenCalledTimes(1);
    expect(c.getAccountBalance).toHaveBeenCalledWith("LINKED");
    // OTHER-1 and OTHER-2 still appear in the result (so the UI's
    // pending block can offer them as imports), but with empty data.
    const others = r.accounts.filter((a) => a.accountNumber !== "LINKED");
    expect(others).toHaveLength(2);
    for (const o of others) {
      expect(o.transactions).toEqual([]);
      expect(o.balance).toBeNull();
      expect(o.errors).toEqual([]);
    }
    // The error-free unlinked accounts must NOT count as partial.
    expect(r.partial).toBe(false);
  });

  it("deduplicates bank-side accounts that share an accountNumber (e.g. comdirect giro + Visa sub-account)", async () => {
    // Comdirect's UPD response can list the same accountNumber twice
    // with different subAccountIds — without dedup we'd fire two
    // identical getAccountStatements / getAccountBalance calls and
    // trigger two SCA pushes for the same data.
    const c = clientWith(
      [
        { accountNumber: "401873500", accountType: "CheckingAccount", currency: "EUR" },
        { accountNumber: "401873505", accountType: "CheckingAccount", currency: "EUR" },
        // Duplicate of the first — different subAccountId in real life.
        { accountNumber: "401873500", accountType: "CheckingAccount", currency: "EUR" },
      ],
      {
        getAccountStatements: vi.fn(async () => stmtResp([])),
        getAccountBalance: vi.fn(async () =>
          balResp({ date: new Date(), currency: "EUR", balance: 1 }),
        ),
      },
    );

    const r = await runFetchAccounts(c, {
      linkedAccountNumbers: new Set(["401873500", "401873505"]),
    });

    // Two unique accountNumbers → two snapshots, two stmt calls.
    expect(r.accounts).toHaveLength(2);
    expect(c.getAccountStatements).toHaveBeenCalledTimes(2);
    expect(c.getAccountStatements).toHaveBeenCalledWith("401873500");
    expect(c.getAccountStatements).toHaveBeenCalledWith("401873505");
    expect(c.getAccountBalance).toHaveBeenCalledTimes(2);
  });

  it("falls back to all-accounts when linkedAccountNumbers is omitted", async () => {
    const c = clientWith([
      { accountNumber: "A", accountType: "CheckingAccount", currency: "EUR" },
      { accountNumber: "B", accountType: "SavingsAccount", currency: "EUR" },
    ], {
      getAccountStatements: vi.fn(async () => stmtResp([])),
      getAccountBalance: vi.fn(async () =>
        balResp({ date: new Date(), currency: "EUR", balance: 1 }),
      ),
    });

    await runFetchAccounts(c);

    expect(c.getAccountStatements).toHaveBeenCalledTimes(2);
    expect(c.getAccountBalance).toHaveBeenCalledTimes(2);
  });
});

describe("resumeFetchAfterTan — mid-fetch coupled-TAN resume", () => {
  it("continues the paused statements call after the user's TAN, fetches balance, then iterates the queue", async () => {
    const upd = {
      bankAccounts: [
        { accountNumber: "A", accountType: "CheckingAccount", currency: "EUR", holder1: "u" },
        { accountNumber: "B", accountType: "CheckingAccount", currency: "EUR", holder1: "u" },
        { accountNumber: "C", accountType: "CheckingAccount", currency: "EUR", holder1: "u" },
      ],
    };
    const c = mockClient({ success: true, requiresTan: false }, {
      systemId: "s",
      upd,
    } as any);

    let stmtTanCalls = 0;
    (c.getAccountStatementsWithTan as any) = vi.fn(async (_ref: string, _tan?: string) => {
      stmtTanCalls++;
      return stmtResp([
        {
          valueDate: new Date("2026-04-01"),
          entryDate: new Date("2026-04-01"),
          amount: -10,
          purpose: "x",
          remoteName: "y",
        },
      ]);
    });
    (c.getAccountStatements as any) = vi.fn(async () => stmtResp([]));
    (c.getAccountBalance as any) = vi.fn(async () =>
      balResp({ date: new Date(), currency: "EUR", balance: 42 }),
    );

    const result = await resumeFetchAfterTan(c, {
      tanReference: "ref-A",
      tan: "123456",
      currentAccountNumber: "A",
      remainingAccountNumbers: ["B", "C"],
    });

    expect(result.pendingTan).toBeUndefined();
    expect(result.accounts).toHaveLength(3);
    // The resumed account got its TAN-continued statements.
    expect(c.getAccountStatementsWithTan).toHaveBeenCalledWith("ref-A", "123456");
    expect(stmtTanCalls).toBe(1);
    expect(result.accounts[0].accountNumber).toBe("A");
    expect(result.accounts[0].transactions).toHaveLength(1);
    // B and C ran through getAccountStatements normally.
    expect(c.getAccountStatements).toHaveBeenCalledTimes(2);
    expect(result.accounts[1].accountNumber).toBe("B");
    expect(result.accounts[2].accountNumber).toBe("C");
  });

  it("re-pends with a fresh challenge when the bank rejects the submitted TAN", async () => {
    const upd = {
      bankAccounts: [
        { accountNumber: "A", accountType: "CheckingAccount", currency: "EUR", holder1: "u" },
      ],
    };
    const c = mockClient({ success: true, requiresTan: false }, {
      systemId: "s",
      upd,
    } as any);

    (c.getAccountStatementsWithTan as any) = vi.fn(async () => ({
      success: true,
      requiresTan: true,
      tanReference: "ref-A-2",
      tanChallenge: "Falsche TAN, bitte erneut",
      bankAnswers: [],
      statements: [],
    }));

    const result = await resumeFetchAfterTan(c, {
      tanReference: "ref-A",
      tan: "wrong",
      currentAccountNumber: "A",
      remainingAccountNumbers: [],
    });

    expect(result.pendingTan?.tanReference).toBe("ref-A-2");
    expect(result.pendingTan?.tanChallenge).toBe("Falsche TAN, bitte erneut");
    expect(result.pendingTan?.accountNumber).toBe("A");
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

describe("fints-client — in-memory client cache (hot path)", () => {
  // The hot path mirrors Finanzkraft's #fintsInstance singleton:
  // once a sync has succeeded we keep the live FinTSClient around and
  // hand it back on the next runSynchronize without re-issuing a
  // synchronize() call. The bank sees a continuing dialog → no fresh
  // SCA push for read-only ops within PSD2's 90-day window.

  it("the second sync returns the same cached client without a fresh synchronize()", async () => {
    const id = await insertBankcontact({
      tan_method: "942",
      banking_information: { systemId: "cached" } as any,
    });
    const c = mockClient({ success: true, requiresTan: false });

    // First call: factory injected, warm path runs → cache populated.
    const first = await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });
    expect(first.state).toBe("idle");
    expect(c.synchronize).toHaveBeenCalledTimes(1);

    // Second call: NO factory. The default lib-fints factory in the
    // module mock would throw on synchronize() ("not used — factory
    // override"), so a successful return *proves* the hot path
    // returned the cached client without calling synchronize() at all.
    const second = await runSynchronize(id);
    expect(second.state).toBe("idle");
    expect(second.client).toBe(c);
    expect(c.synchronize).toHaveBeenCalledTimes(1);
  });

  it("PIN change evicts the cached client", async () => {
    const id = await insertBankcontact({
      tan_method: "942",
      banking_information: { systemId: "cached" } as any,
    });
    const c = mockClient({ success: true, requiresTan: false });
    await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    // Simulate the side-effect of setBankcontactCredentials.
    evictCachedClient(id);

    // Without the cache the second call falls back to the warm path,
    // which needs a factory in tests (otherwise the lib-fints mock
    // throws). Provide one again — the assertion is that the new
    // client is exercised, i.e. cache was indeed evicted.
    const c2 = mockClient({ success: true, requiresTan: false });
    const result = await runSynchronize(id, {
      clientFactory: () => c2,
      sleep: async () => {},
    });
    expect(result.state).toBe("idle");
    expect(c2.synchronize).toHaveBeenCalledTimes(1);
    expect(result.client).toBe(c2);
  });

  it("does NOT use the cache for the resume path (TAN was just typed)", async () => {
    const id = await insertBankcontact({ tan_method: "942" });
    const c = mockClient({ success: true, requiresTan: false });
    // Pre-populate the cache by running a fresh sync.
    await runSynchronize(id, {
      clientFactory: () => c,
      sleep: async () => {},
    });

    // A resume call must never short-circuit on the hot path — the
    // user just typed a TAN and supplied an explicit
    // bankingInformation that may differ from the cache.
    const c2 = mockClient({ success: true, requiresTan: false });
    const resumed = await runSynchronize(id, {
      tanReference: "ref",
      tanAnswer: "111",
      bankingInformation: { systemId: "from-tan-session" },
      clientFactory: () => c2,
      sleep: async () => {},
    });
    expect(resumed.state).toBe("idle");
    expect(c2.synchronizeWithTan).toHaveBeenCalledTimes(1);
    expect(resumed.client).toBe(c2);
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
