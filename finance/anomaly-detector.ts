/**
 * Finance anomaly detection: recurring mandate tracking and alert generation.
 *
 * Runs as a daily cron job. For each account the user can read:
 *   1. Find all transactions not yet processed for anomaly detection.
 *   2. Match each to an existing mandate or create a new one.
 *   3. Emit anomalies:
 *      - amount_change:       mandate's typical amount changed by > AMOUNT_CHANGE_THRESHOLD
 *      - duplicate:           same mandate_ref + amount within DUPLICATE_WINDOW_DAYS
 *      - new_mandate:         a newly established recurring pattern above the alert amount
 *      - missing_transaction: a regular mandate's expected next booking is
 *                             overdue past MISSING_GRACE_DAYS.  Emitted in a
 *                             second pass after every account's transactions
 *                             have been processed.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAnomaly,
  financeRecurringMandate,
  financeTransaction,
} from "../db/schema";
import { everyMs, schedule } from "../lib/local-cron";

console.log("[boot] finance/anomaly-detector.ts: all imports resolved");

// -----------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------

/** Minimum relative amount change to emit an amount_change anomaly. */
const AMOUNT_CHANGE_THRESHOLD = 0.15; // 15 %
/** Minimum absolute amount change (EUR) to avoid noise on tiny amounts. */
const AMOUNT_CHANGE_MIN_ABS = 5.00;
/** Days within which a second identical booking is flagged as duplicate. */
const DUPLICATE_WINDOW_DAYS = 5;
/** Newly established recurring patterns above this amount get an alert. */
const NEW_MANDATE_ALERT_AMOUNT = 10;
/** Minimum real bookings required before a series can be called recurring. */
const NEW_RECURRING_MIN_OCCURRENCES = 3;
/** Ignore accidental same-merchant clusters shorter than a working week. */
const NEW_RECURRING_MIN_INTERVAL_DAYS = 5;
/** Annual payments plus calendar jitter still fit below this ceiling. */
const NEW_RECURRING_MAX_INTERVAL_DAYS = 400;
/** Maximum variation of the observed intervals for a new recurring pattern. */
const NEW_RECURRING_INTERVAL_MAX_CV = 0.30;
/** Minimum transactions before we trust the typical_amount baseline. */
const BASELINE_MIN_TRANSACTIONS = 6;
/**
 * Recency window for anomaly emission. Mandate baselines are still updated
 * from older transactions (so the EMA reflects history), but amount_change /
 * duplicate / new_mandate anomalies are only emitted for transactions booked
 * within this window — older anomalies are not actionable.
 */
const ANOMALY_RECENCY_DAYS = 60;
/**
 * Maximum coefficient of variation (stddev / |mean|) of the prior amounts
 * for a mandate before we suppress amount_change alerts. Mandates whose
 * historical amounts already vary a lot (variable utility bills, irregular
 * payments) make a step-change signal unreliable. 0.15 = 15% CV.
 */
const STABILITY_MAX_CV = 0.10;
/** How many recent prior amounts to sample when computing stability. */
const STABILITY_SAMPLE_SIZE = 18;

// ----- missing_transaction tunables -----

/**
 * Mandate intervals we consider eligible for "missing booking" alerts.
 * Lower bound (25 d) skips weekly / very short cadences where day-to-day
 * jitter makes overdue calls unreliable. Upper bound (400 d) covers
 * annual mandates with some headroom for "around the same time next
 * year" drift.
 */
const MISSING_MIN_INTERVAL_DAYS = 25;
const MISSING_MAX_INTERVAL_DAYS = 400;
/**
 * Days the expected booking may be late before we flag it. Roughly one
 * week absorbs weekends, public holidays and bank-side processing
 * delays at month-end.
 */
const MISSING_GRACE_DAYS = 7;
/**
 * Minimum prior bookings before we trust an interval as "regular"
 * enough to predict the next one. Same gate as amount-change baselines.
 */
const MISSING_MIN_OCCURRENCES = BASELINE_MIN_TRANSACTIONS;
/**
 * Maximum coefficient of variation of recent inter-arrival intervals
 * for a mandate to count as "regular". Intervals are noisier than
 * amounts (month lengths, weekends, manual transfers) so we allow more
 * spread than the amount-stability gate. 0.30 ≈ stddev up to 30 % of
 * the mean interval.
 */
const MISSING_INTERVAL_MAX_CV = 0.30;
/**
 * Sample window for the interval-stability check: look at up to this
 * many recent transactions of the mandate to compute inter-arrival CV.
 */
const MISSING_INTERVAL_SAMPLE_SIZE = 12;
/**
 * Hard ceiling for how long ago a mandate's last booking may be before
 * we stop emitting missing alerts. Mandates that haven't fired in over
 * a year are almost certainly cancelled, not "missing".
 */
const MISSING_MAX_LAST_SEEN_AGE_DAYS = 365 * 2;

// -----------------------------------------------------------------------
// Tunables — inactivity gate
// -----------------------------------------------------------------------

/**
 * Maximum factor of typical_interval_days before a returning transaction
 * is treated as a NEW mandate rather than a continuation of the old one.
 * E.g. a monthly mandate (interval ~30 d) must be silent for 30 × 4 = 120
 * days before it's considered lapsed.
 */
const INACTIVITY_INTERVAL_FACTOR = 4;
/**
 * Absolute floor for the inactivity gate — even if interval × factor is
 * smaller, we never split before this many days of silence. Covers edge
 * cases where the EMA interval hasn't converged yet.
 */
const INACTIVITY_MIN_DAYS = 120;

// -----------------------------------------------------------------------
// Payment-channel derivation
// -----------------------------------------------------------------------

type PaymentChannel = "direct_debit" | "card" | "transfer" | "other";

const DIRECT_DEBIT_FAMILIES = new Set(["RDDT", "IDDT"]);
const CARD_FAMILIES = new Set(["CCRD", "MCRD"]);
const TRANSFER_FAMILIES = new Set(["RCDT", "ICDT", "IRCT", "RRCT"]);

/**
 * Derives a coarse payment channel from ISO BTC codes and/or the
 * German MT940 entry text. Used to keep separate mandates for the same
 * counterparty when the payment method differs (e.g. SEPA direct debit
 * vs. card payment).
 */
export function derivePaymentChannel(tx: {
  transaction_type?: string | null;
  entry_text?: string | null;
  mandate_ref?: string | null;
}): PaymentChannel {
  const family = tx.transaction_type?.trim().toUpperCase() ?? "";
  if (DIRECT_DEBIT_FAMILIES.has(family)) return "direct_debit";
  if (CARD_FAMILIES.has(family)) return "card";
  if (TRANSFER_FAMILIES.has(family)) return "transfer";

  const entry = tx.entry_text?.toLowerCase() ?? "";
  if (entry.includes("lastschrift")) return "direct_debit";
  if (entry.includes("kartenzahlung") || entry.includes("karte")) return "card";
  if (entry.includes("überweisung") || entry.includes("ueberweisung")) return "transfer";

  if (tx.mandate_ref) return "direct_debit";

  return "other";
}

// -----------------------------------------------------------------------
// Mandate key helpers
// -----------------------------------------------------------------------

interface MandateKey {
  mandate_ref: string | null;
  creditor_id: string | null;
  counterparty_iban: string | null;
  counterparty: string | null;
  payment_channel: PaymentChannel;
}

