import { describe, it, expect } from "vitest";

import { householdTaxFacts, isEvidenceFor, resolveTaxRole, roleFromLegacy } from "./tax-role";
import { DOCUMENT_TYPES } from "./document-types";
import { TAX_EVIDENCE, TAX_SECTIONS, taxRelevantFromRole } from "./tax-sections";

const KAP = [{ slug: "anlage-kap", confidence: 0.9 }];
const KIND = [{ slug: "anlage-kind", confidence: 0.9 }];

describe("TAX_EVIDENCE matrix", () => {
  it("has a row for every section and only known document types", () => {
    const types = new Set(DOCUMENT_TYPES.map((t) => t.slug));
    for (const s of TAX_SECTIONS) {
      const entries = TAX_EVIDENCE[s.slug];
      expect(entries, s.slug).toBeDefined();
      expect(entries.length, s.slug).toBeGreaterThan(0);
      for (const e of entries) {
        expect(types.has(typeof e === "string" ? e : e.type), s.slug).toBe(true);
      }
    }
  });

  it("never lists the catch-all types as evidence", () => {
    for (const [slug, entries] of Object.entries(TAX_EVIDENCE)) {
      for (const e of entries) {
        const type = typeof e === "string" ? e : e.type;
        expect(["sonstiges", "korrespondenz", "anleitung", "angebot", "rezept"], slug).not.toContain(type);
      }
    }
  });
});

describe("resolveTaxRole", () => {
  it("is keine without sections, whatever the model said", () => {
    const out = resolveTaxRole({ role: "beleg", taxSections: [], documentType: "bescheinigung" });
    expect(out).toEqual({ role: "keine", taxSections: [], downgraded: false });
  });

  it("turns keine with sections into bezug and keeps the sections", () => {
    const out = resolveTaxRole({ role: "keine", taxSections: KAP, documentType: null });
    expect(out.role).toBe("bezug");
    expect(out.taxSections).toEqual(KAP);
  });

  it("keeps the Jahressteuerbescheinigung (bescheinigung) as beleg for Anlage KAP", () => {
    const out = resolveTaxRole({ role: "beleg", taxSections: KAP, documentType: "bescheinigung" });
    expect(out.role).toBe("beleg");
    expect(out.downgraded).toBe(false);
  });

  it("downgrades the Erträgnisaufstellung (abrechnung) and a dividend credit (gutschrift) to bezug", () => {
    for (const type of ["abrechnung", "gutschrift"]) {
      const out = resolveTaxRole({ role: "beleg", taxSections: KAP, documentType: type });
      expect(out.role, type).toBe("bezug");
      expect(out.downgraded, type).toBe(true);
      expect(out.taxSections, type).toEqual(KAP);
    }
  });

  it("downgrades a school report (urkunde) for Anlage Kind", () => {
    const out = resolveTaxRole({ role: "beleg", taxSections: KIND, documentType: "urkunde" });
    expect(out.role).toBe("bezug");
  });

  it("accepts a school certificate for Anlage Kind only with an adult child", () => {
    const minor = resolveTaxRole({
      role: "beleg",
      taxSections: KIND,
      documentType: "bescheinigung",
      facts: { adultChild: false },
    });
    expect(minor.role).toBe("bezug");
    const adult = resolveTaxRole({
      role: "beleg",
      taxSections: KIND,
      documentType: "bescheinigung",
      facts: { adultChild: true },
    });
    expect(adult.role).toBe("beleg");
  });

  it("keeps the Kindergeldbescheid as beleg", () => {
    expect(resolveTaxRole({ role: "beleg", taxSections: KIND, documentType: "bescheid" }).role).toBe("beleg");
  });

  it("leaves a beleg alone when the document type is unknown", () => {
    expect(resolveTaxRole({ role: "beleg", taxSections: KAP, documentType: null }).role).toBe("beleg");
    expect(resolveTaxRole({ role: "beleg", taxSections: KAP, documentType: "nonsense" }).role).toBe("beleg");
  });

  it("keeps beleg when any assigned section accepts the type", () => {
    const out = resolveTaxRole({
      role: "beleg",
      taxSections: [...KAP, { slug: "werbungskosten-kap", confidence: 0.5 }],
      documentType: "rechnung",
    });
    expect(out.role).toBe("beleg");
  });

  it("never upgrades a bezug", () => {
    expect(resolveTaxRole({ role: "bezug", taxSections: KAP, documentType: "bescheinigung" }).role).toBe("bezug");
  });

  it("drops invalid section slugs before deciding", () => {
    const out = resolveTaxRole({
      role: "beleg",
      taxSections: [{ slug: "made-up", confidence: 0.9 }],
      documentType: "bescheinigung",
    });
    expect(out.role).toBe("keine");
  });
});

describe("isEvidenceFor", () => {
  it("answers the monthly payslip question for Anlage N", () => {
    expect(isEvidenceFor("anlage-n", "bescheinigung")).toBe(true);
    expect(isEvidenceFor("anlage-n", "abrechnung")).toBe(false);
  });
});

describe("roleFromLegacy / taxRelevantFromRole", () => {
  it("maps the old boolean both ways", () => {
    expect(roleFromLegacy(true, [])).toBe("beleg");
    expect(roleFromLegacy(false, KAP)).toBe("bezug");
    expect(roleFromLegacy(false, [])).toBe("keine");
    expect(taxRelevantFromRole("beleg")).toBe(true);
    expect(taxRelevantFromRole("bezug")).toBe(false);
    expect(taxRelevantFromRole("keine")).toBe(false);
  });
});

describe("householdTaxFacts", () => {
  it("sees an adult child by the tax year, not by today", () => {
    const child = { relation_kind: "child", birth_date: "2007-05-01" };
    expect(householdTaxFacts([child], 2024).adultChild).toBe(false);
    expect(householdTaxFacts([child], 2025).adultChild).toBe(true);
    expect(householdTaxFacts([child], null, new Date("2030-01-01")).adultChild).toBe(true);
  });

  it("ignores other relations and children without a birth date", () => {
    expect(householdTaxFacts([{ relation_kind: "parent", birth_date: "1950-01-01" }], 2024).adultChild).toBe(false);
    expect(householdTaxFacts([{ relation_kind: "child", birth_date: null }], 2024).adultChild).toBe(false);
    expect(householdTaxFacts([], 2024).adultChild).toBe(false);
  });
});
