import { describe, it, expect } from "vitest";
import {
  EMPTY_SETTLEMENT,
  isinChecksumValid,
  mergeSettlement,
  parseLlmPaperVerdict,
  parseLlmSettlement,
  settlementChecks,
  type SettlementValues,
} from "./depot-settlement-merge";

// A checksum-valid ISIN for the checks (the synthetic DE000000AAA1 used
// elsewhere is shape-only). DE0007164600 is a well-known public ISIN of a
// listed company, not personal data.
const VALID_ISIN = "DE0007164600";

const buy = (over: Partial<SettlementValues> = {}): SettlementValues => ({
  ...EMPTY_SETTLEMENT,
  kind: "buy",
  isin: VALID_ISIN,
  executedAt: "2026-03-14",
  quantity: 25,
  price: 118.4,
  gross: 2960,
  fees: 6.4,
  tax: null,
  net: -2966.4,
  currency: "EUR",
  ...over,
});

describe("isinChecksumValid", () => {
  it("accepts a valid ISIN and rejects a changed digit", () => {
    expect(isinChecksumValid(VALID_ISIN)).toBe(true);
    expect(isinChecksumValid("DE0007164601")).toBe(false);
    expect(isinChecksumValid("XX")).toBe(false);
  });
});

describe("parseLlmSettlement", () => {
  it("normalises the model's answer and drops what is malformed", () => {
    const v = parseLlmSettlement({
      kind: "buy",
      isin: " de0007164600 ",
      wkn: "ABC",
      name: "Alpha AG",
      depot_number: "12-345-678",
      executed_at: "14.03.2026",
      quantity: "25",
      price: 118.4,
      gross: "2.960,00",
      fees: "6.40",
      tax: null,
      net: 2966.4,
      currency: "eur",
    });
    expect(v).toEqual({
      kind: "buy",
      isin: VALID_ISIN,
      wkn: null,
      name: "Alpha AG",
      depotNumber: "12345678",
      executedAt: "2026-03-14",
      quantity: 25,
      price: 118.4,
      gross: 2960,
      fees: 6.4,
      tax: null,
      net: -2966.4,
      currency: "EUR",
    });
    expect(parseLlmSettlement({ kind: "transfer", net: "x" }).kind).toBeNull();
  });
});

describe("parseLlmPaperVerdict", () => {
  it("reads the model's yes/no and says nothing for an answer without it", () => {
    expect(parseLlmPaperVerdict({ is_settlement: true })).toBe(true);
    expect(parseLlmPaperVerdict({ is_settlement: "false" })).toBe(false);
    expect(parseLlmPaperVerdict({ is_settlement: "nein" })).toBe(false);
    expect(parseLlmPaperVerdict({ kind: "buy" })).toBeNull();
    expect(parseLlmPaperVerdict({ is_settlement: "maybe" })).toBeNull();
  });
});

describe("settlementChecks", () => {
  it("checks the net equation, quantity × price, the ISIN and the date", () => {
    const ok = settlementChecks(buy(), new Date("2026-10-01"));
    expect(ok.map((c) => [c.name, c.result])).toEqual([
      ["net_equation", "ok"],
      ["quantity_price", "ok"],
      ["isin_checksum", "ok"],
      ["date_plausible", "ok"],
    ]);
    const bad = settlementChecks(buy({ net: -3000, executedAt: "2031-01-01" }), new Date("2026-10-01"));
    expect(bad.find((c) => c.name === "net_equation")!.result).toBe("failed");
    expect(bad.find((c) => c.name === "date_plausible")!.result).toBe("failed");
    // A sale subtracts fees and taxes.
    const sell = settlementChecks(
      { ...buy(), kind: "sell", gross: 1450, fees: 10, tax: 21.05, net: 1418.95, quantity: 10, price: 145 },
      new Date("2026-10-01"),
    );
    expect(sell.find((c) => c.name === "net_equation")!.result).toBe("ok");
  });
});