function mandateKeyFrom(tx: typeof financeTransaction.$inferSelect): MandateKey {
  return {
    mandate_ref: tx.mandate_ref ?? null,
    creditor_id: tx.creditor_id ?? null,
    counterparty_iban: tx.counterparty_iban ?? null,
    counterparty: tx.counterparty ?? null,
    payment_channel: derivePaymentChannel(tx),
  };
}

/** Returns true when the transaction carries enough identity to be worth tracking. */
function isTrackable(key: MandateKey): boolean {
  return !!(key.mandate_ref || key.creditor_id || key.counterparty_iban || key.counterparty);
}

// -----------------------------------------------------------------------
// Core processing
// -----------------------------------------------------------------------

export interface AnomalyRunResult {
  accounts: number;
  transactions_processed: number;
  mandates_created: number;
  mandates_updated: number;
  anomalies_created: number;
}

export async function runAnomalyDetection(
  accountIds?: number[],
): Promise<AnomalyRunResult> {
  const result: AnomalyRunResult = {
    accounts: 0,
    transactions_processed: 0,
    mandates_created: 0,
    mandates_updated: 0,
    anomalies_created: 0,
  };

  // Alerts created by the old implementation represented a first occurrence,
  // not an established recurring pattern. Hide them without a migration; a
  // qualifying series can create a fresh alert on its actual pattern boundary.
  await acknowledgeLegacyNewMandateAnomalies(accountIds);

  const accountCond = accountIds && accountIds.length > 0
    ? inArray(financeTransaction.account_id, accountIds)
    : undefined;

  // Load all transactions that have no anomaly record yet (left join trick:
  // we detect "not yet processed" by absence from finance_anomaly for
  // type='processed_marker' — simpler approach: process all and rely on
  // the unique index on (transaction_id, type) for idempotency).
  // For performance we only load debit transactions (amount < 0) since
  // recurring mandates are almost always direct debits.
  const transactions = await db
    .select()
    .from(financeTransaction)
    .where(accountCond)
    .orderBy(financeTransaction.account_id, financeTransaction.booking_date);

  // Group by account for mandate lookups
  const byAccount = new Map<number, typeof transactions>();
  for (const tx of transactions) {
    const list = byAccount.get(tx.account_id) ?? [];
    list.push(tx);
    byAccount.set(tx.account_id, list);
  }

  result.accounts = byAccount.size;

  for (const [accountId, txList] of byAccount) {
    const r = await processAccount(accountId, txList);
    result.transactions_processed += r.processed;
    result.mandates_created += r.created;
    result.mandates_updated += r.updated;
    result.anomalies_created += r.anomalies;
  }

  // Missing-transaction pass: run AFTER processAccount has updated
  // every mandate's last_seen / typical_interval_days for the current
  // batch. This pass scans mandates rather than transactions, so it
  // must also visit accounts that produced zero new transactions in
  // this run (those are exactly the ones most likely to be "silent").
  const missingAccountIds = await collectMissingPassAccountIds(accountIds);
  for (const accountId of missingAccountIds) {
    result.anomalies_created += await detectMissingForAccount(accountId);
  }

  return result;
}

async function collectMissingPassAccountIds(
  filter: number[] | undefined,
): Promise<number[]> {
  const rows = filter && filter.length > 0
    ? await db
        .selectDistinct({ id: financeRecurringMandate.account_id })
        .from(financeRecurringMandate)
        .where(inArray(financeRecurringMandate.account_id, filter))
    : await db
        .selectDistinct({ id: financeRecurringMandate.account_id })
        .from(financeRecurringMandate);
  return rows.map((r) => r.id);
}

async function processAccount(
  accountId: number,
  transactions: (typeof financeTransaction.$inferSelect)[],
): Promise<{ processed: number; created: number; updated: number; anomalies: number }> {
  let created = 0, updated = 0, anomalies = 0;

  // Cutoff for general anomaly emission. Mandate updates still happen for all
  // transactions — only the alerting is gated on recency.
  const recencyCutoff = new Date();
  recencyCutoff.setDate(recencyCutoff.getDate() - ANOMALY_RECENCY_DAYS);

  for (const tx of transactions) {
    const key = mandateKeyFrom(tx);
    if (!isTrackable(key)) continue;

    const mandate = await upsertMandate(accountId, key, tx);
    if (!mandate) continue;

    const txDate = new Date(tx.booking_date.slice(0, 10));
    const isRecentForAlerts = txDate >= recencyCutoff;

    if (mandate.isNew) created++;
    else updated++;

    if (!isRecentForAlerts) continue;

    const recurringPattern = await getNewRecurringPattern(
      mandate.id,
      tx.id,
      tx.booking_date,
    );
    if (
      recurringPattern
      && Math.abs(Number(tx.amount)) >= NEW_MANDATE_ALERT_AMOUNT
    ) {
      const predecessor = await hasRecurringPredecessor(
        mandate.id,
        recurringPattern.meanIntervalDays,
      );
      if (predecessor) {
        await acknowledgeNewMandateForMandate(mandate.id);
      } else {
        const inserted = await insertNewRecurringAnomalyIfAbsent({
          account_id: accountId,
          transaction_id: tx.id,
          mandate_id: mandate.id,
          type: "new_mandate",
          score: "0.7000",
          details: {
            counterparty: tx.counterparty,
            amount: tx.amount,
            occurrences: recurringPattern.occurrences,
            interval_days: recurringPattern.meanIntervalDays,
            interval_cv: recurringPattern.intervalCv,
          },
        });
        if (inserted) anomalies++;
      }
    }

    if (!mandate.isNew) {
      // Check for amount change. The flagged transaction must not be older
      // than the reference transactions used to build the baseline —
      // otherwise we'd compare an older booking against a newer baseline,
      // which is meaningless. Skip when this tx predates the mandate's
      // existing last_seen (i.e. a late-arriving historical record).
      const txDateStr = tx.booking_date.slice(0, 10);
      const txIsNotOlderThanBaseline =
        !mandate.previous_last_seen || txDateStr >= mandate.previous_last_seen;
      if (txIsNotOlderThanBaseline) {
        // Compare against the IMMEDIATELY previous transaction for this
        // mandate, not the smoothed EMA. This avoids flagging gradual
        // trends (e.g. 59 → 48 → 47) and only fires on real step-changes.
        const prevTx = await getPrevTransaction(mandate.id, tx.id, txDateStr);
        const prevRaw = prevTx?.amount ?? null;
        if (prevRaw !== null) {
          // Interval guard: suppress amount_change when the gap to the
          // previous transaction vastly exceeds the mandate's cadence.
          // The series was likely cancelled and this is a new, unrelated
          // payment to the same counterparty.
          const prevDate = prevTx!.booking_date.slice(0, 10);
          const gapDays = dateDiffDays(prevDate, txDateStr);
          const typicalInterval = mandate.transaction_count > 1
            ? (await getMandateTypicalInterval(mandate.id)) ?? 30
            : 30;
          const gapThreshold = Math.max(INACTIVITY_MIN_DAYS, typicalInterval * INACTIVITY_INTERVAL_FACTOR);
          if (gapDays <= gapThreshold) {
            const prev = Math.abs(Number(prevRaw));
            const curr = Math.abs(Number(tx.amount));
            const diff = curr - prev;
            const pct = prev > 0 ? diff / prev : 0;

            if (Math.abs(diff) >= AMOUNT_CHANGE_MIN_ABS && Math.abs(pct) >= AMOUNT_CHANGE_THRESHOLD) {
              const cv = await getMandateStabilityCV(mandate.id, tx.id, txDateStr);
              const stable = cv !== null && cv <= STABILITY_MAX_CV;
              if (stable) {
                const score = Math.min(1, Math.abs(pct) * 2).toFixed(4);
                const inserted = await insertAnomalyIfAbsent({
                  account_id: accountId,
                  transaction_id: tx.id,
                  mandate_id: mandate.id,
                  type: "amount_change",
                  score,
                  details: {
                    previous: prev,
                    current: curr,
                    diff: Math.round(diff * 100) / 100,
                    pct: Math.round(pct * 10000) / 100,
                    is_credit: Number(tx.amount) > 0,
                  },
                });
                if (inserted) anomalies++;
              }
            }
          }
        }
      }

      // Check for duplicate within window
      const windowStart = shiftDate(tx.booking_date, -DUPLICATE_WINDOW_DAYS);
      const duplicate = await findDuplicate(tx, mandate.id, windowStart);
      if (duplicate) {
        const inserted = await insertAnomalyIfAbsent({
          account_id: accountId,
          transaction_id: tx.id,
          mandate_id: mandate.id,
          type: "duplicate",
          score: "0.9000",
          details: {
            original_transaction_id: duplicate.id,
            amount: tx.amount,
            booking_date: tx.booking_date,
          },
        });
        if (inserted) anomalies++;
      }
    }
  }

  return { processed: transactions.length, created, updated, anomalies };
}

