import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
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
  createAccount,
  deleteAccount,
  getAccount,
  isAccountClosed,
  linkAccount,
  listAccounts,
  unlinkAccount,
  updateAccount,
} from "./accounts";

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
  setAuth("1", []);
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Sparkasse Test",
      blz: "12345678",
      login: "u",
      server_url: "https://x",
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function anyTypeId(): Promise<number> {
  const [row] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  return row.id;
}

async function insertAccount(bankcontactId: number, label = "Giro"): Promise<number> {
  const typeId = await anyTypeId();
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bankcontactId,
      type_id: typeId,
      currency_code: "EUR",
      account_number: `AN-${label}`,
      label,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function grantAcl(accountId: number, userId: number, level: "read" | "write") {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level,
  });
}

describe("finance/accounts — create (manual)", () => {
  it("creates a manual account (no bankcontact_id) with a write-ACL for the caller", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const result = await createAccount({
      type_kind: "giro",
      currency_code: "EUR",
      iban: "DE12 3456",
      account_number: "1234567890",
      label: "Girokonto",
    });
    expect(result.id).toBeGreaterThan(0);
    expect(result.label).toBe("Girokonto");
    expect(result.type_kind).toBe("giro");
    expect(result.type_label).toBe("Girokonto");
    expect(result.currency_symbol).toBe("€");
    expect(result.bankcontact_id).toBeNull();
    expect(result.bankcontact_name).toBeNull();
    expect(result.fints_account_number).toBeNull();
    expect(result.closed_at).toBeNull();

    const acl = await db
      .select()
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.account_id, result.id));
    expect(acl).toHaveLength(1);
    expect(acl[0].user_id).toBe(1);
    expect(acl[0].level).toBe("write");
  });

  it("creates a bank-linked account when both bankcontact_id and fints_account_number are set", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const bcId = await insertBankcontact();
    const result = await createAccount({
      bankcontact_id: bcId,
      fints_account_number: "1234567890",
      type_kind: "giro",
      currency_code: "EUR",
      account_number: "1234567890",
      label: "Girokonto",
    });
    expect(result.bankcontact_id).toBe(bcId);
    expect(result.bankcontact_name).toBe("Sparkasse Test");
    expect(result.fints_account_number).toBe("1234567890");
  });

  it("rejects bankcontact_id without fints_account_number", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const bcId = await insertBankcontact();
    await expect(
      createAccount({
        bankcontact_id: bcId,
        type_kind: "giro",
        currency_code: "EUR",
        account_number: "1",
        label: "x",
      }),
    ).rejects.toThrow(/fints_account_number/);
  });

  it("rejects unknown type_kind", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    await expect(
      createAccount({
        type_kind: "nonexistent",
        currency_code: "EUR",
        account_number: "1",
        label: "x",
      }),
    ).rejects.toThrow(/account type/);
  });

  it("rejects unknown currency", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    await expect(
      createAccount({
        type_kind: "giro",
        currency_code: "XXX",
        account_number: "1",
        label: "x",
      }),
    ).rejects.toThrow(/currency/);
  });

  it("404s when bankcontact does not exist", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    await expect(
      createAccount({
        bankcontact_id: 999_999,
        fints_account_number: "1",
        type_kind: "giro",
        currency_code: "EUR",
        account_number: "1",
        label: "x",
      }),
    ).rejects.toThrow(/bankcontact/);
  });

  it("rejects callers without finance.accounts.manage", async () => {
    setAuth("1", ["finance.view"]);
    await expect(
      createAccount({
        type_kind: "giro",
        currency_code: "EUR",
        account_number: "1",
        label: "x",
      }),
    ).rejects.toThrow(/permission/);
  });
});

describe("finance/accounts — list (ACL filter)", () => {
  it("returns only accounts the user has an ACL entry for", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId, "A");
    const b = await insertAccount(bcId, "B");
    const c = await insertAccount(bcId, "C");

    setAuth("7", ["finance.view"]);
    await grantAcl(a, 7, "read");
    await grantAcl(c, 7, "write");

    const result = await listAccounts();
    const labels = result.items.map((i) => i.label).sort();
    expect(labels).toEqual(["A", "C"]);
    expect(result.items.map((i) => i.id)).not.toContain(b);
  });

  it("finance.admin bypasses the ACL and sees all accounts", async () => {
    const bcId = await insertBankcontact();
    await insertAccount(bcId, "A");
    await insertAccount(bcId, "B");
    await insertAccount(bcId, "C");

    setAuth("1", ["finance.view", "finance.admin"]);
    // No ACL entries at all
    const result = await listAccounts();
    expect(result.items).toHaveLength(3);
  });

  it("returns an empty list when the user has no ACL entries", async () => {
    const bcId = await insertBankcontact();
    await insertAccount(bcId);

    setAuth("99", ["finance.view"]);
    await ensureUser(99);
    const result = await listAccounts();
    expect(result.items).toHaveLength(0);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(listAccounts()).rejects.toThrow(/permission/);
  });
});

