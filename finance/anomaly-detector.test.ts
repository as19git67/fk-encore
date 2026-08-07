import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql, and, eq, isNull } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeAnomaly,
  financeBankcontact,
  financeRecurringMandate,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import {
  counterpartySimilarity,
  derivePaymentChannel,
  extractTextDates,
  normalizeCounterparty,
  purposeDatesContradict,
  runAnomalyDetection,
} from "./anomaly-detector";

// All tests share a single tenant + account; the detector operates per
// account so this is enough scope to exercise the missing-transaction
// pass.
async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

async function anyTypeId(): Promise<number> {
  const [row] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  return row.id;
}

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

async function insertAccount(): Promise<number> {
  const bcId = await insertBankcontact();
  const typeId = await anyTypeId();
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bcId,
      type_id: typeId,
      currency_code: "EUR",
      account_number: "AN-1",
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function grantWriteAccess(accountId: number, userId: number): Promise<void> {
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level: "write",
  });
}

interface InsertTxOpts {
  accountId: number;
  bookingDate: string;
  amount: string;
  counterparty: string;
  mandateRef?: string | null;
  creditorId?: string | null;
  counterpartyIban?: string | null;
  purpose?: string | null;
  entryText?: string | null;
  transactionType?: string | null;
}

let txCounter = 0;
async function insertTx(opts: InsertTxOpts): Promise<number> {
  txCounter += 1;
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: opts.accountId,
      booking_date: opts.bookingDate,
      amount: opts.amount,
      currency_code: "EUR",
      counterparty: opts.counterparty,
      counterparty_iban: opts.counterpartyIban ?? null,
      mandate_ref: opts.mandateRef ?? null,
      creditor_id: opts.creditorId ?? null,
      purpose: opts.purpose ?? null,
      entry_text: opts.entryText ?? null,
      transaction_type: opts.transactionType ?? null,
      dedupe_hash: `t-${Date.now()}-${txCounter}`.padEnd(64, "0").slice(0, 64),
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  vi.useRealTimers();
  // Drain the finance graph from leaves inward so FK RESTRICTs don't
  // trip when previous tests left rows behind.
  await db.delete(financeAnomaly);
  await db.delete(financeRecurringMandate);
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
});

describe("finance/anomaly-detector — counterparty normalization", () => {
  it("ignores punctuation and legal-form changes", () => {
    expect(normalizeCounterparty("Müller & Partner GmbH")).toBe("muller und partner");
    expect(counterpartySimilarity("Provider Deutschland GmbH", "PROVIDER Deutschland SE")).toBe(1);
  });

  it("does not conflate merchants that only share one generic token", () => {
    expect(counterpartySimilarity("Provider Energie GmbH", "Provider Mobilität AG")).toBeLessThan(0.8);
  });
});

describe("finance/anomaly-detector — new_mandate", () => {
  it("does not classify a one-off card payment as recurring", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    await insertTx({
      accountId,
      bookingDate: daysAgo(1),
      amount: "-149.00",
      counterparty: "UZR*Alternate GmbH, Linden DE",
      purpose: [
        "Karte Nr. 4871 78XX XXXX 8079",
        "Kartenzahlung",
        "comdirect Visa-Debitkarte",
      ].join("\n"),
    });

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "new_mandate"));
    expect(anomalies).toHaveLength(0);
  });

  it("reports a recurring card payment at the ten-euro threshold", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();
    let transactionId = 0;
    for (const days of [61, 31, 1]) {
      transactionId = await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-10.00",
        counterparty: "Streaming per Visa",
        purpose: "Kartenzahlung comdirect Visa-Debitkarte",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "new_mandate"));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].transaction_id).toBe(transactionId);
    expect(anomalies[0].details).toMatchObject({
      occurrences: 3,
      interval_days: 30,
    });

    await runAnomalyDetection([accountId]);
    const afterRerun = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "new_mandate"));
    expect(afterRerun).toHaveLength(1);
  });

  it("does not report a recurring pattern below ten euros", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();
    for (const days of [61, 31, 1]) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-9.99",
        counterparty: "Kleinbetrag-Abo",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "new_mandate"));
    expect(anomalies).toHaveLength(0);
  });

  it("does not call irregular repeat purchases recurring", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();
    for (const days of [51, 41, 1]) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-149.00",
        counterparty: "Online-Händler",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "new_mandate"));
    expect(anomalies).toHaveLength(0);
  });
});

