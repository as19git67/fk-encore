import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import { persistFetchResult } from "./statement-persist";
import * as tagSuggester from "./tag-suggester";
import type { FetchResult, FintsTransactionData } from "./types";

// Tag-suggester would reach out to the llm-service. We don't care what
// it does in these tests — just that persistFetchResult fires it per
// fresh transaction.
vi.mock("./tag-suggester", async (orig) => {
  const actual = await orig<typeof import("./tag-suggester")>();
  return {
    ...actual,
    suggestTagsForTransaction: vi.fn(async () => true),
  };
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountBalance);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  vi.mocked(tagSuggester.suggestTagsForTransaction).mockClear();
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

function tx(
  overrides: Partial<FintsTransactionData> = {},
): FintsTransactionData {
  return {
    bookingDate: "2026-04-24",
    valueDate: "2026-04-24",
    amount: "-42.50",
    currency: "EUR",
    purpose: "Kaffee",
    counterparty: "Bistro",
    counterpartyIban: null,
    fintsId: null,
    raw: {},
    ...overrides,
  };
}

function result(accounts: FetchResult["accounts"]): FetchResult {
  return { accounts, partial: false };
}

// ======================================================================

describe("persistFetchResult — account auto-create", () => {
  it("creates a new finance_account on first sighting", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1234567890",
          iban: "DE12345678901234567890",
          accountKind: "giro",
          currency: "EUR",
          label: "Giro 1234 – Max",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.accounts_seen).toBe(1);
    expect(stats.accounts_created).toBe(1);

    const accounts = await db.select().from(financeAccount);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].iban).toBe("DE12345678901234567890");
    expect(accounts[0].label).toBe("Giro 1234 – Max");
  });

  it("reuses an existing finance_account and does not overwrite its label", async () => {
    const bcId = await insertBankcontact();
    const [type] = await db
      .select({ id: financeAccountType.id })
      .from(financeAccountType)
      .limit(1);
    await db.insert(financeAccount).values({
      bankcontact_id: bcId,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "1234567890",
      label: "Mein Hauptkonto",
    });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1234567890",
          iban: "DE12",
          accountKind: "giro",
          currency: "EUR",
          label: "Bank-Default-Label",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.accounts_created).toBe(0);
    const [row] = await db.select().from(financeAccount);
    expect(row.label).toBe("Mein Hauptkonto");
  });

  it("falls back to 'sonstige' for an unknown accountKind", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "X",
          iban: null,
          accountKind: "unknown-bogus",
          currency: "EUR",
          label: "Whatever",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.accounts_created).toBe(1);
    const [row] = await db
      .select({ type_id: financeAccount.type_id })
      .from(financeAccount);
    const [type] = await db
      .select()
      .from(financeAccountType)
      .where(eq(financeAccountType.id, row.type_id));
    expect(type.kind).toBe("sonstige");
  });
});

describe("persistFetchResult — transactions", () => {
  it("inserts new transactions, skips duplicates, tracks freshly-inserted ids for tag-suggester", async () => {
    const bcId = await insertBankcontact();
    const snapshot = {
      accountNumber: "1",
      iban: null,
      accountKind: "giro",
      currency: "EUR",
      label: "Giro",
      balance: null,
      transactions: [
        tx({ bookingDate: "2026-04-01", amount: "-10.00", purpose: "A" }),
        tx({ bookingDate: "2026-04-02", amount: "-20.00", purpose: "B" }),
      ],
      errors: [],
    };

    const first = await persistFetchResult(bcId, result([snapshot]));
    expect(first.transactions_inserted).toBe(2);
    expect(first.transactions_skipped_duplicate).toBe(0);
    expect(tagSuggester.suggestTagsForTransaction).toHaveBeenCalledTimes(2);

    // Second run with the same snapshot → dedup via unique index
    const second = await persistFetchResult(bcId, result([snapshot]));
    expect(second.transactions_inserted).toBe(0);
    expect(second.transactions_skipped_duplicate).toBe(2);
  });

  it("forwards snapshot soft errors into stats.errors", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro",
          balance: null,
          transactions: [],
          errors: ["statements-tan-required"],
        },
      ]),
    );
    expect(stats.errors).toContain("account 1: statements-tan-required");
  });
});

