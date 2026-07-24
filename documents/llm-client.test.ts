import { describe, it, expect } from "vitest";

import { parseClassification } from "./llm-client";

function baseRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category_slug: "finanzen",
    title: "Stromrechnung 03/2026",
    doc_date: "2026-03-15",
    sender: "Stadtwerke",
    summary: "Monatsabrechnung Strom.",
    tags: ["strom", "rechnung"],
    confidence: 0.87,
    ...extra,
  };
}

describe("parseClassification (base fields)", () => {
  it("parses a minimal non-tax payload", () => {
    const c = parseClassification(baseRaw());
    expect(c.category_slug).toBe("finanzen");
    expect(c.tags).toEqual(["strom", "rechnung"]);
    expect(c.tax_relevant).toBe(false);
    expect(c.tax_year).toBeNull();
    expect(c.tax_sections).toEqual([]);
  });

  it("parses document_number when present", () => {
    const c = parseClassification(baseRaw({ document_number: "2661160" }));
    expect(c.document_number).toBe("2661160");
  });

  it("treats empty/missing document_number as null", () => {
    expect(parseClassification(baseRaw()).document_number).toBeNull();
    expect(parseClassification(baseRaw({ document_number: "" })).document_number).toBeNull();
    expect(parseClassification(baseRaw({ document_number: "  " })).document_number).toBeNull();
  });

  it("rejects a payload without category_slug", () => {
    expect(() => parseClassification(baseRaw({ category_slug: "" }))).toThrow(/category_slug/);
  });

  it("clamps confidence into [0, 1]", () => {
    expect(parseClassification(baseRaw({ confidence: 1.5 })).confidence).toBe(1);
    expect(parseClassification(baseRaw({ confidence: -0.3 })).confidence).toBe(0);
    expect(parseClassification(baseRaw({ confidence: "nope" })).confidence).toBe(0);
  });
});

describe("parseClassification (document type)", () => {
  it("defaults to null when no type was returned", () => {
    const c = parseClassification(baseRaw());
    expect(c.document_type).toBeNull();
    expect(c.document_type_confidence).toBe(0);
  });

  it("accepts a valid slug and clamps its confidence", () => {
    const c = parseClassification(
      baseRaw({ document_type: "rechnung", document_type_confidence: 0.8 }),
    );
    expect(c.document_type).toBe("rechnung");
    expect(c.document_type_confidence).toBe(0.8);
  });

  it("normalises case/whitespace before validating", () => {
    const c = parseClassification(baseRaw({ document_type: "  Rechnung  " }));
    expect(c.document_type).toBe("rechnung");
  });

  it("drops an invalid slug to null (no forced fallback)", () => {
    const c = parseClassification(
      baseRaw({ document_type: "erfundene-art", document_type_confidence: 0.9 }),
    );
    expect(c.document_type).toBeNull();
    expect(c.document_type_confidence).toBe(0);
  });
});

describe("parseClassification (tax fields)", () => {
  it("accepts a well-formed tax payload", () => {
    const c = parseClassification(
      baseRaw({
        tax_relevant: true,
        tax_year: 2025,
        tax_year_confidence: 0.9,
        tax_sections: [
          { slug: "anlage-n", confidence: 0.92 },
          { slug: "werbungskosten-n", confidence: 0.6 },
        ],
      }),
    );
    expect(c.tax_relevant).toBe(true);
    expect(c.tax_year).toBe(2025);
    expect(c.tax_year_confidence).toBe(0.9);
    expect(c.tax_sections.map((s) => s.slug)).toEqual(["anlage-n", "werbungskosten-n"]);
  });

  it("sorts tax_sections by confidence descending", () => {
    const c = parseClassification(
      baseRaw({
        tax_relevant: true,
        tax_year: 2025,
        tax_sections: [
          { slug: "anlage-n", confidence: 0.5 },
          { slug: "werbungskosten-n", confidence: 0.8 },
        ],
      }),
    );
    expect(c.tax_sections[0].slug).toBe("werbungskosten-n");
    expect(c.tax_sections[1].slug).toBe("anlage-n");
  });

  it("drops invalid slugs silently", () => {
    const c = parseClassification(
      baseRaw({
        tax_relevant: true,
        tax_year: 2025,
        tax_sections: [
          { slug: "anlage-n", confidence: 0.9 },
          { slug: "made-up-section", confidence: 0.7 },
          { slug: "ANLAGE-N", confidence: 0.6 }, // case-normalised → duplicate
        ],
      }),
    );
    expect(c.tax_sections).toHaveLength(1);
    expect(c.tax_sections[0].slug).toBe("anlage-n");
    // De-dup keeps the higher confidence.
    expect(c.tax_sections[0].confidence).toBe(0.9);
  });

  it("clamps tax_year to the 2000..2100 window", () => {
    expect(parseClassification(baseRaw({ tax_year: 42, tax_relevant: true, tax_sections: [{ slug: "anlage-n", confidence: 0.9 }] })).tax_year).toBeNull();
    expect(parseClassification(baseRaw({ tax_year: 3000, tax_relevant: true, tax_sections: [{ slug: "anlage-n", confidence: 0.9 }] })).tax_year).toBeNull();
    expect(parseClassification(baseRaw({ tax_year: 2024.5, tax_relevant: true, tax_sections: [{ slug: "anlage-n", confidence: 0.9 }] })).tax_year).toBeNull();
  });

  it("forces tax_relevant=false when no valid sections remain", () => {
    const c = parseClassification(
      baseRaw({
        tax_relevant: true,
        tax_year: 2025,
        tax_year_confidence: 0.9,
        tax_sections: [{ slug: "definitely-not-a-slug", confidence: 0.8 }],
      }),
    );
    expect(c.tax_relevant).toBe(false);
    expect(c.tax_year).toBeNull();
    expect(c.tax_year_confidence).toBe(0);
    expect(c.tax_sections).toEqual([]);
  });

  it("treats missing tax fields as 'not tax-relevant'", () => {
    const c = parseClassification(baseRaw()); // no tax_* keys at all
    expect(c.tax_relevant).toBe(false);
    expect(c.tax_year).toBeNull();
    expect(c.tax_year_confidence).toBe(0);
    expect(c.tax_sections).toEqual([]);
  });

  it("ignores zero-confidence section entries", () => {
    const c = parseClassification(
      baseRaw({
        tax_relevant: true,
        tax_year: 2025,
        tax_sections: [{ slug: "anlage-n", confidence: 0 }],
      }),
    );
    expect(c.tax_sections).toEqual([]);
    expect(c.tax_relevant).toBe(false); // no surviving section ⇒ not relevant
  });
});
