import { describe, it, expect } from "vitest";
import {
  cleanSecurityName,
  extractDepotNumber,
  inspectSettlement,
  isPersonName,
  isUsableSettlement,
  parseGermanNumber,
  parseSettlement,
  rejoinColumnAmounts,
  settlementBlock,
  SETTLEMENT_CANDIDATE_PATTERN,
} from "./depot-settlement-parser";
import { nameNearerIdentifier } from "./depot-settlement-reader";

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
alter Kontostand vom 30.06.2026 12,00 S
03.07. 03.07. ENTGELT PN:1000 11,90 S
  Beispielbank AG
  DEPOTPREIS Q2/2026 NETTO 10,00EUR 19% UST. 1,90EUR
03.07. 03.07. ENTGELT PN:1000 59,50 S
  VERWALTUNGSENTGELT Q2/2026 NETTO 50,00EUR 19% UST. 9,50EUR
07.08. 07.08. EFFEKTENGUTSCHRIFT PN:100 450,00 H
  Beispielbank AG
  Konto: 1234567 BLZ: 12345678
  WERTPAPIERABRECHNUNG
  VERKAUF WKN AAA111 / DE000000AAA1
  ALPHA GLOBAL FUND A DEPOTNR.: 7654321
  HANDELSTAG 05.08.2026 MENGE 10,0000
  KURS 50,0000 KAPST 40,00-
  SOLZ 2,20- KIST 7,80-
  AUFTRAGSNR. 99887766
neuer Kontostand vom 30.09.2026 366,60 H
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
    expect(s.quantity).toBe(10);
    expect(s.price).toBe(50);
    expect(s.tax).toBeCloseTo(50, 2);
    expect(s.fees).toBeNull();
    expect(s.net).toBe(450);
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
Kosteninformation zum Wertpapiergeschäft 14.03.2026 - 10:00 Uhr
Nach der EU-Richtlinie sind wir verpflichtet, Ihnen die nachfolgende Kosteninformation zur Verfügung zu stellen. Hierfür erhalten Sie eine gesonderte Wertpapierabrechnung.
Alpha Industries AG Stammaktien
WKN: AAA111
Kauf: 10 Stück zu 40,00 EUR
Kurswert: 400,00 EUR
Von den unten aufgelisteten Kosten werden Ihnen über die Wertpapierabrechnung voraussichtlich folgende Orderkosten abgerechnet 7,50 EUR
Kosten des Wertpapierkaufes 9,00 EUR
Börsenplatzabhängiges Entgelt 1,50 EUR
Orderprovision 6,00 EUR`;

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

describe("parseSettlement — a settlement with its tax statement appended", () => {
  // A broker's sale settlement whose second part is the tax statement:
  // the first "Zu Ihren Gunsten" is before taxes, the amount booked is after.
  const TEXT = `Depotnr.: 7654321 00
