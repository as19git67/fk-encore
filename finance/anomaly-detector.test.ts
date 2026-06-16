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
import { runAnomalyDetection } from "./anomaly-detector";

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

interface InsertTxOpts {
  accountId: number;
  bookingDate: string;
  amount: string;
  counterparty: string;
  mandateRef?: string | null;
  creditorId?: string | null;
  counterpartyIban?: string | null;
  purpose?: string | null;
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
      // dedupe_hash is NOT NULL; we don't care about the value beyond
      // uniqueness within a test run.
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
