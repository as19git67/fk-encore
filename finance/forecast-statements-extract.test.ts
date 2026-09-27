import { describe, it, expect } from "vitest";

import {
  EMPTY_VALUES,
  applyProposals,
  checkUserValues,
  classifyDocument,
  computeProposals,
  contractKey,
  contractPattern,
  hasAnyValue,
  isSearchableKey,
  mergeStatementValues,
  parseGermanAmount,
  parseLlmKind,
  parseLlmStatement,
  parseStatementText,
  pickValues,
  validateValues,
  type StatementValues,
} from "./forecast-statements-extract";

// Every statement text below is invented. It imitates the wording of German
// insurer statements; no name, number or amount comes from a real document.

const LIFE = `
Beispiel Lebensversicherung AG · Musterstraße 1 · 12345 Musterstadt
Jährliche Standmitteilung zu Ihrer Kapitallebensversicherung
Versicherungsnummer: X-000111-01
Stand: 01.12.2025

Ihr Vertrag im Überblick
Versicherungsbeginn            01.10.1999
Ablauf der Beitragszahlung     01.10.2032
Ablauf der Versicherung        01.10.2037
Monatlicher Beitrag            241,02 EUR

Werte zum Stichtag
Rückkaufswert                  77.508,29 EUR
Garantierte Ablaufleistung     55.000,00 EUR
Voraussichtliche Ablaufleistung inkl. Überschussbeteiligung   132.442,77 EUR
Die Verzinsung beträgt 2,25 % p. a.
`;

const PENSION = `
Deutsche Beispielrente · Renteninformation 2025
Stichtag 15.03.2025
Versicherungsnummer 12 345678 A 901
Höhe Ihrer künftigen Regelaltersrente: 1.848,00 €
Rentenbeginn: 01.07.2034
Ihre Rente wegen voller Erwerbsminderung würde 1.203,55 € betragen.
`;

const FUND = `
Musterfonds-Police · Wertmitteilung
Wertstand zum 31.12.2025
Fondsguthaben 100.238,86 EUR
Beitrag monatlich 353,06 €
Kapitalwahlrecht: einmalig 95.000,00 €
Garantierte monatliche Rente 310,50 EUR
Mögliche monatliche Rente 480,00 EUR
Beginn der Rente 01.09.2042
`;

describe("parseGermanAmount", () => {
  it("reads German number formats", () => {
    expect(parseGermanAmount("77.508,29")).toBe(77508.29);
    expect(parseGermanAmount("1.848")).toBe(1848);
    expect(parseGermanAmount("241,02")).toBe(241.02);
    expect(parseGermanAmount("12345")).toBe(12345);
    expect(parseGermanAmount("1,2,3")).toBeNull();
  });
});

describe("parseStatementText", () => {
  it("reads a life insurance statement", () => {
    const v = parseStatementText(LIFE);
    expect(v.referenceDate).toBe("2025-12-01");
    expect(v.surrenderValue).toBe(77508.29);
    expect(v.guaranteedPayout).toBe(55000);
    expect(v.projectedPayout).toBe(132442.77);
    expect(v.premiumMonthly).toBe(241.02);
    expect(v.premiumEndDate).toBe("2032-10-01");
    expect(v.maturityDate).toBe("2037-10-01");
  });

  it("reads a statutory pension statement and ignores the contract number", () => {
    const v = parseStatementText(PENSION);
    expect(v.referenceDate).toBe("2025-03-15");
    expect(v.projectedMonthlyPension).toBe(1848);
    expect(v.pensionStartDate).toBe("2034-07-01");
    expect(v.surrenderValue).toBeNull();
  });

  it("reads a fund policy statement", () => {
    const v = parseStatementText(FUND);
    expect(v.referenceDate).toBe("2025-12-31");
    expect(v.contractValue).toBe(100238.86);
    expect(v.premiumMonthly).toBe(353.06);
    expect(v.lumpSum).toBe(95000);
    expect(v.guaranteedMonthlyPension).toBe(310.5);
    expect(v.projectedMonthlyPension).toBe(480);
    expect(v.pensionStartDate).toBe("2042-09-01");
  });

  it("does not take a percentage, a year or a date for an amount", () => {
    const v = parseStatementText("Rückkaufswert zum 01.10.2030 2,5 % 2030\nRückkaufswert 1.000,00 EUR");
    expect(v.surrenderValue).toBe(1000);
  });

  it("finds nothing in an unrelated text", () => {
    expect(hasAnyValue(parseStatementText("Sehr geehrte Damen und Herren, anbei die Rechnung Nr. 4711."))).toBe(false);
    expect(hasAnyValue(parseStatementText(""))).toBe(false);
  });
});