GESCHÄFTSABRECHNUNG VOM 14.07.2026
Wertpapierverkauf
Geschäftstag : 14.07.2026 Ausführungsplatz : BEISPIELBÖRSE
Wertpapier-Bezeichnung WPKNR/ISIN
Alpha Industries AG AAA111
Registered Shares o.N. DE000000AAA1
Nennwert Zum Kurs von
St. 30 EUR 100,00
Kurswert : EUR 3.000,00
--------------------------------------------------------------------------------
Eigene Entgelte
Provision : EUR 4,00-
Börsenplatzabhäng. Entgelt : EUR 1,00-
Summe Entgelte : EUR 5,00-
--------------------------------------------------------------------------------
IBAN Valuta Zu Ihren Gunsten vor Steuern
DE00 0000 0000 0000 0000 00 EUR 16.07.2026 EUR 2.995,00
Informationen zur steuerlichen Behandlung dieses Geschäftsvorgangs und den auf
Ihrem Konto gebuchten Endbetrag finden Sie auf der separaten Steuermitteilung.
Steuerliche Behandlung: Wertpapierverkauf Nr. 1234567 vom 14.07.2026
Stk. 30 ALPHA INDUSTRIES AG , WKN / ISIN: AAA111 / DE000000AAA1
Zu Ihren Gunsten vor Steuern: EUR 2.995,00
Steuerbemessungsgrundlage (1) EUR 500,00
Kapitalertragsteuer EUR -125,00
Solidaritätszuschlag EUR -6,87
Kirchensteuer EUR 0,00 _____________________
abgeführte Steuern EUR -131,87 _____________________
Zu Ihren Gunsten nach Steuern: EUR 2.863,13
Die Gutschrift erfolgt mit Valuta 16.07.2026 auf Konto EUR
einbehaltene
KapitalertragsteuerSolidaritätszuschlag
2026
11,11
22,22`;

  it("reads the net after taxes, the printed totals and the trade date", () => {
    const s = parseSettlement(TEXT)!;
    expect(s.kind).toBe("sell");
    expect(s.name).toBe("Alpha Industries AG");
    expect(s.quantity).toBe(30);
    expect(s.gross).toBe(3000);
    // "Summe Entgelte" is the total, not a third fee line.
    expect(s.fees).toBe(5);
    // "abgeführte Steuern", not every tax word in the tables below it.
    expect(s.tax).toBe(131.87);
    expect(s.net).toBe(2863.13);
    expect(s.executedAt).toBe("2026-07-14");
  });

  it("takes the name under the settlement's own label and no amount of money as the quantity", () => {
    // The tax statement's table heads a line with a bare "Wertpapier" and
    // prints accrued interest — neither is the security or its quantity.
    const s = parseSettlement(
      TEXT.replace(
        "Zu Ihren Gunsten vor Steuern: EUR",
        "Stückzinsen EUR 12,34\nWertpapier\nBeispielhinweis zur Steuer\nZu Ihren Gunsten vor Steuern: EUR",
      ),
    )!;
    expect(s.name).toBe("Alpha Industries AG");
    expect(s.quantity).toBe(30);
  });

  it("reads the quantity after 'St.' when no other quantity label is printed", () => {
    const s = parseSettlement(TEXT.replace("Stk. 30", "30 Anteile"))!;
    expect(s.quantity).toBe(30);
    expect(s.markers).toContain("bSt.");
  });
});

describe("parseSettlement — a tax statement on its own", () => {
  // Synthetic: the tax statement a broker sends next to a dividend credit.
  // It prints the amounts before and after taxes, a table of tax bases and
  // footnotes with rates — no price, no Kurswert, no charges.
  const TAX = `Beispielbank AG
Steuerliche Behandlung: Dividende vom 03.06.2026
Stk. 40 ALPHA INDUSTRIES AG , WKN / ISIN: AAA111 / DE000000AAA1
Zu Ihren Gunsten vor Steuern: EUR 52,40
Steuerbemessungsgrundlage EUR 58,90
Kapitalertragsteuer (2) EUR -6,10
(angerechnete Quellensteuer EUR 7,89)
Solidaritätszuschlag EUR -0,33
Kirchensteuer EUR -0,48
abgeführte Steuern EUR -6,91
Zu Ihren Gunsten nach Steuern: EUR 45,49
Die Gutschrift erfolgt mit Valuta 05.06.2026 auf Konto EUR mit der IBAN DE00 0000 0000 0000 0000 00
(2) Beispielhinweis: Kapitalertragsteuersatz 12,34 %, Kirchensteuersatz 5 %.`;

  it("is read as a tax statement: tax, the amounts before and after, quantity and the date it names", () => {
    const s = inspectSettlement(TAX)!;
    expect(s.taxStatement).toBe(true);
    expect(s.kind).toBe("dividend");
    expect(s.quantity).toBe(40);
    expect(s.tax).toBe(6.91);
    expect(s.gross).toBe(52.4);
    expect(s.net).toBe(45.49);
    expect(s.price).toBeNull();
    expect(s.fees).toBeNull();
    expect(s.executedAt).toBe("2026-06-03");
  });

  it("reads a scan whose OCR made 'Steuem' of 'Steuern' and kept the total's underline", () => {
    const scanned = TAX.replace(/Steuern/g, "Steuem").replace("abgeführte Steuem EUR -6,91", "abgeführte Steuem EUR ________________ -6,91");
    const s = inspectSettlement(scanned)!;
    expect(s.taxStatement).toBe(true);
    expect(s.tax).toBe(6.91);
    expect(s.gross).toBe(52.4);
    expect(s.net).toBe(45.49);
  });

  it("takes the difference before − after taxes when no total is printed, not every tax word and rate", () => {
    const s = inspectSettlement(TAX.replace("abgeführte Steuern EUR -6,91\n", ""))!;
    expect(s.tax).toBe(6.91);
    expect(s.labels.tax).toBe("vor − nach Steuern");
  });

  it("does not take a settlement with its tax statement appended for a tax statement", () => {
    const combined = `Wertpapierabrechnung Verkauf