// -----------------------------------------------------------------------
// Mandate upsert
// -----------------------------------------------------------------------

interface MandateRecord {
  id: number;
  typical_amount: string | null;
  transaction_count: number;
  isNew: boolean;
  /** last_seen value BEFORE this tx was applied (null for new mandates). */
  previous_last_seen: string | null;
}

async function upsertMandate(
  accountId: number,
  key: MandateKey,
  tx: typeof financeTransaction.$inferSelect,
): Promise<MandateRecord | null> {
  const existing = await findMandate(accountId, key);

  const bookingDate = tx.booking_date.slice(0, 10); // normalize to YYYY-MM-DD

  // Inactivity gate: if the existing mandate has been silent for much
  // longer than its typical period, treat this transaction as the start
  // of a fresh series rather than a continuation. This prevents false
  // amount_change alerts when a one-off payment (e.g. card) hits the
  // same counterparty years after an ABO ended.
  const treatAsNew = existing != null && isMandateLapsed(existing, bookingDate);

  if (treatAsNew) {
    await db
      .update(financeRecurringMandate)
      .set({
        typical_amount: tx.amount,
        typical_interval_days: null,
        transaction_count: 1,
        first_seen: bookingDate,
        last_seen: bookingDate,
        payment_channel: key.payment_channel,
        updated_at: sql`NOW()`,
      })
      .where(eq(financeRecurringMandate.id, existing.id));
    return {
      id: existing.id,
      typical_amount: tx.amount,
      transaction_count: 1,
      isNew: true,
      previous_last_seen: null,
    };
  }

  if (!existing) {
    const [row] = await db
      .insert(financeRecurringMandate)
      .values({
        account_id: accountId,
        mandate_ref: key.mandate_ref,
        creditor_id: key.creditor_id,
        counterparty_iban: key.counterparty_iban,
        counterparty: key.counterparty,
        payment_channel: key.payment_channel,
        typical_amount: tx.amount,
        typical_interval_days: null,
        transaction_count: 1,
        first_seen: bookingDate,
        last_seen: bookingDate,
      })
      .returning({ id: financeRecurringMandate.id });
    return {
      id: row.id,
      typical_amount: tx.amount,
      transaction_count: 1,
      isNew: true,
      previous_last_seen: null,
    };
  }

  // Update baseline: running median approximation via weighted average.
  // Weight new value less so the baseline is stable.
  const count = existing.transaction_count + 1;
  const prevAmount = existing.typical_amount !== null ? Number(existing.typical_amount) : Number(tx.amount);
  const newAmount = Number(tx.amount);
  // Use exponential moving average with alpha = 1/count (converges to true mean)
  const alpha = 1 / Math.min(count, 20);
  const updatedAmount = (prevAmount * (1 - alpha) + newAmount * alpha).toFixed(2);

  // Interval: days since last_seen
  let intervalDays: number | null = existing.typical_interval_days;
  if (existing.last_seen) {
    const daysSince = dateDiffDays(existing.last_seen, bookingDate);
    if (daysSince > 0) {
      intervalDays = existing.typical_interval_days !== null
        ? Math.round((existing.typical_interval_days * 0.8) + (daysSince * 0.2))
        : daysSince;
    }
  }

  // Back-fill payment_channel for legacy mandates that predate migration 0129.
  const channelUpdate: Record<string, unknown> = {};
  if (!existing.payment_channel) {
    channelUpdate.payment_channel = key.payment_channel;
  }

  await db
    .update(financeRecurringMandate)
    .set({
      typical_amount: updatedAmount,
      typical_interval_days: intervalDays,
      transaction_count: count,
      last_seen: bookingDate,
      updated_at: sql`NOW()`,
      ...channelUpdate,
    })
    .where(eq(financeRecurringMandate.id, existing.id));

  return {
    id: existing.id,
    typical_amount: existing.typical_amount,
    transaction_count: existing.transaction_count,
    isNew: false,
    previous_last_seen: existing.last_seen ?? null,
  };
}

function isMandateLapsed(
  mandate: typeof financeRecurringMandate.$inferSelect,
  bookingDate: string,
): boolean {
  if (!mandate.last_seen) return false;
  const gap = dateDiffDays(mandate.last_seen, bookingDate);
  if (gap <= 0) return false;
  const interval = mandate.typical_interval_days ?? 30;
  const threshold = Math.max(
    INACTIVITY_MIN_DAYS,
    interval * INACTIVITY_INTERVAL_FACTOR,
  );
  return gap > threshold;
}

async function findMandate(
  accountId: number,
  key: MandateKey,
): Promise<typeof financeRecurringMandate.$inferSelect | undefined> {
  // Priority: mandate_ref+creditor_id → iban+channel → name+channel
  //
  // Tier 1 (SEPA identity) is exact enough that payment_channel is
  // redundant. Tiers 2+3 add a channel gate so a Lastschrift and a
  // Kartenzahlung to the same counterparty form separate mandates.
  // Legacy mandates (payment_channel IS NULL) match any channel so
  // existing data keeps working without a backfill.
  if (key.mandate_ref && key.creditor_id) {
    const [row] = await db
      .select()
      .from(financeRecurringMandate)
      .where(
        and(
          eq(financeRecurringMandate.account_id, accountId),
          eq(financeRecurringMandate.mandate_ref, key.mandate_ref),
          eq(financeRecurringMandate.creditor_id, key.creditor_id),
        )
      )
      .limit(1);
    if (row) return row;
  }

  if (key.counterparty_iban && !key.mandate_ref && !key.creditor_id) {
    const [row] = await db
      .select()
      .from(financeRecurringMandate)
      .where(
        and(
          eq(financeRecurringMandate.account_id, accountId),
          eq(financeRecurringMandate.counterparty_iban, key.counterparty_iban),
          isNull(financeRecurringMandate.mandate_ref),
          isNull(financeRecurringMandate.creditor_id),
          paymentChannelMatch(key.payment_channel),
        )
      )
      .limit(1);
    if (row) return row;
  }

  if (key.counterparty && !key.mandate_ref && !key.creditor_id && !key.counterparty_iban) {
    const [row] = await db
      .select()
      .from(financeRecurringMandate)
      .where(
        and(
          eq(financeRecurringMandate.account_id, accountId),
          eq(financeRecurringMandate.counterparty, key.counterparty),
          isNull(financeRecurringMandate.mandate_ref),
          isNull(financeRecurringMandate.creditor_id),
          isNull(financeRecurringMandate.counterparty_iban),
          paymentChannelMatch(key.payment_channel),
        )
      )
      .limit(1);
    if (row) return row;
  }

  return undefined;
}