describe("finance/anomaly-detector — missing_transaction", () => {
  it("emits missing_transaction when a monthly mandate is overdue past the grace period", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings, each ~30 days apart, the LAST one ~120 days
    // ago — i.e. three full periods missed.  Grace is 7 days, interval
    // ~30 days → very stale, well past grace.
    const baseAgo = 120 + 30 * 7; // first booking ~330 days ago
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(baseAgo - i * 30),
        amount: "-49.90",
        counterparty: "Strom AG",
        mandateRef: "M-STROM-1",
        creditorId: "DE00ZZZ0000",
      });
    }

    const result = await runAnomalyDetection([accountId]);
    expect(result.mandates_created).toBe(1);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0];
    expect(a.transaction_id).toBeNull();
    expect(a.mandate_id).not.toBeNull();
    const details = a.details as Record<string, unknown>;
    expect(typeof details.expected_date).toBe("string");
    expect(details.interval_days).toBeGreaterThanOrEqual(25);
    expect(Number(details.days_overdue)).toBeGreaterThan(7);
    expect(details.expected_amount).toBe("-49.90");
  });

  it("does NOT emit missing_transaction when the most recent booking is still within the grace window", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // Monthly mandate whose last booking was just a few days ago — far
    // from due. With ~30-day interval, "due" is ~last_seen + 30 + 7.
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(5 + i * 30),
        amount: "-19.99",
        counterparty: "Streaming GmbH",
        mandateRef: "M-STREAM-1",
        creditorId: "DE11ZZZ1111",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT emit missing_transaction for a mandate with fewer than the minimum occurrence count", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // Only 3 bookings — too few to trust the interval baseline.
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-12.00",
        counterparty: "Klein AG",
        mandateRef: "M-KLEIN",
        creditorId: "DE22ZZZ2222",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT emit missing_transaction when the interval history is too noisy (CV above threshold)", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 7 bookings with wildly varying intervals (5, 60, 10, 50, 30, 90 days)
    // → CV well above 0.30. typical_interval_days from the EMA will still
    // be inside the 25–400 band, but the stability gate filters this out.
    const offsets = [0, 90, 120, 130, 180, 240, 245];
    for (const off of offsets) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(off + 200),
        amount: "-30.00",
        counterparty: "Unregelmäßig",
        mandateRef: "M-NOISY",
        creditorId: "DE33ZZZ3333",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(0);
  });

  it("is idempotent: a second run does not duplicate the missing_transaction anomaly", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(150 + i * 30),
        amount: "-99.00",
        counterparty: "Versicherung AG",
        mandateRef: "M-VERS",
        creditorId: "DE44ZZZ4444",
      });
    }

    const r1 = await runAnomalyDetection([accountId]);
    const r2 = await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(1);
    // r1 emits one; r2 emits none.
    expect(r1.anomalies_created).toBeGreaterThanOrEqual(1);
    expect(r2.anomalies_created).toBe(0);
  });

  it("does NOT emit missing_transaction for mandates whose typical interval is below the supported range", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // Daily-ish mandate: 8 transactions 2 days apart, last one 30 days
    // ago (deeply "overdue" by its own period, but interval < 25 days
    // so the missing pass declines to alert).
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(30 + i * 2),
        amount: "-3.50",
        counterparty: "Kaffee",
        mandateRef: "M-KAFFEE",
        creditorId: "DE55ZZZ5555",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT emit missing_transaction when the mandate has been silent for over two years (likely cancelled)", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 bookings from 3+ years ago, all 30 days apart. Last_seen ≈ 1100
    // days back → ancient → suppressed.
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(1100 + i * 30),
        amount: "-10.00",
        counterparty: "Altes Abo",
        mandateRef: "M-ALT",
        creditorId: "DE66ZZZ6666",
      });
    }

    await runAnomalyDetection([accountId]);

    const anomalies = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
        ),
      );
    expect(anomalies).toHaveLength(0);
  });

  it("revisits the same mandate after the user acknowledges and a new period elapses", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings, ~120 days since last one → flagged.
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Strom AG",
        mandateRef: "M-STROM-X",
        creditorId: "DE77ZZZ7777",
      });
    }

    await runAnomalyDetection([accountId]);
    const first = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "missing_transaction"));
    expect(first).toHaveLength(1);
    const firstExpected = (first[0].details as Record<string, unknown>).expected_date;

    // User acknowledges the alert; the mandate's expected_date for the
    // SAME slot is now recorded — a re-run must not re-create it.
    await db
      .update(financeAnomaly)
      .set({ acknowledged_at: sql`NOW()` })
      .where(eq(financeAnomaly.id, first[0].id));

    await runAnomalyDetection([accountId]);
    const second = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "missing_transaction"));
    expect(second).toHaveLength(1);
    expect((second[0].details as Record<string, unknown>).expected_date).toBe(firstExpected);
  });

  it("suppresses missing_transaction when the same counterparty has activity under a new mandate identity (e.g. creditor changed banks)", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings under the OLD mandate_ref. last_seen ~120
    // days ago → would normally fire missing.
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Provider GmbH",
        mandateRef: "M-OLD-REF",
        creditorId: "DE99ZZZ9990",
      });
    }
    // Recent bookings with a NEW mandate_ref + creditor_id but the
    // SAME counterparty name. The user's recurring series simply
    // continued elsewhere — no "missing" alert should fire.
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(90 - i * 30),
        amount: "-52.00",
        counterparty: "Provider GmbH",
        mandateRef: "M-NEW-REF",
        creditorId: "DE99ZZZ9991",
      });
    }

    await runAnomalyDetection([accountId]);

    const open = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          isNull(financeAnomaly.acknowledged_at),
        ),
      );
    expect(open.filter((item) => item.type === "missing_transaction")).toHaveLength(0);
    expect(open.filter((item) => item.type === "new_mandate")).toHaveLength(0);
  });

  it("treats a matching mandate on the user's new bank account as the same recurring series", async () => {
    await ensureUser(1);
    const oldAccountId = await insertAccount();
    const newAccountId = await insertAccount();
    await grantWriteAccess(oldAccountId, 1);
    await grantWriteAccess(newAccountId, 1);

    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId: oldAccountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Provider Deutschland GmbH",
        mandateRef: "OLD-MANDATE",
        creditorId: "DE98ZZZ0001",
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId: newAccountId,
        bookingDate: daysAgo(90 - i * 30),
        amount: "-52.00",
        counterparty: "Provider Deutschland SE",
        mandateRef: "NEW-MANDATE",
        creditorId: "DE98ZZZ0002",
      });
    }

    await runAnomalyDetection([oldAccountId, newAccountId]);

    const open = await db
      .select()
      .from(financeAnomaly)
      .where(isNull(financeAnomaly.acknowledged_at));
    expect(open.filter((item) => item.type === "missing_transaction")).toHaveLength(0);
    expect(open.filter((item) => item.type === "new_mandate")).toHaveLength(0);
  });

  it("does not bridge accounts when the amount no longer resembles the old series", async () => {
    await ensureUser(1);
    const oldAccountId = await insertAccount();
    const newAccountId = await insertAccount();
    await grantWriteAccess(oldAccountId, 1);
    await grantWriteAccess(newAccountId, 1);

    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId: oldAccountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Provider Deutschland GmbH",
        mandateRef: "OLD-MANDATE",
        creditorId: "DE98ZZZ1001",
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId: newAccountId,
        bookingDate: daysAgo(90 - i * 30),
        amount: "-499.00",
        counterparty: "Provider Deutschland SE",
        mandateRef: "NEW-MANDATE",
        creditorId: "DE98ZZZ1002",
      });
    }

    await runAnomalyDetection([oldAccountId, newAccountId]);

    const open = await db
      .select()
      .from(financeAnomaly)
      .where(isNull(financeAnomaly.acknowledged_at));
    expect(open.some((item) => item.type === "missing_transaction" && item.account_id === oldAccountId)).toBe(true);
    expect(open.some((item) => item.type === "new_mandate" && item.account_id === newAccountId)).toBe(true);
  });

  it("does not bridge bank accounts without a shared write user", async () => {
    await ensureUser(1);
    await ensureUser(2);
    const oldAccountId = await insertAccount();
    const otherUsersAccountId = await insertAccount();
    await grantWriteAccess(oldAccountId, 1);
    await grantWriteAccess(otherUsersAccountId, 2);

    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId: oldAccountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Provider Deutschland GmbH",
        mandateRef: "USER-1-MANDATE",
        creditorId: "DE98ZZZ2001",
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId: otherUsersAccountId,
        bookingDate: daysAgo(90 - i * 30),
        amount: "-52.00",
        counterparty: "Provider Deutschland SE",
        mandateRef: "USER-2-MANDATE",
        creditorId: "DE98ZZZ2002",
      });
    }

    await runAnomalyDetection([oldAccountId, otherUsersAccountId]);

    const open = await db
      .select()
      .from(financeAnomaly)
      .where(isNull(financeAnomaly.acknowledged_at));
    expect(open.some((item) => item.type === "missing_transaction" && item.account_id === oldAccountId)).toBe(true);
    expect(open.some((item) => item.type === "new_mandate" && item.account_id === otherUsersAccountId)).toBe(true);
  });

  it("suppresses missing_transaction when the same counterparty has activity under a new IBAN (no mandate_ref)", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "1500.00",
        counterparty: "Arbeitgeber AG",
        counterpartyIban: "DE11OLDBANK000000001",
      });
    }
    // Salary moved to a new payroll bank.
    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(90 - i * 30),
        amount: "1600.00",
        counterparty: "Arbeitgeber AG",
        counterpartyIban: "DE22NEWBANK000000002",
      });
    }

    await runAnomalyDetection([accountId]);

    const missing = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
          isNull(financeAnomaly.acknowledged_at),
        ),
      );
    expect(missing).toHaveLength(0);
  });

  it("auto-acknowledges a stale missing_transaction once a successor booking appears for the same counterparty", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // First run: only the old mandate exists → missing alert fires.
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(120 + i * 30),
        amount: "-49.90",
        counterparty: "Versicherung XY",
        mandateRef: "M-OLD",
        creditorId: "DE88ZZZ8880",
      });
    }
    await runAnomalyDetection([accountId]);
    const open = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.account_id, accountId),
          eq(financeAnomaly.type, "missing_transaction"),
          isNull(financeAnomaly.acknowledged_at),
        ),
      );
    expect(open).toHaveLength(1);
    const staleId = open[0].id;

    // The creditor's payment bank changes; a successor booking with
    // the new mandate_ref arrives a few days ago.
    await insertTx({
      accountId,
      bookingDate: daysAgo(5),
      amount: "-52.00",
      counterparty: "Versicherung XY",
      mandateRef: "M-NEW",
      creditorId: "DE88ZZZ8881",
    });

    await runAnomalyDetection([accountId]);

    const stillOpen = await db
      .select()
      .from(financeAnomaly)
      .where(
        and(
          eq(financeAnomaly.id, staleId),
          isNull(financeAnomaly.acknowledged_at),
        ),
      );
    expect(stillOpen).toHaveLength(0);
  });
});

