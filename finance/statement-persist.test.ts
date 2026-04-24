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

void and;
void financeAccountAccess;
