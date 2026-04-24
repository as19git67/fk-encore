import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import {
  financeAccount,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
} from "../db/schema";
import {
  createBankcontact,
  deleteBankcontact,
  getBankcontact,
  listBankcontacts,
  setBankcontactCredentials,
  updateBankcontact,
} from "./bankcontacts";
import { decryptWithKey } from "./encryption";

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
  // account → bankcontact FK is RESTRICT, clear accounts first
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
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
  it("deletes a bankcontact that has no accounts", async () => {
    withPermission("finance.accounts.manage");
    const created = await createBankcontact({
      name: "to-delete",
      blz: "1",
      login: "u",
      server_url: "https://x",
    });
    const result = await deleteBankcontact({ id: created.id });
    expect(result.deleted).toBe(true);
    await expect(getBankcontact({ id: created.id })).rejects.toThrow();
  });

  it("refuses when accounts reference the bankcontact", async () => {
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
    await db.insert(financeAccount).values({
      bankcontact_id: created.id,
      type_id: type.id,
      currency_code: currency.code,
      account_number: "000001",
      label: "Test",
    });
    await expect(deleteBankcontact({ id: created.id })).rejects.toThrow(
      /delete them first/,
    );
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

// Drizzle's eq() needed for inline use in the credentials test
import { eq } from "drizzle-orm";