describe("finance/anomaly-detector — derivePaymentChannel", () => {
  it("classifies ISO BTC family codes", () => {
    expect(derivePaymentChannel({ transaction_type: "RDDT" })).toBe("direct_debit");
    expect(derivePaymentChannel({ transaction_type: "IDDT" })).toBe("direct_debit");
    expect(derivePaymentChannel({ transaction_type: "CCRD" })).toBe("card");
    expect(derivePaymentChannel({ transaction_type: "MCRD" })).toBe("card");
    expect(derivePaymentChannel({ transaction_type: "RCDT" })).toBe("transfer");
    expect(derivePaymentChannel({ transaction_type: "ICDT" })).toBe("transfer");
  });

  it("falls back to entry_text when transaction_type is missing", () => {
    expect(derivePaymentChannel({ entry_text: "Lastschrift" })).toBe("direct_debit");
    expect(derivePaymentChannel({ entry_text: "SEPA-Lastschrift" })).toBe("direct_debit");
    expect(derivePaymentChannel({ entry_text: "Kartenzahlung" })).toBe("card");
    expect(derivePaymentChannel({ entry_text: "Karte Nr. 4871" })).toBe("card");
    expect(derivePaymentChannel({ entry_text: "Überweisung" })).toBe("transfer");
  });

  it("falls back to mandate_ref presence", () => {
    expect(derivePaymentChannel({ mandate_ref: "M-123" })).toBe("direct_debit");
  });

  it("returns other when nothing matches", () => {
    expect(derivePaymentChannel({})).toBe("other");
    expect(derivePaymentChannel({ entry_text: "Zinsen" })).toBe("other");
  });
});

