import { describe, it, expect, beforeEach, vi } from "vitest";

import db from "../db/database";
import { financeBankcontact } from "../db/schema";
import { runSynchronize, type FintsClientSurface } from "./fints-client";
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
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Sparkasse Test",
      blz: "12345678",
      login: "user-42",
      server_url: "https://hbci.test/fints",
      tan_method: null,
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
): FintsClientSurface {
  const resp = { bankAnswers: [], ...response };
  return {
    synchronize: vi.fn(async () => resp as any),
    synchronizeWithTan: vi.fn(async () => resp as any),
    selectTanMethod: vi.fn(),
    config: { bankingInformation } as any,
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
});
