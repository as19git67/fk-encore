import { describe, it, expect } from "vitest";

import { EMPTY_SETTLEMENT } from "./depot-settlement-merge";
import { groundingOf } from "./depot-settlement-reader";
import { needsPaperType, parsePaperType } from "./depot-paper-type";

// Synthetic identifiers and texts only — see CLAUDE.md "Keine PII".
const ISIN_A = "DE000000AAA1";

describe("parsePaperType", () => {
  it("takes the known kinds and calls anything else 'other'", () => {
    expect(parsePaperType({ paper_type: "trade" })).toBe("trade");
    expect(parsePaperType({ paper_type: " Statement " })).toBe("statement");
    expect(parsePaperType({ paper_type: "invoice" })).toBe("other");
    expect(parsePaperType({})).toBe("other");
  });
});

describe("needsPaperType", () => {
  it("asks about a securities paper whose wording the rules do not know", () => {
    expect(needsPaperType(`Ihre Order wurde ausgeführt\nAnteile 12\nISIN ${ISIN_A}\nFonds Beispiel`)).toBe(true);
    expect(needsPaperType(`Übersicht Ihrer Anlagen\nFonds Beispiel ISIN ${ISIN_A} Anteile 10`)).toBe(true);
  });

  it("leaves papers the rules read themselves, insurance and papers without an identifier alone", () => {
    expect(needsPaperType(`Wertpapierabrechnung Kauf\nISIN ${ISIN_A}`)).toBe(false);
    expect(needsPaperType(`Depotauszug per 31.12.2025\nISIN ${ISIN_A} Stück 10`)).toBe(false);
    expect(needsPaperType(`Rentenversicherung\nFonds Beispiel ISIN ${ISIN_A} Anteile`)).toBe(false);
    expect(needsPaperType("Ihre Order wurde ausgeführt, Fonds Beispiel")).toBe(false);
    expect(needsPaperType(null)).toBe(false);
  });
});

describe("groundingOf", () => {
  const text = `Beispielbank AG · Kundennummer 150
Ihre Order wurde ausgeführt
Alpha Industries AG ISIN ${ISIN_A}
Stück 15
Handelstag 14.03.2026
Depot 9900000002`;

  it("finds the model's identifiers, quantity, date and depot number where the text prints them", () => {
    const g = groundingOf(text, { ...EMPTY_SETTLEMENT, isin: ISIN_A, quantity: 15, executedAt: "2026-03-14", depotNumber: "9900000002" });
    expect(g).toEqual({ isin: true, quantity: true, executedAt: true, depotNumber: true });
  });

  it("does not take a number from the letterhead for a quantity, nor an identifier the text lacks", () => {
    const g = groundingOf(text, { ...EMPTY_SETTLEMENT, isin: "DE000000DDD3", wkn: "AAA111", quantity: 150, executedAt: "2026-03-15" });
    expect(g).toEqual({ isin: false, wkn: false, quantity: false, executedAt: false });
  });

  it("says nothing without the model", () => {
    expect(groundingOf(text, null)).toEqual({});
  });
});
