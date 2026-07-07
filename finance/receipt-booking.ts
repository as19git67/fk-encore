/**
 * Internal helper for the receipt-OCR background worker.
 *
 * Creates a cash transaction from receipt-OCR results WITHOUT going through
 * the auth-gated `createTransaction` API endpoint — the worker has no
 * request context and therefore no auth data. Called only from
 * `documents/document-ops.ts` after the receipt-ocr-service has produced
 * a reliable extraction.
 *
 * Idempotent: a second call for the same document_id is a no-op (unique
 * constraint on `receipt_document_id` for auto-created rows, enforced via
 * the `receipt_transaction_id` anchor on `documents`).
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { documents, financeTransaction, financeTransactionDocument } from "../db/schema";

export interface AutoBookingParams {
  documentId: number;
  accountId: number;
  /** Negative for expenses (money out). E.g. -8.80 for a Rossmann receipt. */
  amount: number;
  bookingDate: string; // YYYY-MM-DD, already clamped to <= today
  counterparty: string | null;
  purpose: string | null;
  /** Structured receipt positions rendered for the editable notes field. */
  notice: string | null;
  currencyCode: string;
}

function toAmountString(n: number): string {
  return n.toFixed(2);
}

function computeDedupeHash(input: {
  bookingDate: string;
  amount: string;
  currency: string;
  purpose: string | null;
  counterpartyIban: string | null;
}): string {
  const canonical = [
    input.bookingDate,
    "", // valueDate — always empty for receipt auto-bookings
    input.amount,
    input.currency,
    input.purpose ?? "",
    input.counterpartyIban ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Create a cash transaction for a receipt document that has just been
 * successfully processed by the receipt-ocr-service.
 *
 * Returns the new transaction id on success, or `null` if the document
 * already has a transaction linked (idempotency guard).
 */
export async function createReceiptAutoTransaction(
  params: AutoBookingParams,
): Promise<number | null> {
  // Idempotency check — the anchor column was set by the last successful run.
  const [doc] = await db
    .select({ receipt_transaction_id: documents.receipt_transaction_id })
    .from(documents)
    .where(eq(documents.id, params.documentId))
    .limit(1);

  if (!doc) throw new Error(`document ${params.documentId} not found`);
  if (doc.receipt_transaction_id != null) {
    // Already booked in a previous (re-)run — nothing to do.
    return null;
  }

  const amountStr = toAmountString(params.amount);
  const dedupeHash = computeDedupeHash({
    bookingDate: params.bookingDate,
    amount: amountStr,
    currency: params.currencyCode,
    purpose: params.purpose,
    counterpartyIban: null,
  });

  let txId: number;
  try {
    const [row] = await db
      .insert(financeTransaction)
      .values({
        account_id: params.accountId,
        booking_date: params.bookingDate,
        amount: amountStr,
        currency_code: params.currencyCode,
        counterparty: params.counterparty?.trim() || null,
        purpose: params.purpose?.trim() || null,
        notice: params.notice?.trim() || null,
        receipt_document_id: params.documentId,
        dedupe_hash: dedupeHash,
      })
      .returning({ id: financeTransaction.id });
    txId = row.id;
  } catch (err: any) {
    const pgCode = err?.code ?? err?.cause?.code;
    if (pgCode === "23505") {
      // Duplicate booking (same account + dedupe_hash) — treat as already done.
      console.warn(
        `[finance] receipt auto-booking for doc=${params.documentId} duplicate — skipping`,
      );
      return null;
    }
    throw err;
  }

  // Link document ↔ transaction in the M:N join table.
  await db
    .insert(financeTransactionDocument)
    .values({ transaction_id: txId, document_id: params.documentId })
    .onConflictDoNothing();

  // Persist idempotency anchor + OCR state on the document row.
  await db
    .update(documents)
    .set({ receipt_transaction_id: txId, receipt_ocr_state: "booked" })
    .where(eq(documents.id, params.documentId));

  return txId;
}

export interface ExistingReceiptTransactionParams {
  documentId: number;
  transactionId: number;
  notice: string | null;
}

/**
 * Attach a captured receipt to an existing transaction.
 *
 * Used by the transaction detail camera action. It deliberately does not
 * mutate booking_date, amount, counterparty or purpose. The only transaction
 * field it may change is `notice`, where structured receipt positions are
 * appended for human review.
 */
export async function attachReceiptToExistingTransaction(
  params: ExistingReceiptTransactionParams,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, params.transactionId))
      .limit(1);
    if (!existing) throw new Error(`transaction ${params.transactionId} not found`);

    await tx
      .insert(financeTransactionDocument)
      .values({ transaction_id: params.transactionId, document_id: params.documentId })
      .onConflictDoNothing();

    const addition = params.notice?.trim() || null;
    if (addition) {
      const current = existing.notice?.trim() || "";
      const alreadyContains = current.includes(addition);
      if (!alreadyContains) {
        await tx
          .update(financeTransaction)
          .set({ notice: current ? `${current}\n\n${addition}` : addition })
          .where(eq(financeTransaction.id, params.transactionId));
      }
    }

    await tx
      .update(documents)
      .set({ receipt_transaction_id: params.transactionId, receipt_ocr_state: "booked" })
      .where(eq(documents.id, params.documentId));
  });
}
