import { describe, it, expect } from "vitest";
import {
  extractDepotNumber,
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

describe("parseSettlement — depot number and WKN beside the ISIN", () => {
  it("reads the depot number in its usual spellings, digits only", () => {
    expect(extractDepotNumber("Depotnummer 123 4567")).toBe("1234567");
    expect(extractDepotNumber("Depot-Nr.: 12-345-678")).toBe("12345678");
    expect(extractDepotNumber("Depotkonto 0098765432")).toBe("0098765432");
    expect(extractDepotNumber("Depot 7654321")).toBe("7654321");
    // Does not run on into the next line, and ignores short numbers.
    expect(extractDepotNumber("Depotnummer 1234567\n25 Stück")).toBe("1234567");
    expect(extractDepotNumber("Depot 12")).toBeNull();
    expect(extractDepotNumber("Depotbank Beispiel AG")).toBeNull();
  });

  it("reads a WKN printed next to the ISIN without its own prefix", () => {
    const after = parseSettlement(
      "Wertpapierabrechnung Kauf\nISIN/WKN DE000000AAA1/AAA111\nDepotnummer 1234567\nSchlusstag 01.02.2026\nKurswert 100,00 EUR",
    );
    expect(after!.isin).toBe("DE000000AAA1");
    expect(after!.wkn).toBe("AAA111");
    expect(after!.depotNumber).toBe("1234567");

    const before = parseSettlement(
      "Wertpapierabrechnung Verkauf\nWKN/ISIN AAA111/DE000000AAA1\nSchlusstag 01.02.2026\nKurswert 100,00 EUR",
    );
    expect(before!.wkn).toBe("AAA111");
  });
});