/**
 * SQL condition: mandate.payment_channel must equal the given channel
 * OR be NULL (legacy row that predates migration 0129).
 */
function paymentChannelMatch(channel: PaymentChannel) {
  return sql`(${financeRecurringMandate.payment_channel} = ${channel} OR ${financeRecurringMandate.payment_channel} IS NULL)`;
}

/**
 * Coefficient of variation (stddev / |mean|) of the most recent prior
 * amounts for a mandate. Returns null when there are too few samples to
 * judge stability. The candidate transaction itself is excluded.
 */
async function getMandateStabilityCV(
  mandateId: number,
  excludingTxId: number,
  beforeBookingDate: string,
): Promise<number | null> {
  const rows = await db.execute<{ amount: string }>(sql`
    SELECT ft.amount
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = frm.account_id
      AND ft.id <> ${excludingTxId}
      AND ft.booking_date < ${beforeBookingDate}
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
    ORDER BY ft.booking_date DESC
    LIMIT ${STABILITY_SAMPLE_SIZE}
  `);
  const values = rows.rows.map((r) => Math.abs(Number(r.amount))).filter((n) => Number.isFinite(n));
  if (values.length < BASELINE_MIN_TRANSACTIONS) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  return stddev / Math.abs(mean);
}

/**
 * Returns the most recent prior transaction for the same mandate
 * (chronologically before the candidate). Used as the comparison
 * reference for amount_change anomalies — comparing against the immediate
 * predecessor avoids flagging gradual drift. Also returns booking_date
 * so callers can compute the inter-arrival gap.
 */
async function getPrevTransaction(
  mandateId: number,
  excludingTxId: number,
  beforeBookingDate: string,
): Promise<{ amount: string; booking_date: string } | null> {
  const rows = await db.execute<{ amount: string; booking_date: string }>(sql`
    SELECT ft.amount, ft.booking_date
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = frm.account_id
      AND ft.id <> ${excludingTxId}
      AND ft.booking_date < ${beforeBookingDate}
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
    ORDER BY ft.booking_date DESC, ft.id DESC
    LIMIT 1
  `);
  return rows.rows[0] ?? null;
}

/**
 * Median-ish typical interval from actual transaction dates for a mandate.
 * Returns null when fewer than 2 transactions exist.
 */
async function getMandateTypicalInterval(mandateId: number): Promise<number | null> {
  const rows = await db.execute<{ booking_date: string }>(sql`
    SELECT ft.booking_date
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = frm.account_id
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
    ORDER BY ft.booking_date DESC
    LIMIT 12
  `);
  const dates = rows.rows.map((r) => r.booking_date.slice(0, 10)).sort();
  if (dates.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = dateDiffDays(dates[i - 1], dates[i]);
    if (gap > 0) intervals.push(gap);
  }
  if (intervals.length === 0) return null;
  return Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
}

async function findDuplicate(
  tx: typeof financeTransaction.$inferSelect,
  mandateId: number,
  windowStart: string,
): Promise<{ id: number } | undefined> {
  // Find a prior transaction linked to the same mandate with the same amount
  // within the duplicate window. We join through finance_recurring_mandate to
  // confirm the other transaction shares the same mandate (via mandate_id on
  // the anomaly that was already created for it, OR by matching mandate fields
  // directly on the transaction).
  const rows = await db.execute<{ id: number }>(sql`
    SELECT ft.id
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = ${tx.account_id}
      AND ft.amount = ${tx.amount}
      AND ft.booking_date >= ${windowStart}
      AND ft.booking_date < ${tx.booking_date}
      AND ft.id <> ${tx.id}
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
    LIMIT 1
  `);
  return rows.rows[0] ?? undefined;
}

// -----------------------------------------------------------------------
// Missing-transaction pass
// -----------------------------------------------------------------------

/**
 * For one account: scan every recurring mandate and emit a
 * missing_transaction anomaly when the next expected booking is
 * overdue past MISSING_GRACE_DAYS with no matching transaction.
 *
 * One anomaly per mandate per cron run, gated by the partial unique
 * index on (mandate_id, details->>'expected_date'). When a mandate is
 * silent for multiple periods we only emit the OLDEST missed slot
 * (closest to last_seen) — once the user acknowledges or the mandate
 * resumes, follow-up slots can fire on the next run.
 */
async function detectMissingForAccount(accountId: number): Promise<number> {
  // Use today (local server clock) as the reference. The cron job runs
  // daily, so this is the most current view available.
  const today = new Date();
  const todayStr = toIsoDate(today);

  const mandates = await db
    .select()
    .from(financeRecurringMandate)
    .where(eq(financeRecurringMandate.account_id, accountId));

  let inserted = 0;

  for (const mandate of mandates) {
    if (mandate.transaction_count < MISSING_MIN_OCCURRENCES) continue;
    if (mandate.typical_interval_days === null) continue;
    if (mandate.typical_interval_days < MISSING_MIN_INTERVAL_DAYS) continue;
    if (mandate.typical_interval_days > MISSING_MAX_INTERVAL_DAYS) continue;
    if (!mandate.last_seen) continue;

    // Cancellation guard: stop alerting on mandates that have been
    // silent for so long they are almost certainly no longer active.
    const daysSinceLastSeen = dateDiffDays(mandate.last_seen, todayStr);
    if (daysSinceLastSeen > MISSING_MAX_LAST_SEEN_AGE_DAYS) continue;

    const expectedDate = shiftDate(mandate.last_seen, mandate.typical_interval_days);
    const dueDate = shiftDate(expectedDate, MISSING_GRACE_DAYS);
    // Not yet overdue past the grace window — nothing to flag.
    if (todayStr < dueDate) continue;

    // Successor-activity guard: a creditor or the user changing banks can
    // move a recurring series to a new mandate identity and even a different
    // account. Match same-account exact names as before; across accounts use
    // shared write access plus merchant, amount and cadence safeguards.
    // Suppress the missing alert and close any stale one already in the inbox.
    if (await hasSuccessorActivity(mandate)) {
      await acknowledgeStaleMissingForMandate(mandate.id);
      continue;
    }

    // Interval stability: if the historical intervals between bookings
    // already vary a lot, a single skipped period is unreliable signal.
    const intervalCv = await getMandateIntervalCV(mandate.id);
    if (intervalCv === null || intervalCv > MISSING_INTERVAL_MAX_CV) continue;

    const detailsPayload = {
      expected_date: expectedDate,
      last_seen: mandate.last_seen,
      interval_days: mandate.typical_interval_days,
      expected_amount: mandate.typical_amount,
      days_overdue: dateDiffDays(expectedDate, todayStr),
    };
    const created = await insertMissingAnomalyIfAbsent({
      account_id: accountId,
      mandate_id: mandate.id,
      type: "missing_transaction",
      score: scoreForMissing(dateDiffDays(expectedDate, todayStr), mandate.typical_interval_days),
      details: detailsPayload,
    });
    if (created) inserted++;
  }

  return inserted;
}

/**
 * True when the recurring series plausibly continues after last_seen under a
 * different mandate identity. Candidates may be on the same account or on an
 * account writable by the same user. Cross-account candidates additionally
 * have to match merchant, amount direction/range and cadence.
 *
 * Returns false for mandates without a counterparty (we have no
 * stable key to match a successor on).
 */
