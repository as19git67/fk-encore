import { describe, it, expect } from "vitest";

import { isValidTaxSectionSlug, orderTaxSectionSlugs, TAX_SECTIONS } from "./tax-sections";

describe("isValidTaxSectionSlug", () => {
  it("accepts every slug from TAX_SECTIONS", () => {
    for (const s of TAX_SECTIONS) {
      expect(isValidTaxSectionSlug(s.slug)).toBe(true);
    }
  });

  it("rejects unknown or malformed input", () => {
    expect(isValidTaxSectionSlug("not-a-real-slug")).toBe(false);
    expect(isValidTaxSectionSlug("")).toBe(false);
    expect(isValidTaxSectionSlug(42 as unknown)).toBe(false);
    expect(isValidTaxSectionSlug(null as unknown)).toBe(false);
  });
});

describe("orderTaxSectionSlugs", () => {
  it("returns the canonical group order (einkuenfte → abzuege → bescheid → rahmen)", () => {
    const ordered = orderTaxSectionSlugs([
      "mantelbogen",
      "aussergewoehnliche",
      "anlage-n",
      "steuerbescheid",
    ]);
    expect(ordered.map((s) => s.slug)).toEqual([
      "anlage-n",
      "aussergewoehnliche",
      "steuerbescheid",
      "mantelbogen",
    ]);
  });

  it("keeps declaration order inside a group", () => {
    // Both belong to `einkuenfte`; anlage-n comes before anlage-kap in TAX_SECTIONS.
    const ordered = orderTaxSectionSlugs(["anlage-kap", "anlage-n"]);
    expect(ordered.map((s) => s.slug)).toEqual(["anlage-n", "anlage-kap"]);
  });

  it("filters unknown slugs silently", () => {
    const ordered = orderTaxSectionSlugs(["anlage-n", "definitely-not-a-slug"]);
    expect(ordered.map((s) => s.slug)).toEqual(["anlage-n"]);
  });

  it("de-duplicates case-insensitively", () => {
    const ordered = orderTaxSectionSlugs(["anlage-n", "ANLAGE-N", " anlage-n "]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].slug).toBe("anlage-n");
  });

  it("returns [] for empty input", () => {
    expect(orderTaxSectionSlugs([])).toEqual([]);
  });

  it("tolerates non-string garbage", () => {
    const ordered = orderTaxSectionSlugs([
      "anlage-n",
      42 as unknown as string,
      null as unknown as string,
      undefined as unknown as string,
    ]);
    expect(ordered.map((s) => s.slug)).toEqual(["anlage-n"]);
  });
});