describe("finance/anomaly-detector — payment channel separation", () => {
  it("does NOT fire amount_change when a card payment follows a long-ended direct-debit ABO to the same counterparty", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly direct-debit bookings ending ~400 days ago
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(400 + (7 - i) * 30),
        amount: "-49.00",
        counterparty: "DB Vertrieb GmbH",
        entryText: "Lastschrift",
        transactionType: "RDDT",
        mandateRef: "M-DB-ABO",
        creditorId: "DE00DB000",
      });
    }

    // One-off card payment to the same counterparty, different amount
    await insertTx({
      accountId,
      bookingDate: daysAgo(1),
      amount: "-38.44",
      counterparty: "DB Vertrieb GmbH",
      entryText: "Kartenzahlung",
      transactionType: "CCRD",
    });

    await runAnomalyDetection([accountId]);

    const amountChanges = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "amount_change"));
    expect(amountChanges).toHaveLength(0);

    // The card payment should have created a SEPARATE mandate
    const mandates = await db
      .select()
      .from(financeRecurringMandate)
      .where(eq(financeRecurringMandate.account_id, accountId));
    expect(mandates.length).toBeGreaterThanOrEqual(2);
    const channels = mandates.map((m) => m.payment_channel);
    expect(channels).toContain("direct_debit");
    expect(channels).toContain("card");
  });

  it("keeps same-channel transactions in one mandate", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (let i = 0; i < 3; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(60 - i * 30),
        amount: "-49.00",
        counterparty: "Streaming GmbH",
        entryText: "Lastschrift",
      });
    }

    await runAnomalyDetection([accountId]);

    const mandates = await db
      .select()
      .from(financeRecurringMandate)
      .where(eq(financeRecurringMandate.account_id, accountId));
    expect(mandates).toHaveLength(1);
    expect(mandates[0].payment_channel).toBe("direct_debit");
  });
});

