import type { DocumentScanService } from "./scan-queue";

const REGULAR_DOCUMENT_SERVICES = ["text_extract", "classify", "embed"] as const;
const AUTO_BOOK_MIN_AMOUNT = 0;
const AUTO_BOOK_MAX_AMOUNT = 999;
const AUTO_BOOK_MIN_CONFIDENCE = 0.85;

export interface ReceiptCapturePlan {
  categoryId: number;
  /**
   * Always 'system': `categoryId` is decided by the upload route, not by any
   * classifier, so the row must say so. Without it the category lands as 'ai'
   * and the next re-classify overwrites 'belege' with whatever the model reads
   * out of the receipt text. Carried on the plan (rather than set at the insert
   * site) so both branches below, including the legacy one without a cash
   * account, are covered by construction.
   */
  categorySource: "system";
  receiptAccountId: number | null;
  receiptTransactionId: number | null;
  receiptOcrState: "pending" | null;
  scanServices: readonly DocumentScanService[];
}

export interface ReceiptDocumentCompletion {
  extracted_text: string | null;
  status: "ready";
  last_error: null;
  title?: string;
  sender?: string;
  doc_date?: string;
  receipt_ocr_state?: "incomplete";
}

export interface ReceiptDocumentMetadata {
  store: string | null;
  receiptDate: string | null;
}

/**
 * Cash-account receipt captures already carry PaddleOCR text and must retain
 * their native-resolution scan. Running the generic Tesseract sandwich-PDF
 * path would duplicate OCR and rasterize the stored PDF at the document-wide
 * OCR DPI, visibly softening thermal-print details.
 */
export function shouldUseTesseractSidecar(
  receiptOcrState: string | null,
): boolean {
  return receiptOcrState == null;
}

export function isReliableReceiptAmount(
  amount: number | null,
  confidence: number,
): boolean {
  return amount != null
    && amount > AUTO_BOOK_MIN_AMOUNT
    && amount <= AUTO_BOOK_MAX_AMOUNT
    && confidence >= AUTO_BOOK_MIN_CONFIDENCE;
}

/**
 * Build the complete upload-time processing plan before the document row is
 * inserted or any worker is triggered. Keeping metadata and queue selection in
 * one value prevents a fast worker from observing a half-initialised receipt.
 */
export function buildReceiptCapturePlan(
  categoryId: number,
  receiptAccountId: number | null,
  receiptTransactionId: number | null = null,
): ReceiptCapturePlan {
  if (receiptAccountId == null && receiptTransactionId == null) {
    // Legacy/API callers without a cash account still get the regular document
    // pipeline. The cash-transaction UI always supplies an account.
    return {
      categoryId,
      categorySource: "system",
      receiptAccountId: null,
      receiptTransactionId: null,
      receiptOcrState: null,
      scanServices: REGULAR_DOCUMENT_SERVICES,
    };
  }

  return {
    categoryId,
    categorySource: "system",
    receiptAccountId,
    receiptTransactionId,
    receiptOcrState: "pending",
    scanServices: ["receipt_ocr"] as const,
  };
}

/** Build the document patch from PaddleOCR output without invoking Tesseract. */
export function buildReceiptDocumentCompletion(
  rawText: string,
  receiptState?: "incomplete",
  metadata?: ReceiptDocumentMetadata,
): ReceiptDocumentCompletion {
  const sender = metadata?.store?.trim() || null;
  const docDate = metadata?.receiptDate?.trim() || null;
  const title = metadata
    ? (sender ? `Kassenbeleg – ${sender}` : "Kassenbeleg").slice(0, 120)
    : null;
  return {
    extracted_text: rawText.trim() || null,
    status: "ready",
    last_error: null,
    ...(title ? { title } : {}),
    ...(sender ? { sender } : {}),
    ...(docDate ? { doc_date: docDate } : {}),
    ...(receiptState ? { receipt_ocr_state: receiptState } : {}),
  };
}