Stück 40 Alpha Industries AG ISIN DE000000AAA1
Schlusstag 03.06.2026
Kurswert 4.000,00 EUR
Ausmachender Betrag 3.990,00 EUR
Steuerliche Behandlung: Wertpapierverkauf vom 03.06.2026`;
    expect(inspectSettlement(combined)!.taxStatement).toBe(false);
  });
});

describe("parseSettlement — a credit note in a foreign currency, taxes to follow", () => {
  // Synthetic: a dividend paid in USD, converted at the printed rate; the
  // German taxes come on a separate tax statement.
  const CREDIT = `Beispielbank AG
Dividendengutschrift
STK 50,000 Alpha Industries AG WKN/ISIN AAA111 / DE000000AAA1
USD 0,80 Dividende pro Stück
zahlbar ab 10.04.2026
Bruttobetrag: USD 40,00
Quellensteuer USD 6,00
Ausmachender Betrag USD 34,00
zum Devisenkurs: EUR/USD 1,250000 EUR 27,20
Valuta 14.04.2026 Zu Ihren Gunsten vor Steuern EUR 27,20`;

  it("converts every amount at the printed rate and takes the euro amount booked as the net", () => {
    const s = inspectSettlement(CREDIT)!;
    expect(s.kind).toBe("dividend");
    expect(s.currency).toBe("EUR");
    expect(s.quantity).toBe(50);
    expect(s.price).toBe(0.64);
    expect(s.gross).toBe(32);
    expect(s.tax).toBe(4.8);
    expect(s.net).toBe(27.2);
    expect(s.executedAt).toBe("2026-04-10");
    expect(s.labels.currency).toBe("Devisenkurs EUR/USD");
  });

  it("says its amount is before taxes", () => {
    expect(inspectSettlement(CREDIT)!.taxPending).toBe(true);
    expect(inspectSettlement(CREDIT)!.taxStatement).toBe(false);
  });

  it("reads past a footnote marker between a tax label and its amount", () => {
    const s = inspectSettlement(CREDIT.replace("Quellensteuer USD 6,00", "Quellensteuer (1) USD 6,00"))!;
    expect(s.tax).toBe(4.8);
  });
});

describe("security names", () => {
  it("drops the table columns printed next to the name, and labels", () => {
    expect(cleanSecurityName("per 01.02.2026 Alpha Industries AG")).toBe("Alpha Industries AG");
    expect(cleanSecurityName("STK 25,000 Alpha Industries AG")).toBe("Alpha Industries AG");
    expect(cleanSecurityName("Anlageklasse")).toBeNull();
    expect(cleanSecurityName("Alpha Industries AG")).toBe("Alpha Industries AG");
  });

  it("recognises a person's name taken from the address block", () => {
    expect(isPersonName("Paul Beispiel", ["Paul Beispiel"])).toBe(true);
    expect(isPersonName("Herrn Paul Beispiel", ["Paul Beispiel"])).toBe(true);
    expect(isPersonName("Alpha Industries AG", ["Paul Beispiel"])).toBe(false);
  });

  it("reads the name under 'Wertpapier-Bezeichnung' without the holding's date column", () => {
    const s = inspectSettlement(`Beispielbank AG
