import { describe, expect, it } from "vitest";
import { amountAnchored, parseGermanAmountCents } from "./tax-amounts";

describe("parseGermanAmountCents", () => {
  it("reads German-printed amounts", () => {
    expect(parseGermanAmountCents("48.200,00")).toBe(4820000);
    expect(parseGermanAmountCents("48 200,00 €")).toBe(4820000);
    expect(parseGermanAmountCents("1234,5")).toBe(123450);
    expect(parseGermanAmountCents("1.000 EUR")).toBe(100000);
    expect(parseGermanAmountCents("-12,30")).toBe(-1230);
    expect(parseGermanAmountCents("12,30-")).toBe(-1230);
    expect(parseGermanAmountCents("0,00")).toBe(0);
  });

  it("refuses what is not one amount", () => {
    expect(parseGermanAmountCents("1.23")).toBeNull();
    expect(parseGermanAmountCents("12,345")).toBeNull();
    expect(parseGermanAmountCents("Zeile 3")).toBeNull();
    expect(parseGermanAmountCents("")).toBeNull();
  });
});

describe("amountAnchored", () => {
  const text = "3. Bruttoarbeitslohn 48.200,00\n4. Lohnsteuer 7 950,40\n5. Solidaritätszuschlag 0,00\nSparer-Pauschbetrag 1.000 €";

  it("finds an amount however its thousands are grouped", () => {
    expect(amountAnchored(text, 4820000)).toBe(true);
    expect(amountAnchored(text, 795040)).toBe(true);
    expect(amountAnchored(text, 0)).toBe(true);
    expect(amountAnchored(text, 100000)).toBe(true);
  });

  it("does not take a number that only stands inside another", () => {
    // "200,00" is the tail of 48.200,00; "48" its head.
    expect(amountAnchored(text, 20000)).toBe(false);
    expect(amountAnchored(text, 4800)).toBe(false);
    expect(amountAnchored(text, 1234500)).toBe(false);
  });
});
