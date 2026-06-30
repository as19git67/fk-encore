import { describe, expect, it } from "vitest";
import { documentTextPreview } from "./text-preview";

describe("documentTextPreview", () => {
  it("normalizes whitespace", () => {
    expect(documentTextPreview("  Erste\n\n zweite\tZeile  ")).toBe("Erste zweite Zeile");
  });

  it("truncates long text with an ellipsis", () => {
    expect(documentTextPreview("Ein langer Belegtext", 10)).toBe("Ein langer…");
  });

  it("returns null for empty input", () => {
    expect(documentTextPreview(" \n ")).toBeNull();
  });
});
