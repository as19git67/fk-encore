import { describe, expect, it } from "vitest";
import { formatReceiptLineItemsNotice } from "./receipt-line-items";

describe("formatReceiptLineItemsNotice", () => {
  it("writes one priced line per recognised receipt item", () => {
    expect(formatReceiptLineItemsNotice([
      { name: "Milch", amount: 1.29 },
      { name: "  Brot  ", amount: 2 },
    ], "EUR")).toBe("Belegpositionen:\n- Milch: 1,29 EUR\n- Brot: 2,00 EUR");
  });

  it("ignores unusable items and returns null for an empty result", () => {
    expect(formatReceiptLineItemsNotice([
      { name: "", amount: 1 },
      { name: "Fehler", amount: Number.NaN },
    ], "EUR")).toBeNull();
  });
});
