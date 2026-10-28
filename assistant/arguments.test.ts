/**
 * Arguments checked against the schema before a tool runs (stage 2 of
 * assistent-wegfindung.md): the error names the argument, what was sent and
 * what is allowed.
 */

import { describe, it, expect } from "vitest";

import { argumentError, checkArguments, nearestName } from "./arguments";
import type { JsonSchema } from "./types";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    q: { type: "string" },
    from: { type: "string", description: "first booking date, YYYY-MM-DD" },
    to: { type: "string", description: "last booking date, YYYY-MM-DD" },
    account_id: { type: "integer" },
    amount_min: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
    person_ids: { type: "array", items: { type: "integer" } },
    direction: { type: "string", enum: ["out", "in"] },
    tax_relevant: { type: "boolean" },
    yield: { type: "object" },
  },
  required: ["q"],
};
const tool = { parameters: SCHEMA };

describe("checkArguments", () => {
  it("lets a well-formed call through, numbers and booleans as strings included", () => {
    expect(checkArguments(tool, { q: "Miete", from: "2026-01-01", account_id: "3", amount_min: 12.5, tags: ["a"], direction: "out", tax_relevant: "true", yield: {} })).toEqual([]);
    expect(checkArguments(tool, { q: 100, to: null })).toEqual([]);
  });

  it("names an unknown argument and the one most likely meant", () => {
    expect(checkArguments(tool, { q: "x", acount_id: 3 })).toEqual(["unknown argument acount_id; did you mean account_id?"]);
    expect(checkArguments(tool, { q: "x", account: 3 })).toEqual(["unknown argument account; did you mean account_id?"]);
    expect(checkArguments(tool, { q: "x", colour: "red" })).toEqual([
      "unknown argument colour; the arguments are q, from, to, account_id, amount_min, tags, person_ids, direction, tax_relevant, yield",
    ]);
    expect(checkArguments({ parameters: { type: "object", properties: {} } }, { year: 2025 })).toEqual(["unknown argument year; it takes no arguments"]);
  });

  it("names a missing required argument", () => {
    expect(checkArguments(tool, {})).toEqual(["q is required"]);
    expect(checkArguments(tool, { q: "" })).toEqual(["q is required"]);
  });

  it("names a value outside the enum with the allowed ones", () => {
    expect(checkArguments(tool, { q: "x", direction: "expenses" })).toEqual(['direction must be one of out, in; got "expenses"']);
  });

  it("names a wrong type, in arrays too", () => {
    expect(checkArguments(tool, { q: "x", account_id: "three" })).toEqual(['account_id must be a integer; got "three"']);
    expect(checkArguments(tool, { q: "x", account_id: 2.5 })).toEqual(["account_id must be a whole number; got 2.5"]);
    expect(checkArguments(tool, { q: "x", tax_relevant: "yes" })).toEqual(['tax_relevant must be true or false; got "yes"']);
    expect(checkArguments(tool, { q: "x", tags: "Miete" })).toEqual(['tags must be an array; got "Miete"']);
    expect(checkArguments(tool, { q: "x", person_ids: [1, "two"] })).toEqual(['every item of person_ids must be a integer; got "two"']);
    expect(checkArguments(tool, { q: "x", yield: [] })).toEqual(["yield must be an object; got []"]);
  });

  it("turns a year, a month or a German date into the day the argument needs", () => {
    expect(checkArguments(tool, { q: "x", from: "2025" })).toEqual(['from must be a day, YYYY-MM-DD; got "2025". For the year 2025 use 2025-01-01']);
    expect(checkArguments(tool, { q: "x", to: "2025" })).toEqual(['to must be a day, YYYY-MM-DD; got "2025". For the year 2025 use 2025-12-31']);
    expect(checkArguments(tool, { q: "x", to: "2026-02" })).toEqual(['to must be a day, YYYY-MM-DD; got "2026-02". For the month 2026-02 use 2026-02-28']);
    expect(checkArguments(tool, { q: "x", from: "1.9.2026" })).toEqual(['from must be a day, YYYY-MM-DD; got "1.9.2026", which is 2026-09-01']);
    expect(checkArguments(tool, { q: "x", from: "letzter Monat" })).toEqual(['from must be a day, YYYY-MM-DD; got "letzter Monat"']);
  });

  it("collects every problem of a call", () => {
    expect(checkArguments(tool, { direction: "both", frm: "2025-01-01" })).toEqual([
      "unknown argument frm; did you mean from?",
      "q is required",
      'direction must be one of out, in; got "both"',
    ]);
  });

  it("writes the error the model reads", () => {
    expect(argumentError("list_transactions", ["q is required", 'direction must be one of out, in; got "both"']))
      .toBe('error: list_transactions was not run: q is required; direction must be one of out, in; got "both". Call list_transactions again with the corrected arguments.');
  });

  it("suggests a name only when it is close", () => {
    expect(nearestName("date_from", ["from", "to", "q"])).toBe("from");
    expect(nearestName("limit", ["from", "to", "q"])).toBeUndefined();
    expect(nearestName("x", [])).toBeUndefined();
  });
});

describe("dependentRequired: an argument another one needs (rank_by and its order)", () => {
  const ranked = { parameters: {
    ...SCHEMA,
    properties: {
      ...SCHEMA.properties,
      rank_by: { type: "string", enum: ["amount", "booking_date"] },
      order: { type: "string", enum: ["desc", "asc"], description: "desc = highest first; asc = lowest first" },
    },
    dependentRequired: { rank_by: ["order"] },
  } as JsonSchema };

  it("refuses rank_by without the order and names the values and what they mean", () => {
    expect(checkArguments(ranked, { q: "x", rank_by: "amount" })).toEqual([
      "order is required with rank_by — one of desc, asc (desc = highest first; asc = lowest first)",
    ]);
    expect(checkArguments(ranked, { q: "x", rank_by: "amount", order: "" })).toContain("order is required with rank_by — one of desc, asc (desc = highest first; asc = lowest first)");
  });

  it("lets the call through with the order, or without rank_by", () => {
    expect(checkArguments(ranked, { q: "x", rank_by: "amount", order: "asc" })).toEqual([]);
    expect(checkArguments(ranked, { q: "x", order: "asc" })).toEqual([]);
    expect(checkArguments(ranked, { q: "x" })).toEqual([]);
  });
});
