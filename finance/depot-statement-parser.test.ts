import { describe, expect, it } from "vitest";

import {
  inspectDepotStatement,
  looksLikeDepotStatement,
  mergeStatement,
  parseLlmStatement,
  positionAddsUp,
  repairWkn,
  reportTrades,
  statementDate,
} from "./depot-statement-parser";

// Synthetic identifiers and texts only — see CLAUDE.md "Keine PII".
const ISIN_A = "DE000000AAA1";
const ISIN_B = "LU000000BBB4";

const STATEMENT_TEXT = `Beispielbank AG
Depotauszug per 31.12.2025
Depot-Nr. 9900000002

Bezeichnung                      Stück      Kurs        Kurswert
Alpha Industries AG
ISIN ${ISIN_A} WKN AAA111       25,000   118,40 EUR   2.960,00 EUR
Beta Global Fonds
ISIN ${ISIN_B}                   10,500    95,20 EUR     999,60 EUR

Depotwert gesamt 3.959,60 EUR`;

describe("looksLikeDepotStatement", () => {
  it("takes the heading words, not a settlement that mentions the depot", () => {
    expect(looksLikeDepotStatement(STATEMENT_TEXT)).toBe(true);
    expect(looksLikeDepotStatement("Wertpapierabrechnung Kauf\nDepotbestand nach Ausführung 25 Stück")).toBe(false);
    expect(looksLikeDepotStatement("Rechnung Strom Oktober")).toBe(false);
  });
});

describe("statementDate", () => {
  it("reads the day the holdings are stated for", () => {
    expect(statementDate("Depotauszug per 31.12.2025")).toBe("2025-12-31");
    expect(statementDate("Vermögensübersicht\nStand: 1.3.2026")).toBe("2026-03-01");
    expect(statementDate("Bestand zum 30.06.2025")).toBe("2025-06-30");
    expect(statementDate("Rechnung vom 12.01.2026")).toBeNull();
  });
});

describe("inspectDepotStatement", () => {
  it("reads the date, the depot number and one position per identifier", () => {
    const r = inspectDepotStatement(STATEMENT_TEXT)!;
    expect(r.statement).toBe(true);
    expect(r.asOf).toBe("2025-12-31");
    expect(r.depotNumber).toBe("9900000002");
    expect(r.positions).toHaveLength(2);
    const [a, b] = r.positions;
    expect(a).toMatchObject({ isin: ISIN_A, wkn: "AAA111", name: "Alpha Industries AG", currency: "EUR" });
    expect(b).toMatchObject({ isin: ISIN_B, wkn: null, name: "Beta Global Fonds" });
  });

  it("reads the figures when they stand after their labels", () => {
    const text = `Depotbestand per 30.09.2025
Alpha Industries AG
ISIN ${ISIN_A}
Stück 25 Kurs 118,40 EUR Kurswert 2.960,00 EUR Einstandskurs 100,00 EUR`;
    const [p] = inspectDepotStatement(text)!.positions;
    expect(p).toMatchObject({ quantity: 25, price: 118.4, value: 2960, acquisitionPrice: 100 });
    expect(positionAddsUp(p!)).toBe(true);
  });

  it("reads the quantity printed before its unit", () => {
    const text = `Depotauszug zum 30.09.2025
Beta Global Fonds ISIN ${ISIN_B}
10,5 Anteile Rücknahmepreis 95,20 EUR Wert 999,60 EUR`;
    const [p] = inspectDepotStatement(text)!.positions;
    expect(p).toMatchObject({ quantity: 10.5, price: 95.2, value: 999.6 });
  });

  it("is not a statement without the heading words, but still lists what it finds", () => {
    const r = inspectDepotStatement(`Mitteilung\nISIN ${ISIN_A}`)!;
    expect(r.statement).toBe(false);
    expect(r.positions).toHaveLength(1);
  });
});

// A bank's periodic report: the holdings table runs over pages, with the
// usual OCR slips — "7" for "/", an O in a WKN, amounts split after a separator.
const REPORT_TEXT = `Finanzreport Nr. 9 per 01.04.2026 - Seite 7
Kundennummer 000 0000000 Beispielbank
Umsätze: Wertpapierkauf vom 02.03.2026 siehe Abrechnung
Depot
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
Bezeichnung Kurs Stückzinsen
AAA111 / Girosammelverwahrung 25,000 118,400 EUR 2.960,00 2.500,00 +460,00
ALPHA INDUSTRIES AG NA O.N. +0,00
BBB222 / Wertpapierrechnung 100,000 12,500 EUR 1.250,00 1.400,00 -150,00
Beispielland über AKV +0,00
BETA GLOBAL PLC LS 0.10
Beispielbank - Musterstadt
Seite 7
Finanzreport Nr. 9 per 01.04.2026 - Seite 8
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
Bezeichnung Kurs Stückzinsen
CCC333 7 Girosammelverwahrung 40,000 198,750 EUR 7. 950, 00 6.000,00 +1.950,00
GAMMA WERKE AG ST +0, 00
DOD4E4 / Girosammelverwahrung 10,000 1.234,500 EUR 12.345,00 9.000,00 +3.345,00
DELTA SE INH O.N. +0,00`;

