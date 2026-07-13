import { describe, expect, it } from "vitest";

import { isSuppressedPdfJsWarning } from "./text-extract";

describe("documents.text-extract PDF.js warning filter", () => {
  it("suppresses benign TrueType interpreter warnings from pdf.js", () => {
    expect(isSuppressedPdfJsWarning("Warning: TT: undefined function: 32")).toBe(true);
    expect(isSuppressedPdfJsWarning("Warning: TT: undefined function: 21")).toBe(true);
  });

  it("does not suppress unrelated warnings", () => {
    expect(isSuppressedPdfJsWarning("Warning: failed to parse xref table")).toBe(false);
  });
});