async function hasSuccessorActivity(
  mandate: typeof financeRecurringMandate.$inferSelect,
): Promise<boolean> {
  if (!mandate.counterparty || !mandate.last_seen) return false;
  const rows = await db.execute<{
    id: number;
    account_id: number;
    booking_date: string;
    amount: string;
    counterparty: string;
    exact_same_account_name: boolean;
  }>(sql`
    SELECT DISTINCT
      ft.id,
      ft.account_id,
      ft.booking_date,
      ft.amount,
      ft.counterparty,
      (
        ft.account_id = ${mandate.account_id}
        AND LOWER(TRIM(ft.counterparty)) = LOWER(TRIM(${mandate.counterparty}))
      ) AS exact_same_account_name
    FROM finance_transaction ft
    WHERE ft.booking_date > ${mandate.last_seen}
      AND ft.counterparty IS NOT NULL
      AND (
        ft.account_id = ${mandate.account_id}
        OR EXISTS (
          SELECT 1
          FROM finance_account_access old_acl
          JOIN finance_account_access new_acl
            ON new_acl.user_id = old_acl.user_id
          WHERE old_acl.account_id = ${mandate.account_id}
            AND new_acl.account_id = ft.account_id
            AND old_acl.level = 'write'
            AND new_acl.level = 'write'
        )
      )
    ORDER BY exact_same_account_name DESC, ft.booking_date ASC, ft.id ASC
    LIMIT 500
  `);
  return rows.rows.some((candidate) => {
    // Preserve the established same-account behaviour for an exact name.
    if (candidate.exact_same_account_name) {
      return true;
    }
    return isLikelySeriesContinuation({
      previousCounterparty: mandate.counterparty!,
      nextCounterparty: candidate.counterparty,
      previousAmount: mandate.typical_amount,
      nextAmount: candidate.amount,
      previousDate: mandate.last_seen!,
      nextDate: candidate.booking_date,
      intervalDays: mandate.typical_interval_days,
    });
  });
}

interface SeriesContinuationInput {
  previousCounterparty: string;
  nextCounterparty: string;
  previousAmount: string | null;
  nextAmount: string | null;
  previousDate: string;
  nextDate: string;
  intervalDays: number | null;
}

const COMPANY_SUFFIXES = new Set([
  "ag", "co", "eg", "ev", "gbr", "gmbh", "inc", "kg", "kgaa", "ltd", "mbh", "se",
]);

export function normalizeCounterparty(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-DE")
    .replace(/&/g, " und ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !COMPANY_SUFFIXES.has(token))
    .join(" ");
}

export function counterpartySimilarity(left: string, right: string): number {
  const a = normalizeCounterparty(left);
  const b = normalizeCounterparty(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a))) return 0.9;
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  let intersection = 0;
  for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
  return intersection / new Set([...aTokens, ...bTokens]).size;
}

function isLikelySeriesContinuation(input: SeriesContinuationInput): boolean {
  if (counterpartySimilarity(input.previousCounterparty, input.nextCounterparty) < 0.8) {
    return false;
  }
  if (input.previousAmount === null || input.nextAmount === null) return false;
  const previousAmount = Number(input.previousAmount);
  const nextAmount = Number(input.nextAmount);
  if (!Number.isFinite(previousAmount) || !Number.isFinite(nextAmount)) return false;
  if (Math.sign(previousAmount) !== Math.sign(nextAmount) || previousAmount === 0) return false;
  const amountTolerance = Math.max(5, Math.abs(previousAmount) * 0.25);
  if (Math.abs(Math.abs(previousAmount) - Math.abs(nextAmount)) > amountTolerance) return false;

  const gapDays = dateDiffDays(input.previousDate, input.nextDate);
  const maxGapDays = Math.max(120, (input.intervalDays ?? 30) * 4);
  return gapDays > 0 && gapDays <= maxGapDays;
}

/**
 * A new mandate identity is not a new recurring payment when an established
 * series on the same account — or another account writable by the same user —
 * ended shortly before it with matching merchant, amount and cadence.
 */
async function hasRecurringPredecessor(
  mandateId: number,
  fallbackIntervalDays: number,
): Promise<boolean> {
  const [current] = await db
    .select()
    .from(financeRecurringMandate)
    .where(eq(financeRecurringMandate.id, mandateId))
    .limit(1);
  if (!current?.counterparty || !current.first_seen) return false;

  const rows = await db.execute<{
    id: number;
    account_id: number;
    counterparty: string;
    typical_amount: string | null;
    typical_interval_days: number | null;
    last_seen: string;
  }>(sql`
    SELECT DISTINCT
      previous.id,
      previous.account_id,
      previous.counterparty,
      previous.typical_amount,
      previous.typical_interval_days,
      previous.last_seen
    FROM finance_recurring_mandate previous
    WHERE previous.id <> ${current.id}
      AND previous.transaction_count >= ${BASELINE_MIN_TRANSACTIONS}
      AND previous.counterparty IS NOT NULL
      AND previous.last_seen IS NOT NULL
      AND previous.last_seen < ${current.first_seen}
      AND (
        previous.account_id = ${current.account_id}
        OR EXISTS (
          SELECT 1
          FROM finance_account_access previous_acl
          JOIN finance_account_access current_acl
            ON current_acl.user_id = previous_acl.user_id
          WHERE previous_acl.account_id = previous.account_id
            AND current_acl.account_id = ${current.account_id}
            AND previous_acl.level = 'write'
            AND current_acl.level = 'write'
        )
      )
  `);

  return rows.rows.some((previous) => isLikelySeriesContinuation({
    previousCounterparty: previous.counterparty,
    nextCounterparty: current.counterparty!,
    previousAmount: previous.typical_amount,
    nextAmount: current.typical_amount,
    previousDate: previous.last_seen,
    nextDate: current.first_seen!,
    intervalDays: previous.typical_interval_days ?? fallbackIntervalDays,
  }));
}

async function acknowledgeNewMandateForMandate(mandateId: number): Promise<void> {
  await db
    .update(financeAnomaly)
    .set({ acknowledged_at: sql`NOW()` })
    .where(and(
      eq(financeAnomaly.mandate_id, mandateId),
      eq(financeAnomaly.type, "new_mandate"),
      isNull(financeAnomaly.acknowledged_at),
    ));
}

/**
 * Auto-acknowledge open missing_transaction anomalies for a mandate
 * whose recurring series has been resumed under a different mandate
 * identity. Idempotent — if nothing is open, this is a no-op.
 */
async function acknowledgeStaleMissingForMandate(mandateId: number): Promise<void> {
  await db
    .update(financeAnomaly)
    .set({ acknowledged_at: sql`NOW()` })
    .where(
      and(
        eq(financeAnomaly.mandate_id, mandateId),
        eq(financeAnomaly.type, "missing_transaction"),
        isNull(financeAnomaly.acknowledged_at),
      ),
    );
}

/**
 * Coefficient of variation of inter-arrival intervals for the most
 * recent bookings of a mandate. Returns null when there are too few
 * samples (we need MISSING_MIN_OCCURRENCES dates → MISSING_MIN_OCCURRENCES-1 intervals).
 */
