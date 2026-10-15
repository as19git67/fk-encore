/**
 * Conditions over `finance_transaction` that more than the list endpoint
 * needs — the collection rules of #1548 filter bookings the same way.
 * Free of endpoints so other services can import them.
 */

import { eq, inArray, or } from "drizzle-orm";
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