Dividendengutschrift
Depotbestand Wertpapier-Bezeichnung WKN/ISIN
per 01.02.2026 Alpha Industries AG AAA111
STK 25,000 Registered Shares o.N. DE000000AAA1
Bruttobetrag: EUR 50,00
Ausmachender Betrag EUR 50,00`)!;
    expect(s.name).toBe("Alpha Industries AG");
  });
});

describe("parseSettlement — a tax statement read column by column", () => {
  // Synthetic: the text of a scanned two-column table, where the labels
  // come with their currency and the amounts follow later, one per line.
  // A second page carries year-to-date tables whose figures are no part
  // of this booking.
  const TAX = `Beispielbank AG
Steuerliche Behandlung: Dividende vom 03.06.2026
Stk.   Stk. 40 ALPHA INDUSTRIES AG , WKN / ISIN: AAA111 / DE000000AAA1
Zu Ihren Gunsten vor Steuern:   EUR
Steuerbemessungsgrundlage   EUR   58,90
Kapitalertragsteuer (1)   EUR   -6,10
(angerechnete Quellensteuer:   EUR   7,89 )
Solidaritätszuschlag   EUR   -0,33
Kirchensteuer   EUR   -0,48
abgeführte Steuern   EUR
Zu Ihren Gunsten nach Steuern:   EUR
52,40
-6,91
45,49
Die Gutschrift erfolgt mit Valuta 05.06.2026 auf Konto EUR
Steuern im laufenden Jahr in EUR
Kapitalertragsteuer   Solidaritätszuschlag
Stand   1.234,56   78,90
Kirchensteuer einbehaltene   ausländische Quellensteuer
98,76   54,32`;

  it("pairs each amount with its label again and leaves the year-to-date tables alone", () => {
    const s = inspectSettlement(TAX)!;
    expect(s.taxStatement).toBe(true);
    expect(s.gross).toBe(52.4);
    expect(s.tax).toBe(6.91);
    expect(s.net).toBe(45.49);
    expect(s.quantity).toBe(40);
    expect(s.executedAt).toBe("2026-06-03");
  });

  it("leaves a run of amounts alone when it does not match the labels waiting for one", () => {
    expect(rejoinColumnAmounts("Betrag EUR\n1,00\n2,00")).toBe("Betrag EUR\n1,00\n2,00");
    expect(rejoinColumnAmounts("A EUR\nB EUR\n1,00\n2,00")).toBe("A EUR 1,00\nB EUR 2,00");
  });
});

describe("parseSettlement — a credit note that repeats its kind above its figures", () => {
  // Synthetic: the heading, the holding table, then a sub-heading with the
  // kind again and only then the amounts; a fiscal-year range after the
  // per-share label.
  const CREDIT = `Beispielbank AG
Dividendengutschrift
Depotbestand   Wertpapier-Bezeichnung
per 01.04.2026   Alpha Industries AG
WKN/ISIN
AAA111
STK   50,000   Registered Shares o.N.   DE000000AAA1
USD 0,80   Dividende pro Stück für Zeitraum   01.01.26 bis 31.12.26
zahlbar ab 10.04.2026
Abrechnung Dividendengutschrift
Bruttobetrag:   USD   40,00
-
Quellensteuer   USD   6,00
Ausmachender Betrag   USD   34,00
zum Devisenkurs: EUR/USD   1,250000   EUR   27,20
Verrechnung über Konto   Valuta   Zu Ihren Gunsten vor Steuern
DE00 0000 0000 0000 0000 00   EUR   14.04.2026   EUR   27,20`;

  it("reads the figures below the sub-heading, the per-share amount and the name", () => {
    const s = inspectSettlement(CREDIT)!;
    expect(s.kind).toBe("dividend");
    expect(s.name).toBe("Alpha Industries AG");
    expect(s.quantity).toBe(50);
    expect(s.price).toBe(0.64);
    expect(s.gross).toBe(32);
    expect(s.tax).toBe(4.8);
    expect(s.net).toBe(27.2);
    expect(s.currency).toBe("EUR");
    expect(s.executedAt).toBe("2026-04-10");
    expect(s.taxPending).toBe(true);
  });
});

describe("parseSettlement — accumulated income and the Vorabpauschale", () => {
  // Synthetic notices of a fund that keeps its income.
  const ACCUMULATION = `Beispielbank AG
