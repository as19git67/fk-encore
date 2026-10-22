/**
 * "Fehlende fortsetzen" continues a document where it stopped instead of
 * running every document through text extraction again.
 */

import { describe, it, expect } from "vitest";
import { resumeStep } from "./documents";

describe("resumeStep", () => {
  it("continues a receipt with its receipt OCR, whatever its status", () => {
    expect(resumeStep({ status: "pending", has_text: false, receipt_pending: true })).toBe("receipt_ocr");
    expect(resumeStep({ status: "failed", has_text: true, receipt_pending: true })).toBe("receipt_ocr");
  });

  it("classifies a document whose text is already there", () => {
    expect(resumeStep({ status: "classifying", has_text: true, receipt_pending: false })).toBe("classify");
  });

  it("starts from text extraction otherwise", () => {
    expect(resumeStep({ status: "classifying", has_text: false, receipt_pending: false })).toBe("text_extract");
    expect(resumeStep({ status: "pending", has_text: false, receipt_pending: false })).toBe("text_extract");
    expect(resumeStep({ status: "extracting", has_text: false, receipt_pending: false })).toBe("text_extract");
    expect(resumeStep({ status: "failed", has_text: true, receipt_pending: false })).toBe("text_extract");
  });
});
