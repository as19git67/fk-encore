import type { DocumentScanService } from "./scan-queue";

const REGULAR_DOCUMENT_SERVICES = ["text_extract", "classify", "embed"] as const;

export interface ReceiptCapturePlan {
  categoryId: number;
  receiptAccountId: number | null;
  receiptOcrState: "pending" | null;
  scanServices: readonly DocumentScanService[];
}

export interface ReceiptDocumentCompletion {
  extracted_text: string | null;
  status: "ready";
  last_error: null;
  receipt_ocr_state?: "incomplete";
}

/**
 * Build the complete upload-time processing plan before the document row is
 * inserted or any worker is triggered. Keeping metadata and queue selection in
 * one value prevents a fast worker from observing a half-initialised receipt.
 */
export function buildReceiptCapturePlan(
  categoryId: number,
  receiptAccountId: number | null,
): ReceiptCapturePlan {
  if (receiptAccountId == null) {
    // Legacy/API callers without a cash account still get the regular document
    // pipeline. The cash-transaction UI always supplies an account.
    return {
      categoryId,
      receiptAccountId: null,
      receiptOcrState: null,
      scanServices: REGULAR_DOCUMENT_SERVICES,
    };
  }

  return {
    categoryId,
    receiptAccountId,
    receiptOcrState: "pending",
    scanServices: ["receipt_ocr"] as const,
  };
}

/** Build the document patch from PaddleOCR output without invoking Tesseract. */
export function buildReceiptDocumentCompletion(
  rawText: string,
  receiptState?: "incomplete",
): ReceiptDocumentCompletion {
  return {
    extracted_text: rawText.trim() || null,
    status: "ready",
    last_error: null,
    ...(receiptState ? { receipt_ocr_state: receiptState } : {}),
  };
}
