import { describe, expect, it } from "vitest";

import { dedupeSnapshotRows, identityFromPairs } from "./security-identity";

// Synthetic identifiers with valid check digits.
const ISIN_A = "DE0000000017";
const ISIN_LU = "LU0000000017";
const ISIN_OCR = "DE000A1B5C16";

describe("identityFromPairs", () => {
  it("completes a row that carries only the WKN or only the ISIN", () => {
    const id = identityFromPairs([{ isin: ISIN_LU, wkn: "999001" }]);
    expect(id.complete({ isin: null, wkn: "999001", name: "Fonds" })).toEqual({ isin: ISIN_LU, wkn: "999001", name: "Fonds" });
    expect(id.complete({ isin: ISIN_LU, wkn: null })).toEqual({ isin: ISIN_LU, wkn: "999001" });
    expect(id.key({ isin: null, wkn: "999001", name: "Fonds" })).toBe(ISIN_LU);
    expect(id.wknsOf(ISIN_LU)).toEqual(["999001"]);
  });

  it("leaves a WKN known with two ISINs alone, and ignores a misread ISIN", () => {
    const id = identityFromPairs([
      { isin: ISIN_LU, wkn: "999001" },
      { isin: ISIN_A, wkn: "999001" },
      // Check digit wrong: never taught.
      { isin: "LU0000000018", wkn: "999002" },
    ]);
    expect(id.complete({ isin: null, wkn: "999001" })).toEqual({ isin: null, wkn: "999001" });
    expect(id.complete({ isin: null, wkn: "999002" })).toEqual({ isin: null, wkn: "999002" });
    expect(id.complete({ isin: ISIN_LU, wkn: null })).toEqual({ isin: ISIN_LU, wkn: null });
  });

  it("finds the known WKN behind one OCR read with L for 1 and S for 5", () => {
    const id = identityFromPairs([{ isin: ISIN_OCR, wkn: "A1B5C1" }]);
    expect(id.complete({ isin: null, wkn: "ALBSC1" })).toEqual({ isin: ISIN_OCR, wkn: "A1B5C1" });
    // The ISIN misread the same way is repaired too, and then completes nothing wrong.
    expect(id.complete({ isin: "DE000ALBSC16", wkn: null }).wkn).toBeDefined();
    // A WKN known as it stands is never folded, and a valid ISIN of another security wins.
    const two = identityFromPairs([{ isin: ISIN_OCR, wkn: "A1B5C1" }, { isin: ISIN_LU, wkn: "ALB5C1" }]);
    expect(two.complete({ isin: null, wkn: "ALB5C1" })).toEqual({ isin: ISIN_LU, wkn: "ALB5C1" });
    expect(id.complete({ isin: ISIN_LU, wkn: "ALBSC1" })).toEqual({ isin: ISIN_LU, wkn: "ALBSC1" });
  });
});

describe("dedupeSnapshotRows", () => {
  it("keeps one row per depot, day and security — the bank's", () => {
    const rows = [
      { account_id: 1, as_of: "2026-06-30 00:00:00", isin: ISIN_LU, wkn: "999001", name: "Fonds", source: "document", amount: "5" },
      { account_id: 1, as_of: "2026-06-30 00:00:00", isin: ISIN_LU, wkn: "999001", name: null, source: "bank", amount: "5" },
      { account_id: 2, as_of: "2026-06-30 00:00:00", isin: ISIN_LU, wkn: "999001", name: null, source: "document", amount: "1" },
    ];
    expect(dedupeSnapshotRows(rows).map((r) => [r.account_id, r.source])).toEqual([[1, "bank"], [2, "document"]]);
  });
});
