import { describe, expect, it } from "vitest";
import { amountAnchored, centsColumnAfter, parseGermanAmountCents } from "./tax-amounts";

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

  it("reads the cents from a Cent column of their own", () => {
    expect(parseGermanAmountCents("23.456 78")).toBe(2345678);
    expect(parseGermanAmountCents("812  05")).toBe(81205);
    // Three digits after a space still group thousands.
    expect(parseGermanAmountCents("23 456")).toBe(2345600);
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

describe("Euro and Cent in columns of their own", () => {
  // The printout of the elektronische Lohnsteuerbescheinigung (synthetic values).
  const text = [
    "3. Bruttoarbeitslohn einschl. Sachbezüge 23.456   78",
    "4. Einbehaltene Lohnsteuer von 3. 2.345   06",
    "5. Einbehaltener Solidaritätszuschlag von 3. 0   00",
    "12. Steuerfreie Arbeitgeberleistungen 1.000",
    "13. Kirchensteuer 9 % 150",
  ].join("\n");

  it("anchors the amount with its cents", () => {
    expect(amountAnchored(text, 2345678)).toBe(true);
    expect(amountAnchored(text, 234506)).toBe(true);
    expect(amountAnchored(text, 0)).toBe(true);
  });

  it("finds the cents a whole-euro reading left behind", () => {
    expect(centsColumnAfter(text, 2345600)).toBe(78);
    expect(centsColumnAfter(text, 234500)).toBe(6);
    expect(centsColumnAfter(text, 0)).toBe(0);
  });

  it("does not take a line number or a rate for a Cent column", () => {
    // "1.000" is followed by the next line's "13."; "9" by "%".
    expect(centsColumnAfter(text, 100000)).toBeNull();
    expect(centsColumnAfter(text, 900)).toBeNull();
    expect(centsColumnAfter(text, 2345678)).toBeNull();
  });
});