describe("finance/anomaly-detector — text dates in the purpose", () => {
  it("reads ISO and German dates and ignores non-dates", () => {
    expect(extractTextDates("Kartenzahlung 2026-07-07 00:00:00")).toEqual(["2026-07-07"]);
    expect(extractTextDates("Einkauf am 7.7.2026")).toEqual(["2026-07-07"]);
    expect(extractTextDates("Einkauf am 07.07.26")).toEqual(["2026-07-07"]);
    expect(extractTextDates("Einkauf 07.07. Filiale 12")).toEqual(["07-07"]);
    expect(extractTextDates("Karte Nr. 4871 78XX XXXX 8079 Betrag 19.99")).toEqual([]);
    expect(extractTextDates("Beleg 34.99.2026")).toEqual([]);
    expect(extractTextDates(null)).toEqual([]);
  });

  it("contradicts only when both texts name dates and none of them agree", () => {
    const base = "STARBUCKS APP, MUSTERSTADT DE Kartenzahlung";
    expect(purposeDatesContradict(`${base} 2026-07-07`, `${base} 2026-07-09`)).toBe(true);
    expect(purposeDatesContradict(`${base} 2026-07-07`, `${base} 2026-07-07`)).toBe(false);
    // A year-less German date still matches its full-date counterpart.
    expect(purposeDatesContradict(`${base} 07.07.`, `${base} 2026-07-07`)).toBe(false);
    // One side without any date says nothing.
    expect(purposeDatesContradict(`${base} 2026-07-07`, base)).toBe(false);
    expect(purposeDatesContradict(null, `${base} 2026-07-07`)).toBe(false);
  });
});

