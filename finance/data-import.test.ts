import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";
import { importFinanceData } from "./data-import";
import type { FinanzkraftExport } from "./import-schema";

/** Mirror of computeDedupeHash in data-import.ts so test fixtures can
 *  pre-compute the same hash the importer would, which the new
 *  composite tag-link lookup relies on. */
function dedupe(
  bookingDate: string,
  amount: string,
  currency: string,
  purpose: string,
  counterpartyIban = "",
  valueDate = "",
): string {
  const canonical = [
    bookingDate,
    valueDate,
    amount,
    currency.toUpperCase(),
    purpose,
    counterpartyIban,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
import { __resetRateLimiterForTests } from "../user/rateLimiter";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

beforeEach(async () => {
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  // Import is capped at 3/60min per user — reset so each test starts
  // with a fresh quota. See docs/finance-rate-limiting.md §2.
  __resetRateLimiterForTests();
  setAuth("1", []);
});

// -----------------------------------------------------------------------
// Fixture — a small but realistic export (kept inline to avoid
// sprawling fixture files before we have the real Finanzkraft format).
// -----------------------------------------------------------------------

function miniExport(): FinanzkraftExport {
  return {
    version: "1",
    bankcontacts: [
      {
        blz: "12345678",
        login: "user-42",
        name: "Sparkasse Test",
        server_url: "https://hbci.test/fints",
      },
    ],
    accounts: [
      {
        bankcontact_blz: "12345678",
        bankcontact_login: "user-42",
        type_kind: "giro",
        currency_code: "EUR",
        iban: "DE12345678901234567890",
        account_number: "1234567890",
        label: "Girokonto",
      },
    ],
    transactions: [
      {
        account_iban: "DE12345678901234567890",
        booking_date: "2024-08-10",
        amount: "-47.30",
        currency_code: "EUR",
        purpose: "Supermarkt",
        counterparty: "REWE",
      },
      {
        account_iban: "DE12345678901234567890",
        booking_date: "2024-08-15",
        amount: "3800.00",
        currency_code: "EUR",
        purpose: "Gehalt August",
        counterparty: "AG GmbH",
      },
    ],
    tags: ["alltag", "gehalt"],
    tag_links: [
      {
        tag: "alltag",
        account_iban: "DE12345678901234567890",
        booking_date: "2024-08-10",
        dedupe_hash: dedupe("2024-08-10", "-47.30", "EUR", "Supermarkt"),
      },
      {
        tag: "gehalt",
        account_iban: "DE12345678901234567890",
        booking_date: "2024-08-15",
        dedupe_hash: dedupe("2024-08-15", "3800.00", "EUR", "Gehalt August"),
      },
    ],
  };
}

// -----------------------------------------------------------------------

describe("finance/data-import — permission", () => {
  it("rejects callers without finance.admin", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      importFinanceData({ export: miniExport() }),
    ).rejects.toThrow(/permission/);
  });
});

describe("finance/data-import — happy path", () => {
  it("imports bankcontacts, accounts, transactions, tags and tag-links", async () => {
    setAuth("1", ["finance.admin"]);
    const result = await importFinanceData({ export: miniExport() });
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({
      currencies: 0,
      bankcontacts: 1,
      accounts: 1,
      transactions: 2,
      tags: 2,
      tag_links: 2,
    });
    expect(result.skipped).toEqual({
      currencies: 0,
      bankcontacts: 0,
      accounts: 0,
      transactions: 0,
      tags: 0,
      tag_links: 0,
    });

    const bankcontacts = await db.select().from(financeBankcontact);
    expect(bankcontacts).toHaveLength(1);
    expect(bankcontacts[0].blz).toBe("12345678");
    // Credentials NOT imported
    expect(bankcontacts[0].credentials_encrypted).toBeNull();

    const accounts = await db.select().from(financeAccount);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].iban).toBe("DE12345678901234567890");

    const transactions = await db.select().from(financeTransaction);
    expect(transactions).toHaveLength(2);
    expect(transactions.every((t) => t.account_id === accounts[0].id)).toBe(
      true,
    );

    const tagLinks = await db.select().from(financeTagTransaction);
    expect(tagLinks).toHaveLength(2);
  });

  it("never writes ACL rows", async () => {
    setAuth("1", ["finance.admin"]);
    await importFinanceData({ export: miniExport() });
    const acl = await db.select().from(financeAccountAccess);
    expect(acl).toEqual([]);
  });

  it("preserves closed_at from the export so retired accounts stay closed", async () => {
    setAuth("1", ["finance.admin"]);
    const closedAt = "2023-06-15T10:30:00.000Z";
    const exp: FinanzkraftExport = {
      ...miniExport(),
      accounts: [
        { ...miniExport().accounts[0], closed_at: closedAt },
      ],
      transactions: [],
      tag_links: [],
    };
    await importFinanceData({ export: exp });
    const accounts = await db.select().from(financeAccount);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].closed_at).not.toBeNull();
    expect(new Date(accounts[0].closed_at!).toISOString()).toBe(closedAt);
  });
});