describe("parseLlmStatement", () => {
  it("takes numbers and dates in the forms models return", () => {
    const v = parseLlmStatement({
      referenceDate: "2025-12-01",
      surrenderValue: "77.508,29 €",
      projectedPayout: 132442.77,
      maturityDate: "01.10.2037",
      premiumMonthly: "241.02",
      unknownKey: 5,
      lumpSum: "keine Angabe",
    });
    expect(v).toMatchObject({
      referenceDate: "2025-12-01",
      surrenderValue: 77508.29,
      projectedPayout: 132442.77,
      maturityDate: "2037-10-01",
      premiumMonthly: 241.02,
      lumpSum: null,
    });
    expect(parseLlmStatement("nonsense")).toEqual(EMPTY_VALUES);
  });
});

describe("validateValues and mergeStatementValues", () => {
  const v = (over: Partial<StatementValues>): StatementValues => ({ ...EMPTY_VALUES, ...over });

  it("drops implausible values", () => {
    const out = validateValues(
      v({
        referenceDate: "2031-01-01", // in the future
        surrenderValue: -5,
        premiumMonthly: 99_999,
        guaranteedPayout: 200_000,
        projectedPayout: 100_000, // guarantee above projection → guarantee dropped
        maturityDate: "2150-01-01",
      }),
      "2026-09-25",
    );
    expect(out).toMatchObject({ referenceDate: null, surrenderValue: null, premiumMonthly: null, guaranteedPayout: null, projectedPayout: 100_000, maturityDate: null });
  });

  it("drops dates that contradict the reference date", () => {
    const out = validateValues(v({ referenceDate: "2025-12-01", maturityDate: "2020-01-01", premiumEndDate: "2040-01-01" }), "2026-09-25");
    expect(out.maturityDate).toBeNull();
    expect(out.premiumEndDate).toBe("2040-01-01");
    const out2 = validateValues(v({ maturityDate: "2037-10-01", premiumEndDate: "2040-01-01" }), "2026-09-25");
    expect(out2.premiumEndDate).toBeNull();
  });

  it("prefers the model where both have a value and fills gaps from the patterns", () => {
    const regex = v({ surrenderValue: 1000, projectedPayout: 5000, referenceDate: "2025-12-01" });
    const llm = v({ surrenderValue: 1100, maturityDate: "2037-10-01" });
    const merged = mergeStatementValues(regex, llm, "2026-09-25");
    expect(merged.method).toBe("llm");
    expect(merged.values).toMatchObject({ surrenderValue: 1100, projectedPayout: 5000, maturityDate: "2037-10-01", referenceDate: "2025-12-01" });
    expect(mergeStatementValues(regex, null, "2026-09-25").method).toBe("regex");
    // An implausible model value does not override a plausible pattern value.
    expect(mergeStatementValues(regex, v({ surrenderValue: -1 }), "2026-09-25").values.surrenderValue).toBe(1000);
  });
});

describe("computeProposals and applyProposals", () => {
  const values = parseStatementText(LIFE);
  const item = {
    surrenderValue: 70000,
    monthlyPremium: 241.02,
    guaranteedPayout: 55000,
    projectedPayout: 130000,
    maturity: { kind: "date", date: "2038-01-01" },
    premiumEnd: { kind: "date", date: "2032-10-01" },
    contractNo: "X-000111-01",
  };

  it("lists the fields where the statement differs", () => {
    const p = computeProposals("life_insurance", item, values);
    expect(p.map((x) => x.field).sort()).toEqual(["maturity", "projectedPayout", "surrenderValue"]);
    expect(p.find((x) => x.field === "surrenderValue")).toMatchObject({ current: 70000, proposed: 77508.29, kind: "amount" });
    expect(p.find((x) => x.field === "maturity")).toMatchObject({ current: "2038-01-01", proposed: "2037-10-01", kind: "date" });
  });

  it("ignores rounding noise and leaves milestone dates alone", () => {
    const p = computeProposals(
      "life_insurance",
      { ...item, surrenderValue: 77508.0, projectedPayout: 132442.77, maturity: { kind: "milestone", milestoneId: 3 } },
      values,
    );
    expect(p.map((x) => x.field)).toEqual([]);
  });

  it("compares pensions and premiums booked as expenses", () => {
    const pv = parseStatementText(PENSION);
    expect(computeProposals("pension", { monthlyAmount: 1800, start: { kind: "date", date: "2034-01-01" } }, pv).map((x) => x.field).sort()).toEqual([
      "monthlyAmount",
      "start",
    ]);
    const fv = parseStatementText(FUND);
    expect(computeProposals("expense", { amount: 4000, frequency: "yearly" }, fv)[0]).toMatchObject({ field: "amount", proposed: 4236.72 });
    expect(computeProposals("salary", { amount: 1 }, fv)).toEqual([]);
  });

  it("writes accepted values and records the statement as the source", () => {
    const p = computeProposals("life_insurance", item, values);
    const next = applyProposals(item, p, { documentId: 42, referenceDate: "2025-12-01", now: "2026-09-25T10:00:00Z" });
    expect(next).toMatchObject({
      surrenderValue: 77508.29,
      projectedPayout: 132442.77,
      maturity: { kind: "date", date: "2037-10-01" },
      contractNo: "X-000111-01",
      valuesSource: { kind: "statement", documentId: 42, referenceDate: "2025-12-01" },
    });
  });
});