describe("holdings table of a periodic report", () => {
  it("reads every row across pages, with name, figures and the cost per unit", () => {
    const r = inspectDepotStatement(REPORT_TEXT)!;
    // A holdings table is a statement, whatever trades the report lists besides.
    expect(r.statement).toBe(true);
    expect(r.asOf).toBe("2026-04-01");
    expect(r.depotNumber).toBeNull();
    expect(r.positions.map((p) => p.wkn)).toEqual(["AAA111", "BBB222", "CCC333", "D0D4E4"]);
    expect(r.positions[0]).toEqual({
      isin: null,
      wkn: "AAA111",
      name: "ALPHA INDUSTRIES AG NA O.N.",
      quantity: 25,
      price: 118.4,
      value: 2960,
      currency: "EUR",
      acquisitionPrice: 100,
    });
    // Held abroad: the custodian line is not the name.
    expect(r.positions[1]).toMatchObject({ name: "BETA GLOBAL PLC LS 0.10", quantity: 100, value: 1250, acquisitionPrice: 14 });
    // "7" for "/", and an amount split after its separators.
    expect(r.positions[2]).toMatchObject({ name: "GAMMA WERKE AG ST", quantity: 40, price: 198.75, value: 7950 });
    expect(r.positions[3]).toMatchObject({ name: "DELTA SE INH O.N.", quantity: 10, price: 1234.5, value: 12345 });
    for (const p of r.positions) expect(positionAddsUp(p)).toBe(true);
  });

  it("does not take the column header for a WKN", () => {
    const r = inspectDepotStatement("Depotbestand\nWKN / Verwahrart Anzahl Kurswert")!;
    expect(r.positions).toEqual([]);
  });

  it("keeps to the holdings table: a trade or booking the report lists elsewhere is no holding", () => {
    // The report's own pages list a sale of a security the depot no longer
    // holds, with its quantity nearby; only the table says what is held.
    const r = inspectDepotStatement(`Finanzreport Nr. 3 per 01.03.2026 - Seite 2
Umsätze
02.02.2026 Wertpapierverkauf WKN EEE555 ISIN DE000EEE5559 Stück 7
03.02.2026 Kontoführung 4,90
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
AAA111 / Girosammelverwahrung 25,000 118,400 EUR 2.960,00 2.500,00 +460,00
ALPHA INDUSTRIES AG NA O.N. +0,00
BBB222 / Girosammelverwahrung 1O0,0OO 12,5OO EUR 1.25O,0O 1.4OO,0O -150,00
BETA GLOBAL AG +0,00`)!;
    expect(r.positions.map((p) => p.wkn)).toEqual(["AAA111"]);
    // A row whose figures OCR garbled still belongs to the table.
    expect(r.tableWkns).toEqual(["AAA111", "BBB222"]);
  });

  it("names no table on a statement without one", () => {
    expect(inspectDepotStatement(STATEMENT_TEXT)!.tableWkns).toEqual([]);
  });

  it("repairs a WKN OCR read with I or O", () => {
    expect(repairWkn("AOB2C3")).toBe("A0B2C3");
    expect(repairWkn("i23456")).toBe("123456");
  });
});

describe("parseLlmStatement", () => {
  it("validates identifiers and numbers and drops positions without an identifier", () => {
    const r = parseLlmStatement({
      is_statement: "true",
      as_of: "31.12.2025",
      depot_number: "9900 000 002",
      positions: [
        { isin: ISIN_A, wkn: "aaa111", name: "Alpha Industries AG", quantity: "25,000", price: 118.4, value: "2.960,00", currency: "eur" },
        { isin: "DE000000AAA2", name: "bad checksum, no wkn", quantity: 1 },
        { name: "no identifier at all", quantity: 3 },
        { wkn: "BBB222", quantity: 10.5, value: 999.6, acquisition_price: "90,00" },
      ],
    });
    expect(r.isStatement).toBe(true);
    expect(r.asOf).toBe("2025-12-31");
    expect(r.depotNumber).toBe("9900000002");
    expect(r.positions).toHaveLength(2);
    expect(r.positions[0]).toMatchObject({ isin: ISIN_A, wkn: "AAA111", quantity: 25, price: 118.4, value: 2960, currency: "EUR" });
    expect(r.positions[1]).toMatchObject({ isin: null, wkn: "BBB222", quantity: 10.5, acquisitionPrice: 90 });
  });
});

