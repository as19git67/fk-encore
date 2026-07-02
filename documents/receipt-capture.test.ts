import { describe, expect, it } from "vitest";
import {
  buildReceiptCapturePlan,
  buildReceiptDocumentCompletion,
  isReliableReceiptAmount,
} from "./receipt-capture";

describe("receipt capture queue plan", () => {
  it("fully initialises cash-account receipts before selecting PaddleOCR only", () => {
    const plan = buildReceiptCapturePlan(17, 42);

    expect(plan).toEqual({
      categoryId: 17,
      receiptAccountId: 42,
      receiptOcrState: "pending",
      scanServices: ["receipt_ocr"],
    });
    expect(plan.scanServices).not.toContain("text_extract");
  });

  it("creates independent complete plans for several rapid captures", () => {
    const plans = [101, 102, 103].map((accountId) =>
      buildReceiptCapturePlan(17, accountId),
    );

    expect(plans.map((plan) => plan.receiptAccountId)).toEqual([101, 102, 103]);
    expect(plans.every((plan) => plan.receiptOcrState === "pending")).toBe(true);
    expect(plans.every((plan) => plan.scanServices.join() === "receipt_ocr")).toBe(true);
  });

  it("keeps the regular document pipeline for legacy captures without an account", () => {
    const plan = buildReceiptCapturePlan(17, null);

    expect(plan.receiptOcrState).toBeNull();
    expect(plan.scanServices).toEqual(["text_extract", "classify", "embed"]);
  });

  it("uses PaddleOCR text as the completed document text", () => {
    expect(buildReceiptDocumentCompletion(
      "  EDEKA\nSumme 12,34 EUR  ",
      undefined,
      { store: " EDEKA München ", receiptDate: "2026-06-30" },
    )).toEqual({
      extracted_text: "EDEKA\nSumme 12,34 EUR",
      status: "ready",
      last_error: null,
      title: "Kassenbeleg – EDEKA München",
      sender: "EDEKA München",
      doc_date: "2026-06-30",
    });
    expect(buildReceiptDocumentCompletion("", "incomplete")).toEqual({
      extracted_text: null,
      status: "ready",
      last_error: null,
      receipt_ocr_state: "incomplete",
    });
  });

  it("does not create empty canonical document metadata", () => {
    expect(buildReceiptDocumentCompletion(
      "Text",
      undefined,
      { store: "  ", receiptDate: null },
    )).toEqual({
      extracted_text: "Text",
      status: "ready",
      last_error: null,
      title: "Kassenbeleg",
    });
  });

  it("caps generated receipt titles to a useful document-title length", () => {
    const completion = buildReceiptDocumentCompletion(
      "Text",
      undefined,
      { store: "Sehr langer Händler ".repeat(20), receiptDate: null },
    );

    expect(completion.title).toMatch(/^Kassenbeleg – Sehr langer Händler/);
    expect(completion.title).toHaveLength(120);
  });

  it("auto-books only a plausible amount with a reliable assignment", () => {
    expect(isReliableReceiptAmount(8.80, 0.995)).toBe(true);
    expect(isReliableReceiptAmount(8.80, 0.55)).toBe(false);
    expect(isReliableReceiptAmount(null, 0.995)).toBe(false);
    expect(isReliableReceiptAmount(1000, 0.995)).toBe(false);
  });
});
