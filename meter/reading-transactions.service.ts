/**
 * Utility meters — linking readings to finance transactions
 * (Issue #792, Etappe 8 / #1018).
 *
 * A reading (typically the one a utility bill or an advance payment refers
 * to) can carry any number of finance transactions; the link table is
 * `meter_reading_transactions`, same shape as `finance_transaction_document`.
 * Linking is manual in this stage — match suggestions are a later step.
 *
 * Two access checks meet here: the reading must be on a meter visible to the
 * caller, and the transaction must be readable under the finance ACL
 * (`finance_account_access`, bypassed by `finance.admin`).
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  financeAccountAccess,
  financeTransaction,
  meterDevices,
  meterReadingTransactions,
  meterReadings,
} from "../db/schema";
import { loadVisibleMeter } from "./meter.service";

export interface AuthContext {
  userId: number;
  permissions: string[];
}

export interface LinkedTransactionDto {
  transactionId: number;
  accountId: number;
  bookingDate: string;
  amount: number;
  currencyCode: string;
  counterparty: string | null;
  purpose: string | null;
  linkedAt: string;
}

/** Transactions among `ids` the caller may read under the finance ACL. */
export async function readableTransactionIds(auth: AuthContext, ids: number[]): Promise<number[]> {
  const requested = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (requested.length === 0) return [];
  if (auth.permissions.includes("finance.admin")) {
    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(inArray(financeTransaction.id, requested)),
    );
    return rows.map((row) => Number(row.id));
  }
  const rows = await dbAll<{ id: number }>(
    db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .innerJoin(
        financeAccountAccess,
        and(
          eq(financeAccountAccess.account_id, financeTransaction.account_id),
          eq(financeAccountAccess.user_id, auth.userId),
        ),
      )
      .where(inArray(financeTransaction.id, requested)),
  );
  return rows.map((row) => Number(row.id));
}

/** Resolve a reading to its meter and enforce meter visibility. */
async function loadVisibleReading(userId: number, readingId: number): Promise<{ id: number; meterId: number }> {
  const row = await dbFirst<{ id: number; meter_id: number }>(
    db
      .select({ id: meterReadings.id, meter_id: meterDevices.meter_id })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
      .where(eq(meterReadings.id, readingId)),
  );
  if (!row) throw APIError.notFound("reading not found");
  await loadVisibleMeter(userId, row.meter_id);
  return { id: Number(row.id), meterId: row.meter_id };
}

export async function listReadingTransactions(
  auth: AuthContext,
  readingId: number,
): Promise<LinkedTransactionDto[]> {
  await loadVisibleReading(auth.userId, readingId);
  const rows = await dbAll<{
    transaction_id: number;
    account_id: number;
    booking_date: string;
    amount: string;
    currency_code: string;
    counterparty: string | null;
    purpose: string | null;
    linked_at: string;
  }>(
    db
      .select({
        transaction_id: meterReadingTransactions.transaction_id,
        account_id: financeTransaction.account_id,
        booking_date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
        currency_code: financeTransaction.currency_code,
        counterparty: financeTransaction.counterparty,
        purpose: financeTransaction.purpose,
        linked_at: meterReadingTransactions.created_at,
      })
      .from(meterReadingTransactions)
      .innerJoin(financeTransaction, eq(financeTransaction.id, meterReadingTransactions.transaction_id))
      .where(eq(meterReadingTransactions.reading_id, readingId))
      .orderBy(desc(financeTransaction.booking_date)),
  );
  const allowed = new Set(
    await readableTransactionIds(auth, rows.map((row) => Number(row.transaction_id))),
  );
  return rows
    .filter((row) => allowed.has(Number(row.transaction_id)))
    .map((row) => ({
      transactionId: Number(row.transaction_id),
      accountId: row.account_id,
      bookingDate: row.booking_date,
      amount: Number(row.amount),
      currencyCode: row.currency_code,
      counterparty: row.counterparty,
      purpose: row.purpose,
      linkedAt: row.linked_at,
    }));
}

export async function linkReadingTransaction(
  auth: AuthContext,
  readingId: number,
  transactionId: number,
): Promise<{ linked: boolean }> {
  await loadVisibleReading(auth.userId, readingId);
  const allowed = await readableTransactionIds(auth, [transactionId]);
  if (allowed.length === 0) throw APIError.permissionDenied("Keine Berechtigung für diese Buchung");
  const inserted = await db
    .insert(meterReadingTransactions)
    .values({ reading_id: readingId, transaction_id: transactionId })
    .onConflictDoNothing()
    .returning({ reading_id: meterReadingTransactions.reading_id });
  return { linked: inserted.length > 0 };
}

export async function unlinkReadingTransaction(
  auth: AuthContext,
  readingId: number,
  transactionId: number,
): Promise<void> {
  await loadVisibleReading(auth.userId, readingId);
  const allowed = await readableTransactionIds(auth, [transactionId]);
  if (allowed.length === 0) throw APIError.permissionDenied("Keine Berechtigung für diese Buchung");
  await db
    .delete(meterReadingTransactions)
    .where(
      and(
        eq(meterReadingTransactions.reading_id, readingId),
        eq(meterReadingTransactions.transaction_id, transactionId),
      ),
    );
}

/** Number of linked transactions per reading, for a page of readings. */
export async function countLinkedTransactions(readingIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (readingIds.length === 0) return map;
  const rows = await dbAll<{ reading_id: number; count: number }>(
    db
      .select({
        reading_id: meterReadingTransactions.reading_id,
        count: sql<number>`count(*)`,
      })
      .from(meterReadingTransactions)
      .where(inArray(meterReadingTransactions.reading_id, readingIds))
      .groupBy(meterReadingTransactions.reading_id),
  );
  for (const row of rows) map.set(Number(row.reading_id), Number(row.count));
  return map;
}
