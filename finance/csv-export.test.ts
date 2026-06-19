import { describe, it, expect } from "vitest";

import { csvEscapeField, formatCsvRow } from "./transactions";

describe("finance/transactions — CSV export helpers", () => {
  it("leaves plain fields untouched", () => {
    expect(csvEscapeField("hello")).toBe("hello");
    expect(csvEscapeField("123.45")).toBe("123.45");
  });

  it("quotes and escapes fields with comma, quote, or newline", () => {
    expect(csvEscapeField("a,b")).toBe('"a,b"');
    expect(csvEscapeField('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvEscapeField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscapeField("with\r\nbreak")).toBe('"with\r\nbreak"');
  });

  it("renders empty for null / undefined", () => {
    expect(csvEscapeField(null)).toBe("");
    expect(csvEscapeField(undefined)).toBe("");
  });

  it("formatCsvRow joins escaped fields with comma and trailing newline", () => {
    expect(formatCsvRow(["1", "2024-08-10", null, "Rewe, Markt"])).toBe(
      '1,2024-08-10,,"Rewe, Markt"\n',
    );
  });

  it("preserves umlauts (BOM is added at stream level, not per-field)", () => {
    // Umlauts are valid UTF-8 mid-byte sequences, no escaping needed.
    expect(csvEscapeField("Müsli")).toBe("Müsli");
    expect(formatCsvRow(["Müsli", "Größe"])).toBe("Müsli,Größe\n");
  });
});
