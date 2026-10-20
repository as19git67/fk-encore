/**
 * Conditions over `finance_transaction` that more than the list endpoint
 * needs — the collection rules of #1548 filter bookings the same way.
 * Free of endpoints so other services can import them.
 */

import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import {
  financeTag,
  financeTagTransaction,
  financeTransaction,
  financeTransactionSplit,
} from "../db/schema";

/** Flagged itself, or one of its splits is. */
export function taxRelevantCondition() {
  const flaggedSplits = db
    .select({ id: financeTransactionSplit.transaction_id })
    .from(financeTransactionSplit)
    .where(eq(financeTransactionSplit.is_tax_relevant, true));
  return or(
    eq(financeTransaction.is_tax_relevant, true),
    inArray(financeTransaction.id, flaggedSplits),
  )!;
}

/** Carries the tag of this name, whatever its source. */
export function taggedWithCondition(name: string) {
  const taggedWith = db
    .select({ id: financeTagTransaction.transaction_id })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .where(eq(financeTag.name, name));
  return inArray(financeTransaction.id, taggedWith);
}

/** Money in (`in`, amount > 0) or out (`out`, amount < 0). */
export type TransactionDirection = "in" | "out";

export interface AmountRange {
  /** Smallest absolute amount, inclusive. */
  min?: number;
  /** Largest absolute amount, inclusive. */
  max?: number;
  direction?: TransactionDirection;
}

/**
 * The amount filter of the list and of rule collections. Bounds apply to
 * the absolute amount — "über 100 €" means bookings that move more than
 * 100 €, whichever way — and the direction picks the sign on its own, so
 * nobody has to know that an expense of 100 € is stored as -100.
 */
export function amountConditions(range: AmountRange): SQL[] {
  const conds: SQL[] = [];
  if (range.min !== undefined) {
    conds.push(sql`ABS(${financeTransaction.amount}) >= ${range.min.toFixed(2)}::numeric`);
  }
  if (range.max !== undefined) {
    conds.push(sql`ABS(${financeTransaction.amount}) <= ${range.max.toFixed(2)}::numeric`);
  }
  if (range.direction === "in") conds.push(sql`${financeTransaction.amount} > 0`);
  if (range.direction === "out") conds.push(sql`${financeTransaction.amount} < 0`);
  return conds;
}

/** A non-negative finite amount, or undefined for anything else. */
export function parseAmountBound(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseDirection(raw: unknown): TransactionDirection | undefined {
  return raw === "in" || raw === "out" ? raw : undefined;
}
