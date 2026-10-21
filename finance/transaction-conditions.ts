/**
 * Conditions over `finance_transaction` that more than the list endpoint
 * needs — the collection rules of #1548 filter bookings the same way.
 * Free of endpoints so other services can import them.
 */

import { eq, gte, inArray, lte, not, or, sql, type SQL } from "drizzle-orm";
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

/**
 * The list's search box: text in counterparty, purpose, notice or one of the
 * SEPA references, or — when the text reads as a number — a booking of that
 * absolute amount. Rule collections search the same way, so a folder saved
 * from a search holds what the search showed.
 */
export function searchCondition(raw: string): SQL | undefined {
  const q = raw.trim();
  if (!q) return undefined;
  const like = `%${q}%`;
  const textMatch = or(
    sql`${financeTransaction.counterparty} ILIKE ${like}`,
    sql`${financeTransaction.purpose} ILIKE ${like}`,
    sql`${financeTransaction.end_to_end_ref} ILIKE ${like}`,
    sql`${financeTransaction.mandate_ref} ILIKE ${like}`,
    sql`${financeTransaction.creditor_id} ILIKE ${like}`,
    sql`${financeTransaction.notice} ILIKE ${like}`,
  )!;
  const numericQ = Number(q.replace(",", "."));
  if (!Number.isFinite(numericQ)) return textMatch;
  const abs = Math.abs(numericQ).toFixed(2);
  return or(sql`ABS(${financeTransaction.amount}) = ${abs}::numeric`, textMatch)!;
}

/** The transaction list's filter and search, as a rule collection stores them. */
export interface TransactionCriteria {
  account_ids?: number[];
  /** Every one of these tags (as the list's tag filter). */
  tags?: string[];
  /** The list's search: text in counterparty, purpose, notice or references, or an amount. */
  text?: string;
  /** Booking date range, YYYY-MM-DD. */
  from?: string;
  to?: string;
  tax_relevant?: boolean;
  /** Absolute amount range, inclusive (as the list's amount filter). */
  amount_min?: number;
  amount_max?: number;
  direction?: TransactionDirection;
}

/** The criteria as conditions; the caller adds which accounts may be read. */
export function criteriaConditions(c: TransactionCriteria): SQL[] {
  const conds: SQL[] = [];
  if (c.account_ids?.length) conds.push(inArray(financeTransaction.account_id, c.account_ids));
  if (c.from) conds.push(gte(financeTransaction.booking_date, c.from));
  if (c.to) conds.push(lte(financeTransaction.booking_date, c.to));
  if (c.text) {
    const search = searchCondition(c.text);
    if (search) conds.push(search);
  }
  if (c.tax_relevant !== undefined) {
    const flagged = taxRelevantCondition();
    conds.push(c.tax_relevant ? flagged : not(flagged));
  }
  conds.push(...amountConditions({ min: c.amount_min, max: c.amount_max, direction: c.direction }));
  for (const tag of c.tags ?? []) conds.push(taggedWithCondition(tag));
  return conds;
}