describe("persistFetchResult — balance", () => {
  it("writes a balance row with source='fints'", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro",
          balance: {
            asOf: "2026-04-24",
            amount: "2341.50",
            currency: "EUR",
          },
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.balances_written).toBe(1);

    const [row] = await db.select().from(financeAccountBalance);
    expect(Number(row.balance)).toBeCloseTo(2341.5, 2);
    expect(row.source).toBe("fints");
  });

  it("skips a balance when the snapshot has none", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.balances_written).toBe(0);
    const rows = await db.select().from(financeAccountBalance);
    expect(rows).toHaveLength(0);
  });
});

describe("persistFetchResult — dedupe hash", () => {
  it("treats two runs with different data as separate transactions", async () => {
    const bcId = await insertBankcontact();
    const first = {
      accountNumber: "1",
      iban: null,
      accountKind: "giro",
      currency: "EUR",
      label: "Giro",
      balance: null,
      transactions: [tx({ purpose: "run1" })],
      errors: [],
    };
    const second = {
      ...first,
      transactions: [tx({ purpose: "run2" })],
    };
    const s1 = await persistFetchResult(bcId, result([first]));
    const s2 = await persistFetchResult(bcId, result([second]));
    expect(s1.transactions_inserted).toBe(1);
    expect(s2.transactions_inserted).toBe(1);
    expect(s2.transactions_skipped_duplicate).toBe(0);
  });
});

// ======================================================================

describe("persistFetchResult — auto-ACL grant", () => {
  async function ensureUser(id: number): Promise<void> {
    await db.execute(
      sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
    );
  }

  it("grants write ACL for newly-created accounts when grantAclToUserId is set", async () => {
    const bcId = await insertBankcontact();
    await ensureUser(7);

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "A1",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro A1",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
      { grantAclToUserId: 7 },
    );

    expect(stats.accounts_created).toBe(1);
    expect(stats.acl_grants).toBe(1);

    const [account] = await db.select().from(financeAccount);
    const acl = await db
      .select()
      .from(financeAccountAccess)
      .where(
        and(
          eq(financeAccountAccess.account_id, account.id),
          eq(financeAccountAccess.user_id, 7),
        ),
      );
    expect(acl).toHaveLength(1);
    expect(acl[0].level).toBe("write");
  });

  it("does not grant when grantAclToUserId is omitted", async () => {
    const bcId = await insertBankcontact();
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "A2",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro A2",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
    );
    expect(stats.accounts_created).toBe(1);
    expect(stats.acl_grants).toBe(0);

    const acl = await db.select().from(financeAccountAccess);
    expect(acl).toHaveLength(0);
  });

  it("does not re-grant for accounts that already existed (idempotent re-sync)", async () => {
    const bcId = await insertBankcontact();
    await ensureUser(7);

    // First sync → account created + ACL granted.
    const first = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "A3",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro A3",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
      { grantAclToUserId: 7 },
    );
    expect(first.acl_grants).toBe(1);

    // Second sync of the same bankcontact → account already exists,
    // so the create branch (where the ACL grant lives) is not
    // entered, and acl_grants stays at 0.
    const second = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "A3",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro A3",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
      { grantAclToUserId: 7 },
    );
    expect(second.accounts_created).toBe(0);
    expect(second.acl_grants).toBe(0);

    // One ACL row, unchanged.
    const acl = await db.select().from(financeAccountAccess);
    expect(acl).toHaveLength(1);
  });

  it("leaves an existing ACL for the same (account,user) untouched if the FK writes race", async () => {
    // Defensive: if somehow a pre-existing ACL already covers the
    // freshly-created account (e.g. an admin granted write access
    // while a cron ran), onConflictDoNothing must not raise and
    // acl_grants stays at 0.
    const bcId = await insertBankcontact();
    await ensureUser(7);

    // Pre-create the account and ACL row.
    const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
    const [pre] = await db
      .insert(financeAccount)
      .values({
        bankcontact_id: bcId,
        type_id: type.id,
        currency_code: "EUR",
        account_number: "A4",
        label: "pre-existing",
      })
      .returning({ id: financeAccount.id });
    await db.insert(financeAccountAccess).values({
      account_id: pre.id,
      user_id: 7,
      level: "read",
    });

    // Now run a sync against the same account_number — it will be
    // matched to the existing row, so the create branch is skipped
    // entirely and the ACL is not touched.
    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "A4",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "from-sync",
          balance: null,
          transactions: [],
          errors: [],
        },
      ]),
      { grantAclToUserId: 7 },
    );
    expect(stats.accounts_created).toBe(0);
    expect(stats.acl_grants).toBe(0);

    const [acl] = await db.select().from(financeAccountAccess);
    expect(acl.level).toBe("read"); // admin's prior decision stays
  });
});