describe("mergeSettlement", () => {
  const today = new Date("2026-10-01");

  it("marks fields both read alike as 'both' and keeps the rules when there is no model", () => {
    const both = mergeSettlement(buy(), buy(), today);
    expect(both.verdict).toBe("ok");
    expect(both.fields.find((f) => f.field === "net")!.source).toBe("both");

    const rulesOnly = mergeSettlement(buy(), null, today);
    expect(rulesOnly.values).toEqual(buy());
    expect(rulesOnly.fields.find((f) => f.field === "net")!.source).toBe("rules");
  });

  it("fills what the rules missed from the model", () => {
    const r = mergeSettlement(buy({ fees: null, net: null }), buy(), today);
    expect(r.values.fees).toBe(6.4);
    expect(r.values.net).toBe(-2966.4);
    expect(r.fields.find((f) => f.field === "fees")!.source).toBe("llm");
    expect(r.verdict).toBe("ok");
  });

  it("takes the reading whose figures add up when they disagree", () => {
    // The rules read the commission line as the net (a renamed label).
    const r = mergeSettlement(buy({ net: -4.9 }), buy(), today);
    expect(r.values.net).toBe(-2966.4);
    expect(r.fields.find((f) => f.field === "net")).toMatchObject({ source: "llm", disagree: true });
    expect(r.verdict).toBe("ok");

    // And the other way round: the model misplaced a digit.
    const l = mergeSettlement(buy(), buy({ gross: 29600 }), today);
    expect(l.values.gross).toBe(2960);
    expect(l.fields.find((f) => f.field === "gross")!.source).toBe("rules");
  });

  it("keeps the rules' value for a field no check vouches for, even when the model wins on the figures", () => {
    // A dividend tax statement: the rules read "Stk. 20" and the credited
    // foreign tax as the tax; the model adds up (gross − tax = net) but took
    // "200" from a code on the letterhead as the quantity. No price per
    // share, so no check reaches the quantity.
    const rules: SettlementValues = {
      ...EMPTY_SETTLEMENT,
      kind: "dividend",
      isin: VALID_ISIN,
      quantity: 20,
      tax: 0.73,
      executedAt: "2026-02-18",
      currency: "EUR",
    };
    const llm: SettlementValues = {
      ...rules,
      quantity: 200,
      gross: 12.92,
      tax: 1.94,
      net: 10.98,
    };
    const r = mergeSettlement(rules, llm, today);
    expect(r.verdict).toBe("ok");
    expect(r.values.quantity).toBe(20);
    expect(r.fields.find((f) => f.field === "quantity")).toMatchObject({ source: "rules", disagree: true });
    // The tax is in the equation that made the model's reading add up: the model's.
    expect(r.values.tax).toBe(1.94);
    expect(r.fields.find((f) => f.field === "tax")!.source).toBe("llm");
    expect(r.values.net).toBe(10.98);
  });

  it("lets the booking's net decide between charges the two read differently", () => {
    // No final amount on paper; the rules summed overlapping fee lines (24,80),
    // the model took the order costs (12,40). The account was charged 808,20.
    const base = buy({ quantity: 10, price: 79.58, gross: 795.8, tax: null, net: null, isin: null, wkn: "AAA111" });
    const rules = { ...base, fees: 24.8 };
    const llm = { ...base, fees: 12.4 };
    const blind = mergeSettlement(rules, llm, today);
    expect(blind.values.fees).toBe(24.8);
    const decided = mergeSettlement(rules, llm, today, -808.2);
    expect(decided.values.fees).toBe(12.4);
    expect(decided.values.net).toBe(-808.2);
    expect(decided.fields.find((f) => f.field === "fees")).toMatchObject({ source: "llm", disagree: true });
    expect(decided.checks.find((c) => c.name === "booking_net")!.result).toBe("ok");
  });

  it("is unverified when they disagree and neither adds up", () => {
    const r = mergeSettlement(buy({ net: -3100 }), buy({ net: -3200 }), today);
    expect(r.verdict).toBe("unverified");
  });

  it("derives the net from Kurswert and charges when no source printed one", () => {
    const r = mergeSettlement(buy({ net: null }), null, today);
    expect(r.values.net).toBe(-2966.4);
    expect(r.fields.find((f) => f.field === "net")).toMatchObject({ source: "derived", rules: null, llm: null });
    // The equation check did not get to see the derived value.
    expect(r.checks.find((c) => c.name === "net_equation")!.result).toBe("skipped");
    const sell = mergeSettlement({ ...buy(), kind: "sell", net: null, tax: 10 }, null, today);
    expect(sell.values.net).toBe(2943.6);
  });

  it("reads a settlement the rules do not recognise at all", () => {
    const r = mergeSettlement({ ...EMPTY_SETTLEMENT }, buy(), today);
    expect(r.values.kind).toBe("buy");
    expect(r.fields.every((f) => f.source === null || f.source === "llm")).toBe(true);
    expect(r.verdict).toBe("ok");
  });
});
