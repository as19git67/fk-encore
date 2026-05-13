import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import { persistFetchResult } from "./statement-persist";
import * as tagQueue from "./tag-queue";
import type { FetchResult, FintsHoldingData, FintsTransactionData } from "./types";

// enqueueTagSuggestion would write to finance_tag_queue. We just verify
// that persistFetchResult fires it once per freshly inserted transaction.
vi.mock("./tag-queue", async (orig) => {
  const actual = await orig<typeof import("./tag-queue")>();
  return {
    ...actual,
    enqueueTagSuggestion: vi.fn(async () => undefined),
  };
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountBalance);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  vi.mocked(tagQueue.enqueueTagSuggestion).mockClear();
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

/**
 * Insert a finance_account already linked to the given bankcontact on
 * the given bank-side account number. Mirrors what `createAccount` +
 * `linkAccount` would produce — the two-step UI flow.
 */
async function insertLinkedAccount(opts: {
  bankcontactId: number;
  fintsAccountNumber: string;
  label?: string;
  kind?: string;
}): Promise<number> {
  const kind = opts.kind ?? "giro";
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, kind))
    .limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: opts.bankcontactId,
      fints_account_number: opts.fintsAccountNumber,
      type_id: type.id,
      currency_code: "EUR",
      account_number: opts.fintsAccountNumber,
      label: opts.label ?? "Test-Konto",
    })
    .returning({ id: financeAccount.id });
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
    counterparty_bic: null,
    counterparty_bank_id: null,
    end_to_end_ref: null,
    mandate_ref: null,
    creditor_id: null,
    originator_name: null,
    recipient_name: null,
    funds_code: null,
    transaction_type: null,
    transaction_code: null,
    entry_text: null,
    prima_nota_no: null,
    bankRef: null,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    raw: {},
    ...overrides,
  };
}

function result(accounts: FetchResult["accounts"]): FetchResult {
  return { accounts, partial: false };
}

// ======================================================================

describe("persistFetchResult — matching linked accounts", () => {
  it("writes transactions + balance to a linked finance_account", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "1234567890",
      label: "Hauptkonto",
    });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1234567890",
          iban: "DE12345678901234567890",
          accountKind: "giro",
          currency: "EUR",
          label: "Bank-Label",
          balance: { asOf: "2026-04-24", amount: "1000.00", currency: "EUR" },
          transactions: [tx()],
          holdings: [],
          errors: [],
        },
      ]),
    );

    expect(stats.accounts_seen).toBe(1);
    expect(stats.accounts_matched).toBe(1);
    expect(stats.accounts_unknown).toBe(0);
    expect(stats.unknown).toHaveLength(0);
    expect(stats.transactions_inserted).toBe(1);
    expect(stats.balances_written).toBe(1);

    // Linked account still has the user-set label, not the bank's.
    const [row] = await db.select().from(financeAccount);
    expect(row.id).toBe(accountId);
    expect(row.label).toBe("Hauptkonto");

    const txs = await db
      .select()
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, accountId));
    expect(txs).toHaveLength(1);

    const bals = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, accountId));
    expect(bals).toHaveLength(1);
  });

  it("dedupes transactions across re-syncs via (account_id, dedupe_hash)", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "1" });

    const snapshot = {
      accountNumber: "1",
      iban: null,
      accountKind: "giro",
      currency: "EUR",
      label: "Giro",
      balance: null,
      transactions: [tx({ bookingDate: "2026-04-01", amount: "-10.00" })],
      holdings: [],
      errors: [],
    };
    const first = await persistFetchResult(bcId, result([snapshot]));
    const second = await persistFetchResult(bcId, result([snapshot]));
    expect(first.transactions_inserted).toBe(1);
    expect(second.transactions_inserted).toBe(0);
    expect(second.transactions_skipped_duplicate).toBe(1);
  });

  it("fires the tag-suggester for freshly inserted transactions", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "1" });

    await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Giro",
          balance: null,
          transactions: [
            tx({ purpose: "A", bookingDate: "2026-04-01" }),
            tx({ purpose: "B", bookingDate: "2026-04-02" }),
          ],
          holdings: [],
          errors: [],
        },
      ]),
    );

    expect(tagQueue.enqueueTagSuggestion).toHaveBeenCalledTimes(2);
  });
});

