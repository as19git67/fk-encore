/**
 * Finance anomaly detection: recurring mandate tracking and alert generation.
 *
 * Runs as a daily cron job. For each account the user can read:
 *   1. Find all transactions not yet processed for anomaly detection.
 *   2. Match each to an existing mandate or create a new one.
 *   3. Emit anomalies:
 *      - amount_change: mandate's typical amount changed by > AMOUNT_CHANGE_THRESHOLD
 *      - duplicate:     same mandate_ref + amount within DUPLICATE_WINDOW_DAYS
 *      - new_mandate:   first time a mandate appears with amount > NEW_MANDATE_ALERT_AMOUNT
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
/** New mandates with |amount| above this threshold get a new_mandate alert. */
const NEW_MANDATE_ALERT_AMOUNT = 100;
/** Minimum transactions before we trust the typical_amount baseline. */
const BASELINE_MIN_TRANSACTIONS = 5;
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
const STABILITY_MAX_CV = 0.15;
/** How many recent prior amounts to sample when computing stability. */
const STABILITY_SAMPLE_SIZE = 12;

// -----------------------------------------------------------------------
// Mandate key helpers
// -----------------------------------------------------------------------

interface MandateKey {
  mandate_ref: string | null;
  creditor_id: string | null;
  counterparty_iban: string | null;
  counterparty: string | null;
}

function mandateKeyFrom(tx: typeof financeTransaction.$inferSelect): MandateKey {
  return {
    mandate_ref: tx.mandate_ref ?? null,
    creditor_id: tx.creditor_id ?? null,
    counterparty_iban: tx.counterparty_iban ?? null,
    counterparty: tx.counterparty ?? null,
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

  return result;
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

    if (mandate.isNew) {
      created++;
      if (!isRecentForAlerts) continue;

      if (Math.abs(Number(tx.amount)) >= NEW_MANDATE_ALERT_AMOUNT) {
        const inserted = await insertAnomalyIfAbsent({
          account_id: accountId,
          transaction_id: tx.id,
          mandate_id: mandate.id,
          type: "new_mandate",
          score: "0.7000",
          details: {
            counterparty: tx.counterparty,
            amount: tx.amount,
          },
        });
        if (inserted) anomalies++;
      }
    } else {
      updated++;
      if (!isRecentForAlerts) continue;

      // Check for amount change. The flagged transaction must not be older
      // than the reference transactions used to build the baseline —
      // otherwise we'd compare an older booking against a newer baseline,
      // which is meaningless. Skip when this tx predates the mandate's
      // existing last_seen (i.e. a late-arriving historical record).
      const txDateStr = tx.booking_date.slice(0, 10);
      const txIsNotOlderThanBaseline =
        !mandate.previous_last_seen || txDateStr >= mandate.previous_last_seen;
      if (
        txIsNotOlderThanBaseline &&
        mandate.transaction_count >= BASELINE_MIN_TRANSACTIONS
      ) {
        // Compare against the IMMEDIATELY previous transaction for this
        // mandate, not the smoothed EMA. This avoids flagging gradual
        // trends (e.g. 59 → 48 → 47) and only fires on real step-changes.
        const prevRaw = await getPrevTransactionAmount(mandate.id, tx.id, txDateStr);
        if (prevRaw !== null) {
          const prev = Math.abs(Number(prevRaw));
          const curr = Math.abs(Number(tx.amount));
          const diff = curr - prev;
          const pct = prev > 0 ? diff / prev : 0;

          if (Math.abs(diff) >= AMOUNT_CHANGE_MIN_ABS && Math.abs(pct) >= AMOUNT_CHANGE_THRESHOLD) {
            // Suppress when the mandate's historical amounts are already
            // volatile — a step-change signal only matters when the prior
            // baseline was reasonably stable.
            const cv = await getMandateStabilityCV(mandate.id, tx.id, txDateStr);
            const stable = cv === null || cv <= STABILITY_MAX_CV;
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
                  // raw sign preserved so the message builder knows debit vs. credit
                  is_credit: Number(tx.amount) > 0,
                },
              });
              if (inserted) anomalies++;
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

  if (!existing) {
    const [row] = await db
      .insert(financeRecurringMandate)
      .values({
        account_id: accountId,
        mandate_ref: key.mandate_ref,
        creditor_id: key.creditor_id,
        counterparty_iban: key.counterparty_iban,
        counterparty: key.counterparty,
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

  await db
    .update(financeRecurringMandate)
    .set({
      typical_amount: updatedAmount,
      typical_interval_days: intervalDays,
      transaction_count: count,
      last_seen: bookingDate,
      updated_at: sql`NOW()`,
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

async function findMandate(
  accountId: number,
  key: MandateKey,
): Promise<typeof financeRecurringMandate.$inferSelect | undefined> {
  // Priority: mandate_ref+creditor_id → iban → name
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
        )
      )
      .limit(1);
    if (row) return row;
  }

  return undefined;
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
 * Returns the amount of the most recent prior transaction for the same
 * mandate (chronologically before the candidate). Used as the comparison
 * reference for amount_change anomalies — comparing against the immediate
 * predecessor avoids flagging gradual drift.
 */
async function getPrevTransactionAmount(
  mandateId: number,
  excludingTxId: number,
  beforeBookingDate: string,
): Promise<string | null> {
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
    ORDER BY ft.booking_date DESC, ft.id DESC
    LIMIT 1
  `);
  return rows.rows[0]?.amount ?? null;
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
  async (): Promise<AnomalyRunResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
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

    const accessible = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
    const accountIds = accessible.map((a) => a.id);
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

    const accessible = await db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
    const accountIds = accessible.map((a) => a.id);
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
    default:
      return `Unbekannte Anomalie (${type}).`;
  }
}