Mitteilung über Ertragsthesaurierung
Beispiel Welt Fonds ISIN DE000000AAA1
Stück 50
Ertragsthesaurierung je Anteil EUR 0,40
ausschüttungsgleiche Erträge EUR 20,00
Ex-Tag 15.03.2026
Kapitalertragsteuer EUR 3,50
Solidaritätszuschlag EUR 0,19
Zu Ihren Lasten EUR 3,69`;
  const PREPAYMENT = `Beispielbank AG
Steuerliche Behandlung: Vorabpauschale vom 02.01.2026
Stk. 50 BEISPIEL WELT FONDS , ISIN: DE000000AAA1
Vorabpauschale EUR 12,00
Kapitalertragsteuer EUR -2,10
Solidaritätszuschlag EUR -0,11
abgeführte Steuern EUR -2,21
Zu Ihren Lasten nach Steuern: EUR 2,21`;

  it("reads accumulated income as the tax charged, money out, and no payout", () => {
    const s = inspectSettlement(ACCUMULATION)!;
    expect(s.accumulation).toBe(true);
    expect(s.kind).toBe("tax");
    expect(s.tax).toBe(3.69);
    expect(s.net).toBe(-3.69);
    expect(s.gross).toBeNull();
    expect(s.price).toBeNull();
    expect(s.quantity).toBe(50);
    expect(s.executedAt).toBe("2026-03-15");
  });

  it("reads the Vorabpauschale's tax statement the same way, not as a tax statement to join", () => {
    const s = inspectSettlement(PREPAYMENT)!;
    expect(s.accumulation).toBe(true);
    expect(s.kind).toBe("tax");
    expect(s.taxStatement).toBe(false);
    expect(s.tax).toBe(2.21);
    expect(s.net).toBe(-2.21);
    expect(s.executedAt).toBe("2026-01-02");
  });

  it("is a candidate for reading in at all", () => {
    const re = new RegExp(SETTLEMENT_CANDIDATE_PATTERN, "i");
    expect(re.test(ACCUMULATION)).toBe(true);
    expect(re.test(PREPAYMENT)).toBe(true);
  });

  it("leaves a fund's buy and a distribution alone that only mention the words", () => {
    const buy = inspectSettlement(`Wertpapierabrechnung Kauf
Stück 10 Beispiel Welt Fonds ISIN DE000000AAA1
Ertragsverwendung: thesaurierend, ausschüttungsgleiche Erträge werden reinvestiert
Schlusstag 03.06.2026
Kurswert 400,00 EUR
Ausmachender Betrag 400,00 EUR`)!;
    expect(buy.accumulation).toBe(false);
    expect(buy.kind).toBe("buy");

    const payout = inspectSettlement(`Beispielbank AG
Ausschüttung
Beispiel Welt Fonds ISIN DE000000AAA1
Stück 50
Ausschüttung je Anteil EUR 0,40
davon ausschüttungsgleiche Erträge EUR 1,00
Bruttobetrag EUR 20,00
Zahltag 15.03.2026
Betrag zu Ihren Gunsten EUR 20,00`)!;
    expect(payout.accumulation).toBe(false);
    expect(payout.kind).toBe("dividend");
  });
});

describe("security name on a tax statement", () => {
  // Synthetic: the name sits on the identifier line; a table further down
  // heads a line with a bare "Wertpapier".
  const TAX = `Beispielbank AG
