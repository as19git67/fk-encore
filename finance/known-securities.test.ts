import { describe, expect, it } from "vitest";

import { EMPTY_SETTLEMENT, mergeSettlement, type SettlementValues } from "./depot-settlement-merge";
import { knownFromRows, ocrVariantOf, plainName, snapToKnown } from "./known-securities";

// Synthetic identifiers with valid check digits: the WKN A1B2C3 gives DE000A1B2C35.
const ISIN = "DE000A1B2C35";
const OTHER = "DE0000000017";

const known = knownFromRows([
  { isin: ISIN, wkn: "A1B2C3", name: "Beispiél Telekom Hldg AG" },
  { isin: ISIN, wkn: null, name: "BEISPIEL TELEKOM NA" },
  { isin: OTHER, wkn: null, name: "Muster Fonds" },
]);

const reading = (over: Partial<SettlementValues>) =>
  mergeSettlement({ ...EMPTY_SETTLEMENT, kind: "sell", executedAt: "2026-03-02", ...over }, null, new Date("2026-04-01"));

describe("ocrVariantOf", () => {
  it("accepts only OCR's confusions, and only a few of them", () => {
    expect(ocrVariantOf("DEOQOA1B2C35", ISIN)).toBe(true);
    expect(ocrVariantOf("DE000A1B2C3S", ISIN)).toBe(true);
    expect(ocrVariantOf("DE000A1B2C36", ISIN)).toBe(false);
    expect(ocrVariantOf("DEOOOAIB2C3S", ISIN)).toBe(false);
  });
});

describe("snapToKnown", () => {
  it("snaps an unknown ISIN to the one known security it is a misreading of", () => {
    const r = snapToKnown(reading({ isin: "DE000AIB2C35" }), known);
    expect(r.values.isin).toBe(ISIN);
    expect(r.values.wkn).toBe("A1B2C3");
    expect(r.fields.find((f) => f.field === "isin")?.known_from).toBe("DE000AIB2C35");
    expect(r.checks.find((c) => c.name === "isin_checksum")?.result).toBe("ok");
  });

  it("takes the known spelling of the same name, and a name where none was read", () => {
    expect(snapToKnown(reading({ isin: ISIN, name: "Beispiël Telekom Hldg AG" }), known).values.name).toBe("Beispiél Telekom Hldg AG");
    expect(snapToKnown(reading({ isin: OTHER, name: null }), known).values.name).toBe("Muster Fonds");
    // Another name stays: the paper may name it differently on purpose.
    expect(snapToKnown(reading({ isin: ISIN, name: "Beispiel Telekom Namensaktien" }), known).values.name).toBe("Beispiel Telekom Namensaktien");
  });

  it("leaves a first buy, a known ISIN and an ambiguous slip alone", () => {
    expect(snapToKnown(reading({ isin: "US0000000000" }), known).values.isin).toBe("US0000000000");
    const exact = snapToKnown(reading({ isin: ISIN, name: "BEISPIÉL TELEKOM HLDG AG" }), known);
    expect(exact.values).toMatchObject({ isin: ISIN, wkn: "A1B2C3", name: "BEISPIÉL TELEKOM HLDG AG" });
    expect(exact.fields.some((f) => f.known_from)).toBe(false);
    // Two known ISINs a Q could stand for: no guess.
    const twins = knownFromRows([{ isin: ISIN, wkn: null, name: null }, { isin: "DE00DA1B2C35", wkn: null, name: null }]);
    expect(snapToKnown(reading({ isin: "DE00QA1B2C35" }), twins).values.isin).toBe("DE00QA1B2C35");
  });

  it("compares names without accents and case", () => {
    expect(plainName("Telefönica  AG")).toBe(plainName("TELEFÓNICA AG"));
  });
});
