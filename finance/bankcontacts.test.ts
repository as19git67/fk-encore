import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { eq, sql } from "drizzle-orm";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import {
  createBankcontact,
  deleteBankcontact,
  getBankcontact,
  listBankcontacts,
  probeBankcontactTanMethods,
  setBankcontactCredentials,
  updateBankcontact,
} from "./bankcontacts";
import { decryptWithKey } from "./encryption";
import * as fintsClient from "./fints-client";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return {
    ...actual,
    probeTanMethods: vi.fn(),
  };
});

// vitest.setup.ts provides a global mock of encore.dev/config.secret()
// that returns 32 zero-bytes base64 — the same key decryptWithKey uses
// below to verify credentials round-trip through the real Encore
// secret path.
const TEST_KEY = Buffer.alloc(32);

function withPermission(permission: string) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: "1",
    permissions: [permission],
  });
}

function withoutPermission() {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: [] });
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
  vi.mocked(fintsClient.probeTanMethods).mockReset();
  withoutPermission();
});

describe("finance/bankcontacts — create", () => {
  it("creates a bankcontact and returns the view (without credentials)", async () => {
    withPermission("finance.accounts.manage");
    const result = await createBankcontact({
      name: "Sparkasse Test",
      blz: "12345678",
      login: "user-42",
      server_url: "https://hbci.test/fints",
    });
    expect(result.id).toBeGreaterThan(0);
    expect(result.name).toBe("Sparkasse Test");
    expect(result.credentials_set).toBe(false);
    expect(result.tan_method).toBeNull();
    expect(result.last_sync_at).toBeNull();
    expect((result as any).credentials_encrypted).toBeUndefined();
    expect((result as any).sync_times).toBeUndefined();
  });

  it("trims whitespace from string fields", async () => {
    withPermission("finance.accounts.manage");
    const result = await createBankcontact({
      name: "  Sparkasse  ",
      blz: " 12345678 ",
      login: " user ",
      server_url: " https://x ",
    });
    expect(result.name).toBe("Sparkasse");
    expect(result.blz).toBe("12345678");
  });

  it("rejects empty name", async () => {
    withPermission("finance.accounts.manage");
    await expect(
      createBankcontact({
        name: "   ",
        blz: "12345678",
        login: "u",
        server_url: "https://x",
      }),
    ).rejects.toThrow(/name/);
  });

  it("rejects callers without finance.accounts.manage", async () => {
    await expect(
      createBankcontact({
        name: "x",
        blz: "1",
        login: "u",
        server_url: "https://x",
      }),
    ).rejects.toThrow(/permission/);
  });
});

describe("finance/bankcontacts — list and get", () => {
  it("lists all bankcontacts", async () => {
    withPermission("finance.accounts.manage");
    await createBankcontact({
      name: "A",
      blz: "1",
      login: "u1",
      server_url: "https://a",
    });
    await createBankcontact({
      name: "B",
      blz: "2",
      login: "u2",
      server_url: "https://b",
    });
    const { items } = await listBankcontacts();
    expect(items).toHaveLength(2);
  });

  it("returns a single bankcontact by id", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "Get-Me",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    const fetched = await getBankcontact({ id: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Get-Me");
  });

  it("404s on unknown id", async () => {
    withPermission("finance.accounts.manage");
    await expect(getBankcontact({ id: 999_999 })).rejects.toThrow(/not found/);
  });
});

describe("finance/bankcontacts — update", () => {
  it("patches only the supplied fields", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "Orig",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    const updated = await updateBankcontact({
      id: created.id,
      name: "New",
      tan_method: "942",
    });
    expect(updated.name).toBe("New");
    expect(updated.tan_method).toBe("942");
    expect(updated.blz).toBe("1"); // unchanged
  });

  it("lets tan_method be cleared with explicit null", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
      tan_method: "942",
    });
    const updated = await updateBankcontact({
      id: created.id,
      tan_method: null,
    });
    expect(updated.tan_method).toBeNull();
  });

  it("rejects an empty patch", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    await expect(updateBankcontact({ id: created.id })).rejects.toThrow(
      /no fields/,
    );
  });
});