describe("persistFetchResult — unknown / pending accounts", () => {
  it("collects unmatched bank-side accounts in stats.unknown without creating rows", async () => {
    const bcId = await insertBankcontact();

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "NEW-01",
          iban: "DE11",
          accountKind: "giro",
          currency: "EUR",
          label: "Bank-Label Giro",
          balance: { asOf: "2026-04-24", amount: "500.00", currency: "EUR" },
          transactions: [tx()],
          holdings: [],
          errors: [],
        },
      ]),
    );

    expect(stats.accounts_seen).toBe(1);
    expect(stats.accounts_matched).toBe(0);
    expect(stats.accounts_unknown).toBe(1);
    expect(stats.unknown).toHaveLength(1);
    expect(stats.unknown[0]).toMatchObject({
      accountNumber: "NEW-01",
      iban: "DE11",
      accountKind: "giro",
      currency: "EUR",
      label: "Bank-Label Giro",
    });
    expect(stats.transactions_inserted).toBe(0);
    expect(stats.balances_written).toBe(0);

    // No auto-created account, no stray transactions.
    const accounts = await db.select().from(financeAccount);
    expect(accounts).toHaveLength(0);
    const txs = await db.select().from(financeTransaction);
    expect(txs).toHaveLength(0);
  });

  it("writes matched accounts and lists unknown ones in the same run", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "LINKED" });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "LINKED",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Bank-Linked",
          balance: null,
          transactions: [tx()],
          holdings: [],
          errors: [],
        },
        {
          accountNumber: "STRANGER",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Stranger",
          balance: null,
          transactions: [],
          holdings: [],
          errors: [],
        },
      ]),
    );

    expect(stats.accounts_seen).toBe(2);
    expect(stats.accounts_matched).toBe(1);
    expect(stats.accounts_unknown).toBe(1);
    expect(stats.transactions_inserted).toBe(1);
    expect(stats.unknown.map((u) => u.accountNumber)).toEqual(["STRANGER"]);
  });

  it("skips closed accounts entirely — no transactions, no balance", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "CLOSED",
    });
    await db
      .update(financeAccount)
      .set({ closed_at: new Date().toISOString() })
      .where(eq(financeAccount.id, accountId));

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "CLOSED",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "Closed",
          balance: { asOf: "2026-04-24", amount: "1000.00", currency: "EUR" },
          transactions: [tx()],
          holdings: [],
          errors: [],
        },
      ]),
    );

    expect(stats.accounts_seen).toBe(1);
    expect(stats.accounts_matched).toBe(0);
    expect(stats.accounts_closed).toBe(1);
    expect(stats.transactions_inserted).toBe(0);
    expect(stats.balances_written).toBe(0);
    expect(stats.errors.some((e) => e.includes("closed"))).toBe(true);

    const txs = await db
      .select()
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, accountId));
    expect(txs).toHaveLength(0);
    const bals = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, accountId));
    expect(bals).toHaveLength(0);
  });

  it("forwards per-account soft errors into stats.errors for both matched and unknown", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "L" });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "L",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "L",
          balance: null,
          transactions: [],
          holdings: [],
          errors: ["statements-tan-required"],
        },
        {
          accountNumber: "U",
          iban: null,
          accountKind: "giro",
          currency: "EUR",
          label: "U",
          balance: null,
          transactions: [],
          holdings: [],
          errors: ["balance-error:9010 x"],
        },
      ]),
    );
    expect(stats.errors).toContain("account L: statements-tan-required");
    expect(stats.errors).toContain("account U: balance-error:9010 x");
  });
});

// ======================================================================
// Holdings persistence (depot accounts)
// ======================================================================

function holding(overrides: Partial<FintsHoldingData> = {}): FintsHoldingData {
  return {
    isin: "DE000A1EWWW0",
    wkn: "A1EWWW",
    name: "ADIDAS",
    amount: "5",
    price: "200.00",
    value: "1000.00",
    currency: "EUR",
    acquisitionDate: null,
    acquisitionPrice: null,
    ...overrides,
  };
}