async function getMandateIntervalCV(mandateId: number): Promise<number | null> {
  const rows = await db.execute<{ booking_date: string }>(sql`
    SELECT ft.booking_date
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = frm.account_id
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
    ORDER BY ft.booking_date DESC
    LIMIT ${MISSING_INTERVAL_SAMPLE_SIZE}
  `);
  const dates = rows.rows.map((r) => r.booking_date.slice(0, 10)).sort();
  if (dates.length < MISSING_MIN_OCCURRENCES) return null;
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    intervals.push(dateDiffDays(dates[i - 1], dates[i]));
  }
  if (intervals.length === 0) return null;
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean === 0) return null;
  const variance =
    intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

interface RecurringPattern {
  occurrences: number;
  meanIntervalDays: number;
  intervalCv: number;
}

/**
 * Detect the point at which a real transaction history first establishes a
 * recurring pattern. Only bookings up to the candidate are considered, so an
 * older transaction can never gain knowledge from future bookings during a
 * full detector rerun.
 */
async function getNewRecurringPattern(
  mandateId: number,
  transactionId: number,
  bookingDate: string,
): Promise<RecurringPattern | null> {
  const rows = await db.execute<{ booking_date: string }>(sql`
    SELECT ft.booking_date
    FROM finance_transaction ft
    JOIN finance_recurring_mandate frm ON frm.id = ${mandateId}
    WHERE ft.account_id = frm.account_id
      AND (
        (frm.mandate_ref IS NOT NULL AND ft.mandate_ref = frm.mandate_ref)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NOT NULL AND ft.counterparty_iban = frm.counterparty_iban)
        OR (frm.mandate_ref IS NULL AND frm.counterparty_iban IS NULL AND ft.counterparty = frm.counterparty)
      )
      AND (
        ft.booking_date < ${bookingDate}
        OR (ft.booking_date = ${bookingDate} AND ft.id <= ${transactionId})
      )
    ORDER BY ft.booking_date DESC, ft.id DESC
    LIMIT ${MISSING_INTERVAL_SAMPLE_SIZE}
  `);
  const dates = rows.rows.map((row) => row.booking_date.slice(0, 10)).sort();
  if (dates.length < NEW_RECURRING_MIN_OCCURRENCES) return null;

  const intervals = dates.slice(1).map((date, index) => dateDiffDays(dates[index], date));
  if (intervals.some((days) => days <= 0)) return null;
  const mean = intervals.reduce((sum, days) => sum + days, 0) / intervals.length;
  if (mean < NEW_RECURRING_MIN_INTERVAL_DAYS || mean > NEW_RECURRING_MAX_INTERVAL_DAYS) return null;
  const variance = intervals.reduce((sum, days) => sum + (days - mean) ** 2, 0) / intervals.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv > NEW_RECURRING_INTERVAL_MAX_CV) return null;

  return {
    occurrences: dates.length,
    meanIntervalDays: Math.round(mean),
    intervalCv: Math.round(cv * 10000) / 10000,
  };
}

/**
 * Severity 0..1 — grows with how late the booking is relative to the
 * mandate's own period. Pinned to 0.95 max so it sorts below true
 * duplicates (0.9) only when very stale; capped at 0.95.
 */
function scoreForMissing(daysOverdue: number, intervalDays: number): string {
  // Days late as a fraction of one full period; 1.0 means "an entire
  // period has passed since the booking was due".
  const ratio = intervalDays > 0 ? daysOverdue / intervalDays : 1;
  const clamped = Math.max(0.5, Math.min(0.95, 0.5 + ratio * 0.5));
  return clamped.toFixed(4);
}