describe("finance/bankcontacts — delete", () => {
  it("deletes a bankcontact that has no linked accounts", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "to-delete",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    const result = await deleteBankcontact({ id: created.id });
    expect(result).toEqual({ deleted: true, accounts_unlinked: 0 });
    await expect(getBankcontact({ id: created.id })).rejects.toThrow();
  });

  it("unlinks linked accounts instead of deleting them — transactions survive", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "has-accounts",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    const [type] = await db
      .select({ id: financeAccountType.id })
      .from(financeAccountType)
      .limit(1);
    const [currency] = await db
      .select({ code: financeCurrency.code })
      .from(financeCurrency)
      .limit(1);
    const [acc] = await db
      .insert(financeAccount)
      .values({
        bankcontact_id: created.id,
        fints_account_number: "FINTS-001",
        type_id: type.id,
        currency_code: currency.code,
        account_number: "000001",
        label: "Test",
      })
      .returning({ id: financeAccount.id });
    await db.insert(financeTransaction).values({
      account_id: acc.id,
      booking_date: "2026-04-01",
      amount: "-10.00",
      currency_code: currency.code,
      dedupe_hash: "a".repeat(64),
    });

    const result = await deleteBankcontact({ id: created.id });
    expect(result).toEqual({ deleted: true, accounts_unlinked: 1 });

    // Bankcontact is gone, but the account survives as a manual account.
    await expect(getBankcontact({ id: created.id })).rejects.toThrow();
    const [after] = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.id, acc.id));
    expect(after).toBeDefined();
    expect(after.bankcontact_id).toBeNull();
    expect(after.fints_account_number).toBeNull();

    // Transactions survive the unlink.
    const txs = await db
      .select()
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, acc.id));
    expect(txs).toHaveLength(1);
  });
});

describe("finance/bankcontacts — credentials", () => {
  it("encrypts credentials with the active key and persists the blob", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    await setBankcontactCredentials({ id: created.id, pin: "hunter2" });

    const view = await getBankcontact({ id: created.id });
    expect(view.credentials_set).toBe(true);

    // Verify the stored blob really decrypts to the original PIN
    // under the test key (vitest.setup returns 32 zero-bytes).
    const [row] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, created.id));
    expect(row.credentials_encrypted).toBeTruthy();
    expect(decryptWithKey(TEST_KEY, row.credentials_encrypted!)).toBe(
      "hunter2",
    );
  });

  it("clears the cached banking_information when the PIN changes", async () => {
    // The bank's systemId is bound to the credentials/customer combo.
    // After a PIN change the stale BI would only produce wrong-PIN
    // errors on the next warm sync, so setBankcontactCredentials
    // nulls it out.
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    // Pre-seed a cached BI.
    await db
      .update(financeBankcontact)
      .set({ banking_information: { systemId: "to-be-dropped" } as any })
      .where(eq(financeBankcontact.id, created.id));

    await setBankcontactCredentials({ id: created.id, pin: "hunter2" });

    const [row] = await db
      .select({ bi: financeBankcontact.banking_information })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, created.id));
    expect(row.bi).toBeNull();
  });

  it("rejects empty pin", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    await expect(
      setBankcontactCredentials({ id: created.id, pin: "" }),
    ).rejects.toThrow(/pin/);
  });
});

describe("finance/bankcontacts — probe TAN methods", () => {
  async function createdWithCreds(): Promise<number> {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "Sparkasse",
      blz: "12345678",
      login: "u",
      server_url: "https://fints.test",
    });
    await setBankcontactCredentials({ id: created.id, pin: "hunter2" });
    return created.id;
  }

  it("rejects callers without finance.accounts.manage", async () => {
    withoutPermission();
    await expect(
      probeBankcontactTanMethods({ id: 1 }),
    ).rejects.toThrow(/permission/);
    expect(fintsClient.probeTanMethods).not.toHaveBeenCalled();
  });

  it("refuses to probe when the bankcontact has no credentials", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "x",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    await expect(
      probeBankcontactTanMethods({ id: created.id }),
    ).rejects.toThrow(/credentials/);
    expect(fintsClient.probeTanMethods).not.toHaveBeenCalled();
  });

  it("returns the bank's method list on a successful probe", async () => {
    const id = await createdWithCreds();
    vi.mocked(fintsClient.probeTanMethods).mockResolvedValue({
      state: "ok",
      methods: [
        { id: 942, name: "pushTAN", isDecoupled: true },
        { id: 910, name: "chipTAN", isDecoupled: false },
      ],
    });

    const result = await probeBankcontactTanMethods({ id });
    expect(result).toEqual({
      state: "ok",
      methods: [
        { id: 942, name: "pushTAN", isDecoupled: true },
        { id: 910, name: "chipTAN", isDecoupled: false },
      ],
      errorCode: undefined,
      errorMessage: undefined,
    });
    expect(fintsClient.probeTanMethods).toHaveBeenCalledWith(id);
  });

  it("surfaces the error branch verbatim (e.g. wrong PIN)", async () => {
    const id = await createdWithCreds();
    vi.mocked(fintsClient.probeTanMethods).mockResolvedValue({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const result = await probeBankcontactTanMethods({ id });
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("9910");
    expect(result.methods).toBeUndefined();
  });

  it("rate-limits after 10 probes for the same user×bankcontact", async () => {
    const id = await createdWithCreds();
    vi.mocked(fintsClient.probeTanMethods).mockResolvedValue({
      state: "ok",
      methods: [],
    });

    for (let i = 0; i < 10; i++) {
      await probeBankcontactTanMethods({ id });
    }
    await expect(
      probeBankcontactTanMethods({ id }),
    ).rejects.toThrow(/Too many/);
  });
});