describe("finance/data-import — idempotency", () => {
  it("re-running the same export produces zero inserts, all-skipped", async () => {
    setAuth("1", ["finance.admin"]);
    const first = await importFinanceData({ export: miniExport() });
    expect(first.counts.transactions).toBe(2);

    const second = await importFinanceData({ export: miniExport() });
    expect(second.errors).toEqual([]);
    expect(second.counts).toEqual({
      currencies: 0,
      bankcontacts: 0,
      accounts: 0,
      transactions: 0,
      tags: 0,
      tag_links: 0,
    });
    expect(second.skipped).toEqual({
      currencies: 0,
      bankcontacts: 1,
      accounts: 1,
      transactions: 2,
      tags: 2,
      tag_links: 2,
    });

    // Still exactly one of everything in the DB
    expect((await db.select().from(financeBankcontact)).length).toBe(1);
    expect((await db.select().from(financeAccount)).length).toBe(1);
    expect((await db.select().from(financeTransaction)).length).toBe(2);
    expect((await db.select().from(financeTagTransaction)).length).toBe(2);
  });

  it("transactions dedupe via (account_id, dedupe_hash)", async () => {
    setAuth("1", ["finance.admin"]);
    const exportData: FinanzkraftExport = {
      ...miniExport(),
      tag_links: [],
    };
    await importFinanceData({ export: exportData });
    const r2 = await importFinanceData({ export: exportData });
    expect(r2.skipped.transactions).toBe(2);
    expect(r2.counts.transactions).toBe(0);
  });
});

describe("finance/data-import — validation errors", () => {
  it("reports unknown type_kind without aborting other stages", async () => {
    setAuth("1", ["finance.admin"]);
    const bad: FinanzkraftExport = {
      ...miniExport(),
      accounts: [
        {
          ...miniExport().accounts[0],
          type_kind: "nonexistent",
        },
      ],
      transactions: [],
      tag_links: [],
    };
    const result = await importFinanceData({ export: bad });
    expect(result.counts.bankcontacts).toBe(1);
    expect(result.counts.accounts).toBe(0);
    expect(result.errors.some((e) => /type_kind/.test(e.message))).toBe(true);
  });

  it("reports unknown currency_code", async () => {
    setAuth("1", ["finance.admin"]);
    const bad: FinanzkraftExport = {
      ...miniExport(),
      accounts: [
        {
          ...miniExport().accounts[0],
          currency_code: "ZZZ",
        },
      ],
      transactions: [],
      tag_links: [],
    };
    const result = await importFinanceData({ export: bad });
    expect(result.errors.some((e) => /currency_code/.test(e.message))).toBe(
      true,
    );
  });

  it("reports transactions whose parent account cannot be located", async () => {
    setAuth("1", ["finance.admin"]);
    const bad: FinanzkraftExport = {
      ...miniExport(),
      transactions: [
        {
          account_iban: "DE99999999999999999999",
          booking_date: "2024-08-10",
          amount: "-1.00",
          currency_code: "EUR",
        },
      ],
      tag_links: [],
    };
    const result = await importFinanceData({ export: bad });
    expect(result.counts.transactions).toBe(0);
    expect(result.errors.some((e) => /parent account/.test(e.message))).toBe(
      true,
    );
  });

  it("reports tag-links pointing at unknown tag names", async () => {
    setAuth("1", ["finance.admin"]);
    const bad: FinanzkraftExport = {
      ...miniExport(),
      tag_links: [
        {
          tag: "nonexistent",
          account_iban: "DE12345678901234567890",
          booking_date: "2024-08-10",
          dedupe_hash: dedupe("2024-08-10", "-47.30", "EUR", "Supermarkt"),
        },
      ],
    };
    const result = await importFinanceData({ export: bad });
    expect(result.errors.some((e) => /unknown tag/.test(e.message))).toBe(
      true,
    );
  });

  it("reports non-numeric transaction amounts", async () => {
    setAuth("1", ["finance.admin"]);
    const bad: FinanzkraftExport = {
      ...miniExport(),
      transactions: [
        {
          account_iban: "DE12345678901234567890",
          booking_date: "2024-08-10",
          amount: "abc",
          currency_code: "EUR",
        },
      ],
      tag_links: [],
    };
    const result = await importFinanceData({ export: bad });
    expect(result.counts.transactions).toBe(0);
    expect(result.errors.some((e) => /not a number/.test(e.message))).toBe(
      true,
    );
  });
});

describe("finance/data-import — schema validation", () => {
  it("rejects non-object root", async () => {
    setAuth("1", ["finance.admin"]);
    await expect(
      importFinanceData({ export: "not an object" }),
    ).rejects.toThrow(/root/);
  });

  it("rejects missing version", async () => {
    setAuth("1", ["finance.admin"]);
    await expect(
      importFinanceData({
        export: {
          bankcontacts: [],
          accounts: [],
          transactions: [],
          tags: [],
          tag_links: [],
        },
      }),
    ).rejects.toThrow(/version/);
  });

  it("rejects bankcontact with empty blz", async () => {
    setAuth("1", ["finance.admin"]);
    const bad = miniExport();
    (bad.bankcontacts[0] as any).blz = "";
    await expect(
      importFinanceData({ export: bad }),
    ).rejects.toThrow(/blz/);
  });
});