async function insertMissingAnomalyIfAbsent(values: {
  account_id: number;
  mandate_id: number;
  type: string;
  score: string;
  details: Record<string, unknown>;
}): Promise<boolean> {
  // Cannot use Drizzle's onConflictDoNothing here: the target index is
  // a partial expression index, not a column constraint, and Drizzle
  // refuses to infer the conflict target. Pre-check by expected_date.
  const existing = await db
    .select({ id: financeAnomaly.id })
    .from(financeAnomaly)
    .where(
      and(
        eq(financeAnomaly.mandate_id, values.mandate_id),
        eq(financeAnomaly.type, values.type),
        isNull(financeAnomaly.transaction_id),
        sql`(${financeAnomaly.details} ->> 'expected_date') = ${String(values.details.expected_date)}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return false;

  try {
    const result = await db
      .insert(financeAnomaly)
      .values(values)
      .returning({ id: financeAnomaly.id });
    return result.length > 0;
  } catch (err) {
    // Race: another concurrent run beat us to the unique index. Treat
    // as "already inserted" rather than surfacing the error.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: string }).code === "23505";
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// -----------------------------------------------------------------------
// Anomaly insert (idempotent via unique index)
// -----------------------------------------------------------------------

async function insertAnomalyIfAbsent(values: {
  account_id: number;
  transaction_id: number;
  mandate_id: number;
  type: string;
  score: string;
  details: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const result = await db
      .insert(financeAnomaly)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: financeAnomaly.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

async function insertNewRecurringAnomalyIfAbsent(values: {
  account_id: number;
  transaction_id: number;
  mandate_id: number;
  type: string;
  score: string;
  details: Record<string, unknown>;
}): Promise<boolean> {
  const [existing] = await db
    .select({ id: financeAnomaly.id })
    .from(financeAnomaly)
    .where(
      and(
        eq(financeAnomaly.mandate_id, values.mandate_id),
        eq(financeAnomaly.type, "new_mandate"),
      ),
    )
    .limit(1);
  if (existing) return false;
  return insertAnomalyIfAbsent(values);
}

async function acknowledgeLegacyNewMandateAnomalies(accountIds?: number[]): Promise<void> {
  const conditions = [
    eq(financeAnomaly.type, "new_mandate"),
    isNull(financeAnomaly.acknowledged_at),
    sql`NOT COALESCE(${financeAnomaly.details} ? 'occurrences', FALSE)`,
  ];
  if (accountIds && accountIds.length > 0) {
    conditions.push(inArray(financeAnomaly.account_id, accountIds));
  }
  await db
    .update(financeAnomaly)
    .set({ acknowledged_at: sql`NOW()` })
    .where(and(...conditions));
}

// -----------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr.slice(0, 10));
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateDiffDays(from: string, to: string): number {
  const a = new Date(from.slice(0, 10));
  const b = new Date(to.slice(0, 10));
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// -----------------------------------------------------------------------
// Cron
// -----------------------------------------------------------------------

export const runAnomalyDetectionJob = api(
  { expose: false, method: "POST", path: "/internal/finance/anomaly-detection" },
  async (): Promise<AnomalyRunResult> => {
    const result = await runAnomalyDetection();
    console.log(
      `[finance.anomaly] done: accounts=${result.accounts} txs=${result.transactions_processed} ` +
      `mandates_created=${result.mandates_created} mandates_updated=${result.mandates_updated} ` +
      `anomalies=${result.anomalies_created}`,
    );
    return result;
  },
);

export const triggerAnomalyDetection = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/anomalies/run",
    auth: true,
  },
  async ({ reset }: { reset?: boolean }): Promise<AnomalyRunResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (reset) {
      await db.delete(financeAnomaly).where(isNull(financeAnomaly.acknowledged_at));
    }
    return runAnomalyDetectionJob();
  },
);


schedule({
  name: "finance-anomaly-detection",
  description: "Detect recurring mandate changes and duplicate transactions",
  service: "finance",
  scheduleLabel: "every 24h",
  nextFire: everyMs(24 * 60 * 60_000),
  run: () => runAnomalyDetectionJob(),
});

// -----------------------------------------------------------------------
// Public API endpoints
// -----------------------------------------------------------------------

export interface DuplicateTransactionInfo {
  id: number;
  booking_date: string;
  amount: string;
  purpose: string | null;
}

export interface AnomalyItem {
  id: number;
  type: string;
  score: number;
  details: Record<string, unknown>;
  created_at: string;
  transaction_id: number | null;
  mandate_id: number | null;
  counterparty: string | null;
  /** Human-readable German description generated from details. */
  message: string;
  /** Only set for type=duplicate: the two (or more) matching transactions. */
  duplicate_transactions?: DuplicateTransactionInfo[];
}

export interface ListAnomaliesResponse {
  anomalies: AnomalyItem[];
  total: number;
}

export const listAnomalies = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/anomalies",
    auth: true,
  },
  async (): Promise<ListAnomaliesResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // The anomaly feed is an actionable inbox — entries get acknowledged or
    // followed up with edits. We therefore only show anomalies on accounts
    // the caller has WRITE access to. `finance.admin` does NOT bypass this:
    // an admin without an explicit account-access row sees nothing here, by
    // design, since they have no business acknowledging alerts they don't
    // own.
    const writeable = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(
        and(
          eq(financeAccountAccess.user_id, Number(auth.userID)),
          eq(financeAccountAccess.level, "write"),
        ),
      );
    const accountIds = writeable.map((a) => a.id);
    if (accountIds.length === 0) return { anomalies: [], total: 0 };

    const rows = await db
      .select({
        id: financeAnomaly.id,
        type: financeAnomaly.type,
        score: financeAnomaly.score,
        details: financeAnomaly.details,
        created_at: financeAnomaly.created_at,
        transaction_id: financeAnomaly.transaction_id,
        mandate_id: financeAnomaly.mandate_id,
        counterparty: financeRecurringMandate.counterparty,
      })
      .from(financeAnomaly)
      .leftJoin(
        financeRecurringMandate,
        eq(financeRecurringMandate.id, financeAnomaly.mandate_id),
      )
      .where(
        and(
          inArray(financeAnomaly.account_id, accountIds),
          isNull(financeAnomaly.acknowledged_at),
        )
      )
      .orderBy(sql`${financeAnomaly.created_at} DESC`)
      .limit(200);

    // Collect all transaction IDs needed for duplicate enrichment
    const duplicateRows = rows.filter((r) => r.type === "duplicate");
    const dupTxIds = new Set<number>();
    for (const r of duplicateRows) {
      if (r.transaction_id) dupTxIds.add(r.transaction_id);
      const orig = Number((r.details as Record<string, unknown>)?.original_transaction_id ?? 0);
      if (orig > 0) dupTxIds.add(orig);
    }

    // Batch-load all relevant transactions in one query
    const txMap = new Map<number, DuplicateTransactionInfo>();
    if (dupTxIds.size > 0) {
      const txRows = await db
        .select({
          id: financeTransaction.id,
          booking_date: financeTransaction.booking_date,
          amount: financeTransaction.amount,
          purpose: financeTransaction.purpose,
        })
        .from(financeTransaction)
        .where(inArray(financeTransaction.id, [...dupTxIds]));
      for (const t of txRows) {
        txMap.set(t.id, {
          id: t.id,
          booking_date: t.booking_date,
          amount: t.amount,
          purpose: t.purpose ?? null,
        });
      }
    }

    const anomalies = rows.map((r) => {
      const details = (r.details ?? {}) as Record<string, unknown>;
      let duplicate_transactions: DuplicateTransactionInfo[] | undefined;
      if (r.type === "duplicate") {
        const txs: DuplicateTransactionInfo[] = [];
        const origId = Number(details.original_transaction_id ?? 0);
        if (origId > 0 && txMap.has(origId)) txs.push(txMap.get(origId)!);
        if (r.transaction_id && txMap.has(r.transaction_id)) txs.push(txMap.get(r.transaction_id)!);
        // Sort oldest first so the list reads chronologically
        txs.sort((a, b) => a.booking_date.localeCompare(b.booking_date));
        if (txs.length > 0) duplicate_transactions = txs;
      }
      return {
        id: r.id,
        type: r.type,
        score: Number(r.score),
        details,
        created_at: r.created_at,
        transaction_id: r.transaction_id,
        mandate_id: r.mandate_id,
        counterparty: r.counterparty ?? null,
        message: buildMessage(r.type, details, r.counterparty),
        duplicate_transactions,
      };
    });

    return { anomalies, total: anomalies.length };
  },
);

export const acknowledgeAnomaly = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/anomalies/:id/acknowledge",
    auth: true,
  },
  async ({ id }: { id: number }): Promise<{ ok: boolean }> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // Acknowledging is a mutation: same write-only ACL as listAnomalies.
    const writeable = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(
        and(
          eq(financeAccountAccess.user_id, Number(auth.userID)),
          eq(financeAccountAccess.level, "write"),
        ),
      );
    const accountIds = writeable.map((a) => a.id);
    if (accountIds.length === 0) throw APIError.notFound("anomaly not found");

    const result = await db
      .update(financeAnomaly)
      .set({ acknowledged_at: sql`NOW()` })
      .where(
        and(
          eq(financeAnomaly.id, id),
          inArray(financeAnomaly.account_id, accountIds),
          isNull(financeAnomaly.acknowledged_at),
        )
      );
    const updated = (result as any).rowCount ?? 0;
    if (updated === 0) throw APIError.notFound("anomaly not found");
    return { ok: true };
  },
);

// -----------------------------------------------------------------------
// Mandate history: recent transactions for a given mandate, used by the UI
// to show the trend behind an amount_change anomaly.
// -----------------------------------------------------------------------

export interface MandateHistoryItem {
  id: number;
  booking_date: string;
  amount: string;
  purpose: string | null;
}

export interface MandateHistoryResponse {
  mandate_id: number;
  counterparty: string | null;
  items: MandateHistoryItem[];
}

export const getMandateHistory = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/mandates/:mandateId/history",
    auth: true,
  },
  async ({ mandateId }: { mandateId: number }): Promise<MandateHistoryResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // Read-only view: any account-access level (read or write) is enough.
    // No admin bypass — admins must hold an explicit account-access row.
    const accessible = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
    const accountIds = accessible.map((a) => a.id);
    if (accountIds.length === 0) throw APIError.notFound("mandate not found");

    const [mandate] = await db
      .select()
      .from(financeRecurringMandate)
      .where(
        and(
          eq(financeRecurringMandate.id, mandateId),
          inArray(financeRecurringMandate.account_id, accountIds),
        ),
      )
      .limit(1);
    if (!mandate) throw APIError.notFound("mandate not found");

    // Match transactions belonging to this mandate using the same fallback
    // chain that mandates were keyed on (mandate_ref+creditor_id → iban → name).
    const rows = await db.execute<{ id: number; booking_date: string; amount: string; purpose: string | null }>(sql`
      SELECT ft.id, ft.booking_date, ft.amount, ft.purpose
      FROM finance_transaction ft
      WHERE ft.account_id = ${mandate.account_id}
        AND (
          (${mandate.mandate_ref}::text IS NOT NULL AND ft.mandate_ref = ${mandate.mandate_ref})
          OR (${mandate.mandate_ref}::text IS NULL
              AND ${mandate.counterparty_iban}::text IS NOT NULL
              AND ft.counterparty_iban = ${mandate.counterparty_iban})
          OR (${mandate.mandate_ref}::text IS NULL
              AND ${mandate.counterparty_iban}::text IS NULL
              AND ${mandate.counterparty}::text IS NOT NULL
              AND ft.counterparty = ${mandate.counterparty})
        )
      ORDER BY ft.booking_date DESC
      LIMIT 24
    `);

    return {
      mandate_id: mandate.id,
      counterparty: mandate.counterparty,
      items: rows.rows.map((r) => ({
        id: r.id,
        booking_date: r.booking_date,
        amount: r.amount,
        purpose: r.purpose ?? null,
      })),
    };
  },
);

// -----------------------------------------------------------------------
// Recurring transactions for a single transaction.
//
// Resolves the mandate the transaction belongs to (if any) and returns
// the same history list the anomaly view shows for amount_change /
// new_mandate alerts. Returns mandate_id=null + empty items when the
// transaction is not part of any tracked recurring series — the UI uses
// that as the "no recurring partners" empty state.
//
// Mandate matching mirrors the priority chain that anomaly detection
// itself uses: mandate_ref → counterparty_iban → counterparty.
// -----------------------------------------------------------------------

export interface RelatedRecurringResponse {
  mandate_id: number | null;
  counterparty: string | null;
  items: MandateHistoryItem[];
}

export const getRelatedRecurringTransactions = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions/:id/recurring",
    auth: true,
  },
  async ({ id }: { id: number }): Promise<RelatedRecurringResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    // Read-only view, any access level on the source account is enough.
    // No admin bypass — admins must hold an explicit account-access row.
    const accessible = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
    const accountIds = accessible.map((a) => a.id);
    if (accountIds.length === 0) {
      throw APIError.notFound(`transaction ${id} not found`);
    }

    const [tx] = await db
      .select({
        id: financeTransaction.id,
        account_id: financeTransaction.account_id,
        mandate_ref: financeTransaction.mandate_ref,
        counterparty_iban: financeTransaction.counterparty_iban,
        counterparty: financeTransaction.counterparty,
      })
      .from(financeTransaction)
      .where(
        and(
          eq(financeTransaction.id, id),
          inArray(financeTransaction.account_id, accountIds),
        ),
      )
      .limit(1);
    if (!tx) throw APIError.notFound(`transaction ${id} not found`);

    // Walk the priority chain to find the mandate this transaction
    // belongs to. Try each key in turn; the first match wins.
    const conditions = [];
    if (tx.mandate_ref) {
      conditions.push(
        and(
          eq(financeRecurringMandate.account_id, tx.account_id),
          eq(financeRecurringMandate.mandate_ref, tx.mandate_ref),
        ),
      );
    }
    if (tx.counterparty_iban) {
      conditions.push(
        and(
          eq(financeRecurringMandate.account_id, tx.account_id),
          isNull(financeRecurringMandate.mandate_ref),
          eq(financeRecurringMandate.counterparty_iban, tx.counterparty_iban),
        ),
      );
    }
    if (tx.counterparty) {
      conditions.push(
        and(
          eq(financeRecurringMandate.account_id, tx.account_id),
          isNull(financeRecurringMandate.mandate_ref),
          isNull(financeRecurringMandate.counterparty_iban),
          eq(financeRecurringMandate.counterparty, tx.counterparty),
        ),
      );
    }

    let mandate: typeof financeRecurringMandate.$inferSelect | null = null;
    for (const cond of conditions) {
      const [hit] = await db
        .select()
        .from(financeRecurringMandate)
        .where(cond)
        .limit(1);
      if (hit) {
        mandate = hit;
        break;
      }
    }

    if (!mandate) {
      return { mandate_id: null, counterparty: null, items: [] };
    }

    const rows = await db.execute<{
      id: number;
      booking_date: string;
      amount: string;
      purpose: string | null;
    }>(sql`
      SELECT ft.id, ft.booking_date, ft.amount, ft.purpose
      FROM finance_transaction ft
      WHERE ft.account_id = ${mandate.account_id}
        AND ft.id <> ${id}
        AND (
          (${mandate.mandate_ref}::text IS NOT NULL AND ft.mandate_ref = ${mandate.mandate_ref})
          OR (${mandate.mandate_ref}::text IS NULL
              AND ${mandate.counterparty_iban}::text IS NOT NULL
              AND ft.counterparty_iban = ${mandate.counterparty_iban})
          OR (${mandate.mandate_ref}::text IS NULL
              AND ${mandate.counterparty_iban}::text IS NULL
              AND ${mandate.counterparty}::text IS NOT NULL
              AND ft.counterparty = ${mandate.counterparty})
        )
      ORDER BY ft.booking_date DESC
      LIMIT 24
    `);

    return {
      mandate_id: mandate.id,
      counterparty: mandate.counterparty,
      items: rows.rows.map((r) => ({
        id: r.id,
        booking_date: r.booking_date,
        amount: r.amount,
        purpose: r.purpose ?? null,
      })),
    };
  },
);

// -----------------------------------------------------------------------
// Message builder
// -----------------------------------------------------------------------

const eurFmt = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const pctFmt = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtEur(n: number): string {
  return `${eurFmt.format(n)} €`;
}

function buildMessage(
  type: string,
  details: Record<string, unknown>,
  counterparty: string | null | undefined,
): string {
  const name = counterparty ?? "Unbekannter Gegenüber";
  switch (type) {
    case "amount_change": {
      const prev = Math.abs(Number(details.previous ?? 0));
      const curr = Math.abs(Number(details.current ?? 0));
      const absDiff = Math.abs(Number(details.diff ?? 0));
      const absPct = Math.abs(Number(details.pct ?? 0));
      // is_credit is stored explicitly; fall back to false (= debit) for old records
      const isCredit = details.is_credit === true;
      const dir = Number(details.diff ?? 0) > 0 ? "erhöht" : "gesenkt";
      const kind = isCredit ? "Gutschrift" : "Lastschrift";
      return `Die ${kind} von ${name} hat sich um ${fmtEur(absDiff)} (${pctFmt.format(absPct)} %) von ${fmtEur(prev)} auf ${fmtEur(curr)} ${dir}.`;
    }
    case "duplicate": {
      const amount = Math.abs(Number(details.amount ?? 0));
      const isCredit = Number(details.amount ?? 0) > 0;
      const kind = isCredit ? "Gutschrift" : "Buchung";
      return `Mögliche doppelte ${kind} von ${name} über ${fmtEur(amount)} innerhalb weniger Tage.`;
    }
    case "new_mandate": {
      const amount = Math.abs(Number(details.amount ?? 0));
      const isCredit = Number(details.amount ?? 0) > 0;
      const kind = isCredit ? "Gutschrift" : "Lastschrift";
      return `Neue regelmäßige ${kind} von ${name} über ${fmtEur(amount)}.`;
    }
    case "missing_transaction": {
      const expectedAmount = details.expected_amount !== undefined
        ? Math.abs(Number(details.expected_amount))
        : null;
      const isCredit = expectedAmount !== null && Number(details.expected_amount) > 0;
      const kind = isCredit ? "Gutschrift" : "Lastschrift";
      const expectedDate = typeof details.expected_date === "string"
        ? formatGermanDate(details.expected_date)
        : "—";
      const daysOverdue = Math.max(0, Math.round(Number(details.days_overdue ?? 0)));
      const amountStr = expectedAmount !== null && Number.isFinite(expectedAmount)
        ? ` über ca. ${fmtEur(expectedAmount)}`
        : "";
      return `Erwartete ${kind} von ${name}${amountStr} ist seit ${expectedDate} (${daysOverdue} Tage überfällig) ausgeblieben.`;
    }
    default:
      return `Unbekannte Anomalie (${type}).`;
  }
}

function formatGermanDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}.${m}.${y}`;
}
