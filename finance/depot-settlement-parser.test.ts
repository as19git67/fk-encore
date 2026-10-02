import { describe, it, expect } from "vitest";
import {
  extractDepotNumber,
  inspectSettlement,
  isUsableSettlement,
  parseGermanNumber,
  parseSettlement,
  settlementBlock,
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

describe("parseSettlement — what is not a settlement, and layouts without the usual heading", () => {
  it("rejects insurance paperwork even when it prints a fund's ISIN and 'Ausschüttung'", () => {
    // A unit-linked life policy's annual statement: funds with ISINs, a
    // surplus "Ausschüttung" — and nothing a depot would book.
    const policy = `Beispiel Lebensversicherung AG
Fondsgebundene Kapitallebensversicherung
Versicherungsnehmer: Max Muster
Versicherungsnummer 12-345-678
Jahresmitteilung zum 31.12.2025
Überschussbeteiligung: Ausschüttung der Überschüsse 123,45 EUR
Fonds: Beispiel World Fonds ISIN DE000000AAA1 Anteile 12,345
Datum 15.01.2026`;
    expect(parseSettlement(policy)).toBeNull();
    const i = inspectSettlement(policy)!;
    expect(i.insurance).toBe(true);
    expect(i.kind).toBeNull();
  });

  it("keeps a settlement that merely names an insurer", () => {
    const text = `Beispielbank AG
Wertpapierabrechnung Kauf
Stück 10
Muster Rückversicherungs-Gesellschaft AG
ISIN DE000000AAA1
Schlusstag 14.03.2026
Kurswert 1.000,00 EUR
Ausmachender Betrag 1.004,90 EUR`;
    const s = parseSettlement(text)!;
    expect(s.kind).toBe("buy");
    expect(inspectSettlement(text)!.strong).toBe(true);
  });

  it("reads buy and sell in compound spellings and without an 'Abrechnung' heading", () => {
    const buy = parseSettlement(`Beispielbank AG
Wertpapierkauf
ISIN DE000000AAA1
Ausführungstag 14.03.2026
Kurswert 1.000,00 EUR
Ausmachender Betrag 1.004,90 EUR`);
    expect(buy?.kind).toBe("buy");
    const sell = parseSettlement(`Ausführungsanzeige Fondsverkauf
ISIN DE000000AAA1
Handelstag 14.03.2026
Kurswert 1.000,00 EUR
Endbetrag 995,10 EUR`);
    expect(sell?.kind).toBe("sell");
    // "kaufen" in the boilerplate is not a buy.
    expect(parseSettlement("Abrechnung Sie können jederzeit Anteile kaufen ISIN DE000000AAA1 Datum 01.02.2026 Endbetrag 1,00 EUR")).toBeNull();
  });
});

describe("parseSettlement — a settlement booked inside an account statement", () => {
  // The layout of a bank's "Vermögensdepot" account statement: fee
  // bookings, then the sale as one booking, then the back page's prose
  // that mentions "Dividendenabrechnung". All figures invented.
  const STATEMENT = `Kontoauszug
EUR-Konto Beispielbank AG
Depotnummer 7654321
alter Kontostand vom 30.06.2026 33,85 S
03.07. 03.07. ENTGELT gem. PLV PN:2089 30,19 S
  Beispielbank AG
  0008 DEPOTPREIS Q2/2026 NETTO 25,37EUR 19% UST. 4,82EUR
03.07. 03.07. ENTGELT gem. PLV PN:2089 193,18 S
  0010 VERWALTUNGSENTGELT Q2/2026 NETTO 162,34EUR 19% UST. 30,84EUR
07.08. 07.08. EFFEKTENGUTSCHRIFT PN:925 224,56 H
  Beispielbank AG
  Konto: 1234567 BLZ: 12345678
  WERTPAPIERABRECHNUNG
  VERKAUF WKN AAA111 / DE000000AAA1
  ALPHA GLOBAL FUND A DEPOTNR.: 7654321
  HANDELSTAG 05.08.2026 MENGE 4,5190
  KURS 56,9200 KAPST 28,82-
  SOLZ 1,58- KIST 2,31-
  AUFTRAGSNR. 99887766
neuer Kontostand vom 30.09.2026 32,66 S
Sehr geehrte Kundin, sehr geehrter Kunde,
Sie haben eine Bankmitteilung erhalten, z. B. einen Kontoauszug, eine Mitteilung oder Dividendenabrechnung. Bitte prüfen
Sie diese genau.`;

  it("reads the sale, not the depot fees around it or the prose behind it", () => {
    const s = parseSettlement(STATEMENT)!;
    expect(s.kind).toBe("sell");
    expect(s.isin).toBe("DE000000AAA1");
    expect(s.wkn).toBe("AAA111");
    expect(s.name).toBe("ALPHA GLOBAL FUND A");
    expect(s.depotNumber).toBe("7654321");
    expect(s.executedAt).toBe("2026-08-05");
    expect(s.quantity).toBe(4.519);
    expect(s.price).toBe(56.92);
    expect(s.tax).toBeCloseTo(32.71, 2);
    expect(s.fees).toBeNull();
    expect(s.net).toBe(224.56);
    expect(isUsableSettlement(s)).toBe(true);
  });

  it("cuts the block at the booking, and a repeated label with an amount does not end it", () => {
    const block = settlementBlock(STATEMENT)!;
    expect(block).toContain("EFFEKTENGUTSCHRIFT");
    expect(block).not.toContain("VERWALTUNGSENTGELT");
    const dividend = `Beispielbank AG
Dividendengutschrift
Alpha Industries AG ISIN DE000000AAA1
Stück 60
Dividendengutschrift 120,00 EUR
Zahlbarkeitstag 12.05.2026
Zu Ihren Gunsten 91,63 EUR`;
    const d = parseSettlement(dividend)!;
    expect(d.kind).toBe("dividend");
    expect(d.gross).toBe(120);
    expect(d.net).toBe(91.63);
  });
});

describe("parseSettlement — a cost disclosure is not a settlement", () => {
  // A broker's MiFID II cost information before an order: security,
  // quantity, price, fees — and a sentence promising the settlement.
  const COST_INFO = `Beispielbank AG
Kosteninformation zum Wertpapiergeschäft 06.08.2026 - 16:06 Uhr
Nach der EU-Richtlinie sind wir verpflichtet, Ihnen die nachfolgende Kosteninformation zur Verfügung zu stellen. Hierfür erhalten Sie eine gesonderte Wertpapierabrechnung.
Alpha Industries AG Stammaktien
WKN: AAA111
Kauf: 10 Stück zu 79,58 EUR
Kurswert: 795,80 EUR
Von den unten aufgelisteten Kosten werden Ihnen über die Wertpapierabrechnung voraussichtlich folgende Orderkosten abgerechnet 12,40 EUR
Kosten des Wertpapierkaufes 14,00 EUR
Börsenplatzabhängiges Entgelt 2,50 EUR
Orderprovision 9,90 EUR`;

  it("is rejected although its prose names a Wertpapierabrechnung", () => {
    const i = inspectSettlement(COST_INFO)!;
    expect(i.costInfo).toBe(true);
    expect(i.kind).toBeNull();
    expect(parseSettlement(COST_INFO)).toBeNull();
  });

  it("does not reject a settlement that appends a cost section", () => {
    const text = `Beispielbank AG
Wertpapierabrechnung Kauf
ISIN DE000000AAA1
Schlusstag 14.03.2026
Kurswert 1.000,00 EUR
Provision 4,90 EUR
Ausmachender Betrag 1.004,90 EUR
Kosteninformation: Ihre Kosten für diese Order betrugen 4,90 EUR.`;
    expect(inspectSettlement(text)!.costInfo).toBe(false);
    expect(parseSettlement(text)!.kind).toBe("buy");
  });
});