describe("finance/accounts — get (ACL enforcement)", () => {
  it("returns the account for a user with an ACL entry", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId, "Giro");
    setAuth("7", ["finance.view"]);
    await grantAcl(a, 7, "read");

    const result = await getAccount({ id: a });
    expect(result.id).toBe(a);
    expect(result.label).toBe("Giro");
  });

  it("404s when the user has no ACL entry (no enumeration)", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("7", ["finance.view"]);
    await ensureUser(7);
    await expect(getAccount({ id: a })).rejects.toThrow(/not found/);
  });

  it("finance.admin can get any account", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId, "Admin-Sees");
    setAuth("1", ["finance.view", "finance.admin"]);
    const result = await getAccount({ id: a });
    expect(result.label).toBe("Admin-Sees");
  });

  it("404s when the account does not exist at all", async () => {
    setAuth("1", ["finance.view", "finance.admin"]);
    await expect(getAccount({ id: 999_999 })).rejects.toThrow(/not found/);
  });
});

describe("finance/accounts — update", () => {
  it("patches only the supplied fields", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId, "Before");

    setAuth("1", ["finance.accounts.manage"]);
    const result = await updateAccount({
      id: a,
      label: "After",
    });
    expect(result.label).toBe("After");
    expect(result.iban).toBeNull(); // unchanged
  });

  it("rejects an empty patch", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(updateAccount({ id: a })).rejects.toThrow(/no fields/);
  });

  it("rejects an empty label", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      updateAccount({ id: a, label: "   " }),
    ).rejects.toThrow(/label/);
  });

  it("requires finance.accounts.manage", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.view"]);
    await expect(
      updateAccount({ id: a, label: "x" }),
    ).rejects.toThrow(/permission/);
  });

  it("updates type_kind, currency_code and account_number when provided", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    const result = await updateAccount({
      id: a,
      type_kind: "tagesgeld",
      currency_code: "USD",
      account_number: "RENAMED-001",
    });
    expect(result.type_kind).toBe("tagesgeld");
    expect(result.currency_code).toBe("USD");
    expect(result.account_number).toBe("RENAMED-001");
  });

  it("rejects an unknown type_kind", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      updateAccount({ id: a, type_kind: "no-such-type" }),
    ).rejects.toThrow(/account type/);
  });

  it("rejects an unknown currency_code", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      updateAccount({ id: a, currency_code: "XYZ" }),
    ).rejects.toThrow(/currency/);
  });

  it("rejects an empty account_number", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      updateAccount({ id: a, account_number: "   " }),
    ).rejects.toThrow(/account_number/);
  });
});

describe("finance/accounts — delete", () => {
  async function seedAccountWithTransactions(): Promise<{
    bcId: number;
    accountId: number;
    txCount: number;
  }> {
    setAuth("1", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const accountId = await insertAccount(bcId);
    const [currency] = await db
      .select({ code: financeCurrency.code })
      .from(financeCurrency)
      .limit(1);
    await db.insert(financeTransaction).values([
      {
        account_id: accountId,
        booking_date: "2026-03-01",
        amount: "-5.00",
        currency_code: currency.code,
        dedupe_hash: "1".repeat(64),
      },
      {
        account_id: accountId,
        booking_date: "2026-03-02",
        amount: "-7.50",
        currency_code: currency.code,
        dedupe_hash: "2".repeat(64),
      },
      {
        account_id: accountId,
        booking_date: "2026-03-03",
        amount: "-3.50",
        currency_code: currency.code,
        dedupe_hash: "3".repeat(64),
      },
    ]);
    await db.insert(financeAccountBalance).values({
      account_id: accountId,
      as_of: new Date().toISOString(),
      balance: "1234.56",
      source: "manual",
    });
    return { bcId, accountId, txCount: 3 };
  }

  it("removes the account, its transactions and its balance history", async () => {
    const { accountId, txCount } = await seedAccountWithTransactions();

    const result = await deleteAccount({ id: accountId });
    expect(result.deleted).toBe(true);
    expect(result.transactions_deleted).toBe(txCount);

    const accAfter = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, accountId));
    expect(accAfter).toHaveLength(0);

    const txAfter = await db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, accountId));
    expect(txAfter).toHaveLength(0);

    const balAfter = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, accountId));
    expect(balAfter).toHaveLength(0);
  });

  it("leaves the parent bankcontact alone", async () => {
    const { bcId, accountId } = await seedAccountWithTransactions();

    await deleteAccount({ id: accountId });

    const [bc] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(bc).toBeDefined();
  });

  it("requires finance.accounts.manage", async () => {
    const { accountId } = await seedAccountWithTransactions();
    setAuth("1", ["finance.view"]);
    await expect(deleteAccount({ id: accountId })).rejects.toThrow(/permission/);
  });

  it("404s on unknown account id", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(deleteAccount({ id: 999_999 })).rejects.toThrow(/not found/);
  });
});

