/**
 * PayPal sync routing — statements.runPaypalSync + persistPaypalSnapshot.
 *
 * The statements/cron router tests upstream (statements.test.ts /
 * statements-cron.test.ts) cover the FinTS branch. This file isolates
 * the PayPal branch: stubbed paypal-client returns balances /
 * transactions, persistence + multi-currency balance writes are
 * exercised through the real DB.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeBankcontact,
  financePaypalOauthState,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
} from "../db/schema";
import {
  persistPaypalSnapshot,
  type PaypalSnapshot,
} from "./statement-persist";
import { runPaypalSync } from "./statements";
import * as paypalClient from "./paypal-client";

vi.mock("./paypal-client", async (orig) => {
  const actual = await orig<typeof import("./paypal-client")>();
  return {
    ...actual,
    fetchPaypalBalances: vi.fn(),
    fetchPaypalTransactions: vi.fn(),
  };
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financePaypalOauthState);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  vi.mocked(paypalClient.fetchPaypalBalances).mockReset();
  vi.mocked(paypalClient.fetchPaypalTransactions).mockReset();
});

async function insertBankcontactWithAccount(): Promise<{
  bcId: number;
  accountId: number;
}> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({
      name: "PayPal",
      access_type: "paypal",
      paypal_environment: "sandbox",
    })
    .returning();
  const [giro] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, "giro"))
    .limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      fints_account_number: "PAYER1",
      type_id: giro.id,
      currency_code: "EUR",
      account_number: "PAYER1",
      label: "PayPal",
    })
    .returning({ id: financeAccount.id });
  return { bcId: bc.id, accountId: acc.id };
}

describe("persistPaypalSnapshot", () => {
  it("inserts transactions with the paypal transaction_id as dedupe_hash", async () => {
    const { bcId, accountId } = await insertBankcontactWithAccount();
    const snapshot: PaypalSnapshot = {
      balances: [
        {
          currency: "EUR",
          total: "100.00",
          available: "90.00",
          primary: true,
          asOf: "2026-06-15T10:00:00Z",
        },
      ],
      transactions: [
        {
          transactionId: "TX-A",
          bookingDate: "2026-06-15T10:00:00Z",
          valueDate: null,
          amount: "-9.99",
          currency: "EUR",
          purpose: "Adobe subscription",
          counterparty: "Adobe",
          counterpartyEmail: "ar@example.com",
          eventCode: "T0006",
          status: "S",
          raw: { transaction_info: { transaction_id: "TX-A" } },
        },
      ],
    };

    const stats = await persistPaypalSnapshot(bcId, snapshot);
    expect(stats.accounts_matched).toBe(1);
    expect(stats.transactions_inserted).toBe(1);
    expect(stats.balances_written).toBe(1);

    const txs = await db
      .select()
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, accountId));
    expect(txs).toHaveLength(1);
    expect(txs[0].dedupe_hash).toBe("TX-A");
    expect(txs[0].amount).toBe("-9.99");
    expect(txs[0].booking_date.slice(0, 10)).toBe("2026-06-15");
    expect(txs[0].purpose).toBe("Adobe subscription");
  });

  it("is idempotent on re-runs (same transaction_id → dup count++)", async () => {
    const { bcId } = await insertBankcontactWithAccount();
    const snapshot: PaypalSnapshot = {
      balances: [],
      transactions: [
        {
          transactionId: "TX-1",
          bookingDate: "2026-06-15T10:00:00Z",
          valueDate: null,
          amount: "5.00",
          currency: "EUR",
          purpose: null,
          counterparty: null,
          counterpartyEmail: null,
          eventCode: null,
          status: null,
          raw: {},
        },
      ],
    };
    await persistPaypalSnapshot(bcId, snapshot);
    const second = await persistPaypalSnapshot(bcId, snapshot);
    expect(second.transactions_inserted).toBe(0);
    expect(second.transactions_skipped_duplicate).toBe(1);
  });

  it("writes one balance row per currency under the same as_of", async () => {
    const { bcId, accountId } = await insertBankcontactWithAccount();
    const snapshot: PaypalSnapshot = {
      balances: [
        {
          currency: "EUR",
          total: "100.00",
          available: "100.00",
          primary: true,
          asOf: "2026-06-15T10:00:00Z",
        },
        {
          currency: "USD",
          total: "50.00",
          available: "50.00",
          primary: false,
          asOf: "2026-06-15T10:00:00Z",
        },
      ],
      transactions: [],
    };
    const stats = await persistPaypalSnapshot(bcId, snapshot);
    expect(stats.balances_written).toBe(2);

    const balances = await db
      .select()
      .from(financeAccountBalance)
      .where(eq(financeAccountBalance.account_id, accountId));
    expect(balances).toHaveLength(2);
    const byCurrency = new Map(balances.map((b) => [b.currency_code, b]));
    expect(byCurrency.get("EUR")?.balance).toBe("100.00");
    expect(byCurrency.get("USD")?.balance).toBe("50.00");
    expect(byCurrency.get("EUR")?.source).toBe("paypal");
  });

  it("surfaces an unknown account when the bankcontact has no finance_account yet", async () => {
    const [bc] = await db
      .insert(financeBankcontact)
      .values({
        name: "PayPal",
        access_type: "paypal",
        paypal_environment: "sandbox",
      })
      .returning();
    const stats = await persistPaypalSnapshot(bc.id, {
      balances: [
        {
          currency: "EUR",
          total: "10.00",
          available: "10.00",
          primary: true,
          asOf: "2026-06-15T00:00:00Z",
        },
      ],
      transactions: [],
    });
    expect(stats.accounts_unknown).toBe(1);
    expect(stats.unknown).toHaveLength(1);
    expect(stats.unknown[0].label).toBe("PayPal");
    expect(stats.unknown[0].balance?.currency).toBe("EUR");
  });

  it("skips closed accounts and records the reason", async () => {
    const { bcId } = await insertBankcontactWithAccount();
    await db
      .update(financeAccount)
      .set({ closed_at: new Date().toISOString() })
      .where(eq(financeAccount.bankcontact_id, bcId));
    const stats = await persistPaypalSnapshot(bcId, {
      balances: [],
      transactions: [],
    });
    expect(stats.accounts_closed).toBe(1);
    expect(stats.errors).toContain("PayPal wallet: skipped, account is closed");
  });
});

describe("runPaypalSync", () => {
  it("fetches PayPal data, persists it, and returns idle", async () => {
    const { bcId } = await insertBankcontactWithAccount();

    vi.mocked(paypalClient.fetchPaypalBalances).mockResolvedValue([
      {
        currency: "EUR",
        total: "200.00",
        available: "200.00",
        primary: true,
        asOf: "2026-06-15T10:00:00Z",
      },
    ]);
    vi.mocked(paypalClient.fetchPaypalTransactions).mockResolvedValue([
      {
        transactionId: "T-SYNC",
        bookingDate: "2026-06-15T10:00:00Z",
        valueDate: null,
        amount: "5.00",
        currency: "EUR",
        purpose: "test",
        counterparty: null,
        counterpartyEmail: null,
        eventCode: null,
        status: "S",
        raw: {},
      },
    ]);

    const result = await runPaypalSync(bcId);

    expect(result.state).toBe("idle");
    expect(result.transactions_inserted).toBe(1);
    expect(result.balances_written).toBe(1);
    expect(result.accounts_matched).toBe(1);

    const [bc] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(bc.last_sync_status).toBe("ok");
    expect(bc.last_sync_at).not.toBeNull();
  });

  it("returns state=error when paypal-client throws", async () => {
    const { bcId } = await insertBankcontactWithAccount();
    vi.mocked(paypalClient.fetchPaypalBalances).mockRejectedValue(
      new Error("rate limited"),
    );
    vi.mocked(paypalClient.fetchPaypalTransactions).mockResolvedValue([]);

    const result = await runPaypalSync(bcId);
    expect(result.state).toBe("error");
    expect(result.errorCode).toBe("paypal");
    expect(result.errorMessage).toMatch(/rate limited/);

    const [bc] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(bc.last_sync_status).toBe("error:paypal");
  });

  it("marks the sync partial when the wallet account is missing", async () => {
    const [bc] = await db
      .insert(financeBankcontact)
      .values({
        name: "PayPal",
        access_type: "paypal",
        paypal_environment: "sandbox",
      })
      .returning();
    vi.mocked(paypalClient.fetchPaypalBalances).mockResolvedValue([]);
    vi.mocked(paypalClient.fetchPaypalTransactions).mockResolvedValue([]);

    const result = await runPaypalSync(bc.id);
    expect(result.state).toBe("idle");
    expect(result.accounts_unknown).toBe(1);
    expect(result.partial).toBe(true);

    const [reloaded] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bc.id));
    expect(reloaded.last_sync_status).toBe("partial");
  });
});
