import { describe, it, expect } from "vitest";
import {
  isUsableSettlement,
  parseGermanNumber,
  parseSettlement,
} from "./depot-settlement-parser";

// Synthetic settlement texts in the layouts German brokers print. Every
// identifier, name and number here is invented.

const BUY_TEXT = `
Beispielbank AG
Wertpapierabrechnung
Kauf

Stück/Nominale 25,00
Wertpapierbezeichnung
Alpha Industries AG Inhaber-Aktien o.N.
ISIN DE000000AAA1 WKN AAA111

Schlusstag/-Zeit 14.03.2026 09:04:11
Ausführungskurs 118,40 EUR
Kurswert 2.960,00 EUR
Provision 4,90 EUR
Handelsplatzgebühr 1,50 EUR
Ausmachender Betrag 2.966,40 EUR
Valuta 18.03.2026
`;

const SELL_TEXT = `
Musterbroker
Wertpapier-Abrechnung Verkauf
Stück 10
Beispiel World ETF
ISIN DE000000BBB2
Handelstag 03.02.2026
Kurs 145,00 EUR
Kurswert 1.450,00 EUR
Orderprovision 10,00 EUR
Kapitalertragsteuer 20,00 EUR
Solidaritätszuschlag 1,05 EUR
Endbetrag 1.418,95 EUR
`;

const DIVIDEND_TEXT = `
Beispielbank AG
Dividendengutschrift
Alpha Industries AG
WKN AAA111 / ISIN DE000000AAA1
Stück 60
Dividende pro Stück 2,00 EUR
Bruttobetrag 120,00 EUR
Kapitalertragsteuer 25,00 EUR
Solidaritätszuschlag 1,37 EUR
Kirchensteuer 2,00 EUR
Zahlbarkeitstag 12.05.2026
Betrag zu Ihren Gunsten 91,63 EUR
`;

describe("parseGermanNumber", () => {
  it("reads German and plain formats", () => {
    expect(parseGermanNumber("1.234,56")).toBe(1234.56);
    expect(parseGermanNumber("2.960,00")).toBe(2960);
    expect(parseGermanNumber("12,5")).toBe(12.5);
    expect(parseGermanNumber("1234.56")).toBe(1234.56);
    expect(parseGermanNumber("25")).toBe(25);
    expect(parseGermanNumber("- 3,00")).toBe(-3);
    expect(parseGermanNumber("abc")).toBeNull();
  });
});

describe("parseSettlement", () => {
  it("reads a buy settlement", () => {
    const s = parseSettlement(BUY_TEXT);
    expect(s).not.toBeNull();
    expect(s!.kind).toBe("buy");
    expect(s!.isin).toBe("DE000000AAA1");
    expect(s!.wkn).toBe("AAA111");
    expect(s!.name).toBe("Alpha Industries AG Inhaber-Aktien o.N.");
    expect(s!.quantity).toBe(25);
    expect(s!.price).toBe(118.4);
    expect(s!.gross).toBe(2960);
    expect(s!.fees).toBe(6.4);
    expect(s!.tax).toBeNull();
    expect(s!.net).toBe(-2966.4);
    expect(s!.executedAt).toBe("2026-03-14");
    expect(s!.currency).toBe("EUR");
    expect(isUsableSettlement(s)).toBe(true);
  });

  it("reads a sell settlement with taxes", () => {
    const s = parseSettlement(SELL_TEXT);
    expect(s!.kind).toBe("sell");
    expect(s!.isin).toBe("DE000000BBB2");
    expect(s!.wkn).toBeNull();
    expect(s!.quantity).toBe(10);
    expect(s!.price).toBe(145);
    expect(s!.gross).toBe(1450);
    expect(s!.fees).toBe(10);
    expect(s!.tax).toBe(21.05);
    expect(s!.net).toBe(1418.95);
    expect(s!.executedAt).toBe("2026-02-03");
  });

  it("reads a dividend statement", () => {
    const s = parseSettlement(DIVIDEND_TEXT);
    expect(s!.kind).toBe("dividend");
    expect(s!.isin).toBe("DE000000AAA1");
    expect(s!.wkn).toBe("AAA111");
    expect(s!.quantity).toBe(60);
    expect(s!.price).toBe(2);
    expect(s!.gross).toBe(120);
    expect(s!.tax).toBe(28.37);
    expect(s!.fees).toBeNull();
    expect(s!.net).toBe(91.63);
    expect(s!.executedAt).toBe("2026-05-12");
  });

  it("rejects text that is not a settlement", () => {
    expect(parseSettlement("")).toBeNull();
    expect(parseSettlement("Rechnung Nr. 4711 über 120,00 EUR")).toBeNull();
    // Settlement words without any identifier.
    expect(parseSettlement("Wertpapierabrechnung Kauf Stück 10 Kurs 5,00")).toBeNull();
    // Depot statement, not a settlement.
    expect(parseSettlement("Depotauszug per 31.12.2025 ISIN DE000000AAA1 Bestand 60")).toBeNull();
  });

  it("is not usable without a date or any amount", () => {
    const noDate = parseSettlement("Wertpapierabrechnung Kauf ISIN DE000000AAA1 Kurswert 100,00 EUR");
    expect(noDate).not.toBeNull();
    expect(isUsableSettlement(noDate)).toBe(false);
    const noAmount = parseSettlement("Wertpapierabrechnung Kauf ISIN DE000000AAA1 Schlusstag 01.02.2026");
    expect(isUsableSettlement(noAmount)).toBe(false);
  });
});