describe("finance/accounts — link / unlink", () => {
  async function seedManual(): Promise<number> {
    // finance.view is needed by getAccount; the link/unlink tests
    // use it afterwards to assert the row is still readable.
    setAuth("1", ["finance.accounts.manage", "finance.view"]);
    await ensureUser(1);
    const created = await createAccount({
      type_kind: "giro",
      currency_code: "EUR",
      account_number: "MANUAL-01",
      label: "Hauptkonto",
    });
    return created.id;
  }

  it("links a manual account to a bank-side account", async () => {
    const accountId = await seedManual();
    const bcId = await insertBankcontact();

    const linked = await linkAccount({
      id: accountId,
      bankcontact_id: bcId,
      fints_account_number: "DE00...1234",
    });
    expect(linked.bankcontact_id).toBe(bcId);
    expect(linked.fints_account_number).toBe("DE00...1234");
  });

  it("rejects linking when another finance_account is already on the same bank-side slot", async () => {
    const firstId = await seedManual();
    const bcId = await insertBankcontact();
    await linkAccount({
      id: firstId,
      bankcontact_id: bcId,
      fints_account_number: "SHARED",
    });

    // Second account tries to claim the same (bankcontact, fints) slot.
    const second = await createAccount({
      type_kind: "giro",
      currency_code: "EUR",
      account_number: "MANUAL-02",
      label: "Zweitkonto",
    });
    await expect(
      linkAccount({
        id: second.id,
        bankcontact_id: bcId,
        fints_account_number: "SHARED",
      }),
    ).rejects.toThrow(/already linked/);
  });

  it("unlinks an account, keeping the account row intact", async () => {
    const accountId = await seedManual();
    const bcId = await insertBankcontact();
    await linkAccount({
      id: accountId,
      bankcontact_id: bcId,
      fints_account_number: "F1",
    });

    const unlinked = await unlinkAccount({ id: accountId });
    expect(unlinked.bankcontact_id).toBeNull();
    expect(unlinked.bankcontact_name).toBeNull();
    expect(unlinked.fints_account_number).toBeNull();

    // Account row itself still there.
    const still = await getAccount({ id: accountId });
    expect(still.id).toBe(accountId);
  });

  it("requires finance.accounts.manage for both endpoints", async () => {
    const accountId = await seedManual();
    const bcId = await insertBankcontact();
    setAuth("1", ["finance.view"]);
    await expect(
      linkAccount({
        id: accountId,
        bankcontact_id: bcId,
        fints_account_number: "X",
      }),
    ).rejects.toThrow(/permission/);
    await expect(unlinkAccount({ id: accountId })).rejects.toThrow(/permission/);
  });
});

describe("finance/accounts — close / reopen via PATCH", () => {
  it("PATCH closed_at marks an account closed and is reflected by isAccountClosed", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage", "finance.view"]);
    await ensureUser(1);
    await grantAcl(a, 1, "write");

    const before = await getAccount({ id: a });
    expect(before.closed_at).toBeNull();

    const closedAt = "2024-09-15T12:00:00.000Z";
    const result = await updateAccount({ id: a, closed_at: closedAt });
    expect(result.closed_at).not.toBeNull();
    expect(new Date(result.closed_at!).toISOString()).toBe(closedAt);
    expect(await isAccountClosed(a)).toBe(true);
  });

  it("PATCH closed_at: null reopens a closed account", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage", "finance.view"]);
    await ensureUser(1);
    await grantAcl(a, 1, "read");

    await updateAccount({ id: a, closed_at: "2024-09-15T12:00:00.000Z" });
    const reopened = await updateAccount({ id: a, closed_at: null });
    expect(reopened.closed_at).toBeNull();
    expect(await isAccountClosed(a)).toBe(false);
  });

  it("rejects a malformed closed_at value", async () => {
    const bcId = await insertBankcontact();
    const a = await insertAccount(bcId);
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      updateAccount({ id: a, closed_at: "not-a-date" }),
    ).rejects.toThrow(/closed_at/);
  });
});
