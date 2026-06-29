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