Steuerliche Behandlung: Dividende vom 03.06.2026
Stk.   Stk. 40 ALPHA INDUSTRIES AG , WKN / ISIN: AAA111 / DE000000AAA1
Zu Ihren Gunsten vor Steuern: EUR 52,40
abgeführte Steuern EUR -6,91
Zu Ihren Gunsten nach Steuern: EUR 45,49
Wertpapier
Beispielhinweis zur Verrechnung`;

  it("reads the name between the quantity and the identifiers", () => {
    expect(inspectSettlement(TAX)!.name).toBe("ALPHA INDUSTRIES AG");
  });
});

describe("nameNearerIdentifier", () => {
  const TEXT = `Kopf
Stk. 40 ALPHA INDUSTRIES AG , ISIN: DE000000AAA1
Steuer
Wertpapier
Beispielhinweis zur Verrechnung`;

  it("takes the name printed nearer the identifier", () => {
    expect(nameNearerIdentifier(TEXT, "DE000000AAA1", "Beispielhinweis zur Verrechnung", "ALPHA INDUSTRIES AG")).toBe("llm");
    expect(nameNearerIdentifier(TEXT, "DE000000AAA1", "ALPHA INDUSTRIES AG", "Beispielhinweis zur Verrechnung")).toBe("rules");
  });

  it("does not take a name the text does not print", () => {
    expect(nameNearerIdentifier(TEXT, "DE000000AAA1", "ALPHA INDUSTRIES AG", "Erfundene Holding AG")).toBe("rules");
  });
});

describe("parseSettlement — exchange fees listed after the fees' total", () => {
  // Synthetic: the bank's own fees with their total, then the exchange's
  // variable fees on their own line.
  const SALE = `Wertpapierverkauf
Stück 30 Alpha Industries AG ISIN DE000000AAA1
Geschäftstag : 14.07.2026
Kurswert : EUR 3.000,00
Provision : EUR 4,00-
Börsenplatzabhäng. Entgelt : EUR 1,00-
Summe Entgelte : EUR 5,00-
Variable Börsenspesen : EUR 0,75-
Ausmachender Betrag EUR 2.994,25`;

  it("adds them to the total, so the figures add up", () => {
    const s = parseSettlement(SALE)!;
    expect(s.fees).toBe(5.75);
    expect(s.net).toBe(2994.25);
  });

  it("counts them without a printed total too", () => {
    const s = parseSettlement(SALE.replace("Summe Entgelte : EUR 5,00-\n", ""))!;
    expect(s.fees).toBe(5.75);
  });
});

describe("accumulated income — no tax, legal references, names", () => {
  // Synthetic notice of a fund abroad: income kept, no tax deducted here.
  const ABROAD = `Beispielbank AG
Vermögensdepot
0016
Thesaurierung von Investmenterträgen
Nominale Wertpapierbezeichnung ISIN
Stück 12,5 BEISPIEL WELT FONDS DE000000AAA1
Tag des Zuflusses 30.06.2026
Thesaurierungsbetrag brutto 4,20 EUR
Die Investmentgesellschaft hat ihren Sitz im Ausland. Somit kann kein Steuerabzug im Inland vorgenommen werden.
Hinweis: Kirchensteuer nach § 51a EStG und Kapitalertragsteuer werden mit der Steuererklärung erhoben.`;

  it("charges nothing when the notice says no tax was deducted", () => {
    const s = inspectSettlement(ABROAD)!;
    expect(s.accumulation).toBe(true);
    expect(s.tax).toBe(0);
    expect(s.net).toBe(0);
  });

  it("never reads a paragraph number as an amount", () => {
    const s = inspectSettlement(ABROAD.replace(/Die Investmentgesellschaft[^\n]*\n/, ""))!;
    expect(s.tax).toBeNull();
  });

  it("is not named after the depot label, nor with the quantity OCR misread", () => {
    expect(cleanSecurityName("Vermögensdepot")).toBeNull();
    expect(cleanSecurityName("Stiick 0,005 BEISPIEL FONDS ANTEILE")).toBe("BEISPIEL FONDS ANTEILE");
  });
});
