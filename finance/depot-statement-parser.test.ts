import { describe, expect, it } from "vitest";

import {
  inspectDepotStatement,
  looksLikeDepotStatement,
  mergeStatement,
  parseLlmStatement,
  positionAddsUp,
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