describe("finance/anomaly-detector — duplicate", () => {
  const CARD_PURPOSE = [
    "STARBUCKS APP, MUSTERSTADT DE",
    "Karte Nr. 0000 00XX XXXX 0000",
    "Kartenzahlung",
  ].join("\n");

  it("does NOT flag two card payments of the same amount on different days", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (const days of [4, 2]) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-5.90",
        counterparty: "STARBUCKS APP, MUSTERSTADT DE",
        entryText: "Kartenzahlung",
        transactionType: "CCRD",
        purpose: CARD_PURPOSE,
      });
    }

    await runAnomalyDetection([accountId]);

    const duplicates = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "duplicate"));
    expect(duplicates).toHaveLength(0);
  });

  it("still flags a card payment booked twice on the same day", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (let i = 0; i < 2; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(2),
        amount: "-5.90",
        counterparty: "STARBUCKS APP, MUSTERSTADT DE",
        entryText: "Kartenzahlung",
        transactionType: "CCRD",
        purpose: CARD_PURPOSE,
      });
    }

    await runAnomalyDetection([accountId]);

    const duplicates = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "duplicate"));
    expect(duplicates).toHaveLength(1);
  });

  it("does NOT flag bookings whose purposes name different transaction dates", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (const [days, textDate] of [[4, "2026-07-07"], [2, "2026-07-09"]] as const) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-5.90",
        counterparty: "Musterhändler GmbH",
        entryText: "Lastschrift",
        transactionType: "RDDT",
        mandateRef: "M-SHOP",
        creditorId: "DE00SHOP0",
        purpose: `Einkauf ${textDate} 00:00:00`,
      });
    }

    await runAnomalyDetection([accountId]);

    const duplicates = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "duplicate"));
    expect(duplicates).toHaveLength(0);
  });

  it("still flags a direct debit booked twice within the window", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    for (const days of [4, 2]) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(days),
        amount: "-49.00",
        counterparty: "Musterhändler GmbH",
        entryText: "Lastschrift",
        transactionType: "RDDT",
        mandateRef: "M-SHOP",
        creditorId: "DE00SHOP0",
        purpose: "Rechnung 2026-07-07",
      });
    }

    await runAnomalyDetection([accountId]);

    const duplicates = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "duplicate"));
    expect(duplicates).toHaveLength(1);
  });
});

describe("finance/anomaly-detector — inactivity gate", () => {
  it("resets mandate baseline when a booking arrives after a long gap", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings, last one 200 days ago
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(200 + (7 - i) * 30),
        amount: "-25.00",
        counterparty: "Verlag XY",
        entryText: "Lastschrift",
      });
    }

    // New booking after a long gap (200 days >> 30 × 4 = 120)
    await insertTx({
      accountId,
      bookingDate: daysAgo(1),
      amount: "-30.00",
      counterparty: "Verlag XY",
      entryText: "Lastschrift",
    });

    await runAnomalyDetection([accountId]);

    // Mandate is reset, not duplicated
    const mandates = await db
      .select()
      .from(financeRecurringMandate)
      .where(eq(financeRecurringMandate.account_id, accountId));
    expect(mandates).toHaveLength(1);
    expect(mandates[0].transaction_count).toBe(1);

    const amountChanges = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "amount_change"));
    expect(amountChanges).toHaveLength(0);
  });

  it("does NOT split a mandate when the gap is within tolerance", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings, last one 50 days ago (gap < 120 days)
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(50 + (7 - i) * 30),
        amount: "-25.00",
        counterparty: "Verlag XY",
        entryText: "Lastschrift",
      });
    }

    // New booking within normal range
    await insertTx({
      accountId,
      bookingDate: daysAgo(1),
      amount: "-25.00",
      counterparty: "Verlag XY",
      entryText: "Lastschrift",
    });

    await runAnomalyDetection([accountId]);

    const mandates = await db
      .select()
      .from(financeRecurringMandate)
      .where(eq(financeRecurringMandate.account_id, accountId));
    expect(mandates).toHaveLength(1);
  });

  it("suppresses amount_change when interval gap is excessive (mandate reset)", async () => {
    await ensureUser(1);
    const accountId = await insertAccount();

    // 8 monthly bookings via counterparty-only matching, ending 500 days ago
    for (let i = 0; i < 8; i++) {
      await insertTx({
        accountId,
        bookingDate: daysAgo(500 + (7 - i) * 30),
        amount: "-49.00",
        counterparty: "Alt GmbH",
      });
    }

    // New booking same counterparty, different amount, after huge gap
    await insertTx({
      accountId,
      bookingDate: daysAgo(1),
      amount: "-38.00",
      counterparty: "Alt GmbH",
    });

    await runAnomalyDetection([accountId]);

    const amountChanges = await db
      .select()
      .from(financeAnomaly)
      .where(eq(financeAnomaly.type, "amount_change"));
    expect(amountChanges).toHaveLength(0);

    // Mandate baseline is reset
    const mandates = await db
      .select()
      .from(financeRecurringMandate)
      .where(eq(financeRecurringMandate.account_id, accountId));
    expect(mandates).toHaveLength(1);
    expect(mandates[0].transaction_count).toBe(1);
  });
});