describe("mergeStatement", () => {
  const rules = {
    asOf: "2025-12-31",
    depotNumber: null,
    positions: [
      { isin: ISIN_A, wkn: null, name: "Alpha Industries AG", quantity: 25, price: 118.4, value: 2960, currency: "EUR", acquisitionPrice: null },
      { isin: ISIN_B, wkn: null, name: null, quantity: null, price: null, value: 999.6, currency: "EUR", acquisitionPrice: null },
    ],
  };

  it("takes the model first and lets the rules fill in", () => {
    const m = mergeStatement(rules, {
      asOf: null,
      depotNumber: "9900000002",
      positions: [
        { isin: ISIN_A, wkn: "AAA111", name: "Alpha Industries AG", quantity: 25, price: 118.4, value: 2960, currency: null, acquisitionPrice: 100 },
        { isin: ISIN_B, wkn: null, name: "Beta Global Fonds", quantity: 10.5, price: 95.2, value: null, currency: null, acquisitionPrice: null },
      ],
    });
    expect(m.asOf).toBe("2025-12-31");
    expect(m.depotNumber).toBe("9900000002");
    expect(m.positions).toHaveLength(2);
    expect(m.positions[0]).toMatchObject({ wkn: "AAA111", acquisitionPrice: 100, currency: "EUR", checked: true, source: "both" });
    expect(m.positions[1]).toMatchObject({ name: "Beta Global Fonds", quantity: 10.5, value: 999.6, checked: true });
  });

  it("keeps the rules' figures when the model's do not add up and the rules' do", () => {
    const m = mergeStatement(rules, {
      asOf: null,
      depotNumber: null,
      positions: [{ isin: ISIN_A, wkn: null, name: null, quantity: 250, price: 118.4, value: 2960, currency: null, acquisitionPrice: null }],
    });
    expect(m.positions[0]).toMatchObject({ quantity: 25, checked: true, source: "rules" });
    // The rules' second position comes along.
    expect(m.positions[1]).toMatchObject({ isin: ISIN_B, source: "rules" });
  });

  it("works without the model", () => {
    const m = mergeStatement(rules, null);
    expect(m.positions).toHaveLength(2);
    expect(m.positions[0]!.source).toBe("rules");
  });
});

describe("holdings table rows as OCR reads a second page", () => {
  // Synthetic: the table continues on the next page, OCR read the slash
  // after a WKN as "2", a thousands point as a space, and moved one row's
  // price and value off its line.
  const PAGE = `Finanzreport per 30.06.2025 - Seite 12
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
Bezeichnung Kurs Stückzinsen
EEE555 2 Girosammelverwahrung 100,000 50,000 EUR 5.000,00 4.000,00 +1.000,00
EPSILON INDEX U.ETF +0,00
FFF666 / Girosammelverwahrung 10,000 200,000 EUR 2.000,00 1 500, 00 +500,00
ZETA CORP. DL-,10
GGG777 / Girosammelverwahrung 30,000
+0,00
EUR 1.200,00 +300,00
ETA DL-,10
SYSTEMS
HHH888 2 Girosammelverwahrung 40,000 100,000 EUR 4.000,00 +900,00
THETA INC. +0,00
Gesamtkurswert 11.000,00`;

  it("reads every row the table lists", () => {
    const r = inspectDepotStatement(PAGE)!;
    expect(r.tableWkns).toEqual(["EEE555", "FFF666", "GGG777", "HHH888"]);
    expect(r.positions.map((p) => [p.wkn, p.quantity])).toEqual([
      ["EEE555", 100],
      ["FFF666", 10],
      ["GGG777", 30],
      ["HHH888", 40],
    ]);
  });

  it("keeps the quantity of a row whose figures went elsewhere, and its name past them", () => {
    const row = inspectDepotStatement(PAGE)!.positions.find((p) => p.wkn === "GGG777")!;
    expect(row).toMatchObject({ quantity: 30, price: null, value: null, name: "ETA DL-,10" });
  });

  it("reads a thousands point OCR read as a space", () => {
    const row = inspectDepotStatement(PAGE)!.positions.find((p) => p.wkn === "FFF666")!;
    expect(row.acquisitionPrice).toBe(150);
  });
});

describe("reportTrades", () => {
  it("reads the trades a report's transaction overview lists", () => {
    const text = `Transaktionsübersicht vom 01. Januar 2026 bis 31. März 2026
Handelsdatum   Transaktion   Betrag   AGS/Soli/KIST   Anteilspreis
14.03.26   Verkauf   120,00 EUR   12,0000 EUR
02.02.2026   Kauf   1.500,00 EUR   15,0000 EUR
20.03.26   Ausschüttung   8,40 EUR
Keine Transaktionen im vergangenen Quartal
vom 01.01.2026 bis 31.03.2026`;
    expect(reportTrades(text)).toEqual([
      { executedAt: "2026-03-14", kind: "sell", amount: 120 },
      { executedAt: "2026-02-02", kind: "buy", amount: 1500 },
      { executedAt: "2026-03-20", kind: "dividend", amount: 8.4 },
    ]);
  });
});