describe("contract keys", () => {
  it("compares contract numbers regardless of separators and case", () => {
    expect(contractKey("S-0122 5520/01")).toBe(contractKey("s-01225520-01"));
    expect(contractKey("L 1.234.567")).toBe("l1234567");
    expect(isSearchableKey("x000111")).toBe(true);
    expect(isSearchableKey("ab12")).toBe(false);
    expect(isSearchableKey("abcdefg")).toBe(false);
  });
});

describe("forecast-statements-extract — contract numbers in text", () => {
  const hit = (key: string, text: string) => new RegExp(contractPattern(key), "i").test(text);

  it("matches however the number is spaced, dotted or dashed", () => {
    expect(hit("l1234567", "Vers.-Nr. L 1.234.567 vom")).toBe(true);
    expect(hit("l1234567", "Vertrag L1234567")).toBe(true);
    expect(hit("l1234567", "Nummer 1 234 567,")).toBe(true); // prefix left out
    expect(hit("x00011101", "X-000111-01")).toBe(true);
  });

  it("does not match inside a longer number or a different suffix", () => {
    expect(hit("l1234567", "91234567")).toBe(false);
    expect(hit("l1234567", "L 12345678")).toBe(false);
    expect(hit("x00011101", "X-000111-02")).toBe(false);
    expect(hit("x00011101", "Betrag 1.234,56")).toBe(false);
  });
});

describe("forecast-statements-extract — kinds of documents", () => {
  it("tells an announcement from a confirmed decline", () => {
    const increase = "Planmäßige Erhöhung (Dynamik). Wenn Sie die Erhöhung nicht wünschen, können Sie widersprechen. Nach zwei Widersprüchen entfällt das Recht.";
    expect(classifyDocument(increase, null)).toBe("dynamic_increase");
    expect(classifyDocument("Ihren Widerspruch gegen die Dynamikerhöhung haben wir erhalten.", null)).toBe("dynamic_declined");
    expect(classifyDocument("Die Erhöhung wird nicht durchgeführt.", null)).toBe("dynamic_declined");
    expect(classifyDocument("Stand 01.01.2026, Rückkaufswert 1.000,00 EUR", null)).toBe("statement");
    // A Standmitteilung mentioning its Dynamik stays a statement.
    expect(classifyDocument("Ihr Vertrag enthält eine Dynamik von 5 %.", "standmitteilung")).toBe("statement");
  });

  it("takes the model's kind only when it is one of the four", () => {
    expect(parseLlmKind({ documentKind: "dynamik_abgelehnt" })).toBe("dynamic_declined");
    expect(parseLlmKind({ documentKind: "Dynamik_Erhöhung" })).toBe("dynamic_increase");
    expect(parseLlmKind({ documentKind: "brief" })).toBeNull();
    expect(parseLlmKind(null)).toBeNull();
  });

  it("reads the new premium of an increase, not the old one", () => {
    const v = parseStatementText("Ihr bisheriger monatlicher Beitrag 241,02 EUR\nIhr neuer monatlicher Beitrag ab 01.12.2025 253,07 EUR");
    expect(v.premiumMonthly).toBe(253.07);
  });
});


describe("forecast-statements-extract — values typed by the user", () => {
  it("keeps known keys only and names implausible fields", () => {
    const v = pickValues({ surrenderValue: 1200.5, maturityDate: "2037-10-01", premiumEndDate: "", bogus: 5, lumpSum: "12" });
    expect(v).toMatchObject({ surrenderValue: 1200.5, maturityDate: "2037-10-01", premiumEndDate: null, lumpSum: null });
    expect(v).not.toHaveProperty("bogus");
    expect(checkUserValues(v)).toEqual([]);
    expect(checkUserValues({ ...v, surrenderValue: -1, premiumMonthly: 50_000, maturityDate: "2037-13-01" })).toEqual([
      "surrenderValue",
      "premiumMonthly",
      "maturityDate",
    ]);
  });
});