describe("persistFetchResult — holdings persistence", () => {
  it("writes holdings for a depot account with two positions", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "DEPOT-1",
      kind: "depot",
    });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "DEPOT-1",
          iban: null,
          accountKind: "depot",
          currency: "EUR",
          label: "Depot",
          balance: { asOf: "2026-05-10", amount: "5000.00", currency: "EUR" },
          transactions: [],
          holdings: [
            holding({ isin: "DE000A1EWWW0", name: "ADIDAS", value: "1000.00" }),
            holding({ isin: "US0378331005", name: "APPLE", value: "4000.00" }),
          ],
          errors: [],
        },
      ]),
    );

    expect(stats.holdings_written).toBe(2);
    expect(stats.balances_written).toBe(1);

    const rows = await db
      .select()
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, accountId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.isin).sort()).toEqual(["DE000A1EWWW0", "US0378331005"]);
  });

  it("upserts idempotently — second sync on same day does not duplicate", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "DEPOT-1", kind: "depot" });

    const snapshot = {
      accountNumber: "DEPOT-1",
      iban: null,
      accountKind: "depot",
      currency: "EUR",
      label: "Depot",
      balance: { asOf: "2026-05-10", amount: "5000.00", currency: "EUR" },
      transactions: [] as FintsTransactionData[],
      holdings: [
        holding({ isin: "DE000A1EWWW0", name: "ADIDAS", value: "1000.00" }),
        holding({ isin: "US0378331005", name: "APPLE", value: "4000.00" }),
      ],
      errors: [] as string[],
    };

    const first = await persistFetchResult(bcId, result([snapshot]));
    const second = await persistFetchResult(bcId, result([snapshot]));

    expect(first.holdings_written).toBe(2);
    expect(second.holdings_written).toBe(2);

    const allRows = await db.select().from(financeAccountHolding);
    expect(allRows).toHaveLength(2);
  });

  it("upserts updates value when price changes on the same day", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "DEPOT-1",
      kind: "depot",
    });

    const base = {
      accountNumber: "DEPOT-1",
      iban: null,
      accountKind: "depot",
      currency: "EUR",
      label: "Depot",
      balance: { asOf: "2026-05-10", amount: "5000.00", currency: "EUR" },
      transactions: [] as FintsTransactionData[],
      errors: [] as string[],
    };

    await persistFetchResult(bcId, result([{
      ...base,
      holdings: [holding({ isin: "DE000A1EWWW0", value: "1000.00", price: "200.00" })],
    }]));
    await persistFetchResult(bcId, result([{
      ...base,
      holdings: [holding({ isin: "DE000A1EWWW0", value: "1200.00", price: "240.00" })],
    }]));

    const rows = await db
      .select()
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("1200.00");
    expect(rows[0].price).toBe("240.000000");
  });

  it("identifies holding by WKN when ISIN is null", async () => {
    const bcId = await insertBankcontact();
    const accountId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "DEPOT-1",
      kind: "depot",
    });

    const base = {
      accountNumber: "DEPOT-1",
      iban: null,
      accountKind: "depot",
      currency: "EUR",
      label: "Depot",
      balance: { asOf: "2026-05-10", amount: "1000.00", currency: "EUR" },
      transactions: [] as FintsTransactionData[],
      errors: [] as string[],
    };

    await persistFetchResult(bcId, result([{
      ...base,
      holdings: [holding({ isin: null, wkn: "710000", name: "Daimler" })],
    }]));
    await persistFetchResult(bcId, result([{
      ...base,
      holdings: [holding({ isin: null, wkn: "710000", name: "Daimler", value: "2000.00" })],
    }]));

    const rows = await db
      .select()
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0].wkn).toBe("710000");
    expect(rows[0].value).toBe("2000.00");
  });

  it("does not write holdings when snapshot has no balance", async () => {
    const bcId = await insertBankcontact();
    await insertLinkedAccount({ bankcontactId: bcId, fintsAccountNumber: "DEPOT-1", kind: "depot" });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "DEPOT-1",
          iban: null,
          accountKind: "depot",
          currency: "EUR",
          label: "Depot",
          balance: null,
          transactions: [],
          holdings: [holding()],
          errors: [],
        },
      ]),
    );

    expect(stats.holdings_written).toBe(0);
    const rows = await db.select().from(financeAccountHolding);
    expect(rows).toHaveLength(0);
  });

  it("matches giro and depot separately when they share the same fints_account_number", async () => {
    const bcId = await insertBankcontact();
    const giroId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "1234567",
      kind: "giro",
      label: "Girokonto",
    });
    const depotId = await insertLinkedAccount({
      bankcontactId: bcId,
      fintsAccountNumber: "1234567",
      kind: "depot",
      label: "Depot",
    });

    const stats = await persistFetchResult(
      bcId,
      result([
        {
          accountNumber: "1234567",
          iban: "DE89370400440532013000",
          accountKind: "giro",
          currency: "EUR",
          label: "Girokonto",
          balance: { asOf: "2026-05-10", amount: "1500.00", currency: "EUR" },
          transactions: [tx()],
          holdings: [],
          errors: [],
        },
        {
          accountNumber: "1234567",
          iban: null,
          accountKind: "depot",
          currency: "EUR",
          label: "Depot",
          balance: { asOf: "2026-05-10", amount: "25000.00", currency: "EUR" },
          transactions: [],
          holdings: [holding({ isin: "DE000A1EWWW0", name: "ADIDAS", value: "25000.00" })],
          errors: [],
        },
      ]),
    );

    expect(stats.accounts_matched).toBe(2);
    expect(stats.accounts_unknown).toBe(0);
    expect(stats.transactions_inserted).toBe(1);
    expect(stats.holdings_written).toBe(1);

    const giroBalance = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, giroId));
    expect(giroBalance).toHaveLength(1);
    expect(giroBalance[0].balance).toBe("1500.00");

    const depotBalance = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, depotId));
    expect(depotBalance).toHaveLength(1);
    expect(depotBalance[0].balance).toBe("25000.00");

    const holdings = await db
      .select()
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, depotId));
    expect(holdings).toHaveLength(1);
    expect(holdings[0].isin).toBe("DE000A1EWWW0");
  });
});
