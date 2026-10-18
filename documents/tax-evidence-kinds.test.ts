import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPES } from "./document-types";
import { TAX_SECTIONS } from "./tax-sections";
import { checkEvidenceValues, EVIDENCE_KINDS, evidenceKindsFor, findEvidenceKind } from "./tax-evidence-kinds";

describe("evidence kinds", () => {
  it("are consistent: unique keys, known sections and document types, unique fields", () => {
    const sections = new Set<string>(TAX_SECTIONS.map((s) => s.slug));
    const types = new Set<string>(DOCUMENT_TYPES.map((t) => t.slug));
    expect(new Set(EVIDENCE_KINDS.map((k) => k.key)).size).toBe(EVIDENCE_KINDS.length);
    for (const k of EVIDENCE_KINDS) {
      for (const s of k.sections) expect(sections.has(s), `${k.key}: ${s}`).toBe(true);
      for (const t of k.documentTypes) expect(types.has(t), `${k.key}: ${t}`).toBe(true);
      expect(new Set(k.fields.map((f) => f.key)).size, k.key).toBe(k.fields.length);
    }
  });

  it("offers the kinds that fit a document's sections and type", () => {
    expect(evidenceKindsFor(["anlage-kap"], "bescheinigung").map((k) => k.key)).toEqual(["jahressteuerbescheinigung"]);
    // An Erträgnisaufstellung (abrechnung) is no evidence kind of KAP.
    expect(evidenceKindsFor(["anlage-kap"], "abrechnung")).toEqual([]);
    expect(evidenceKindsFor(["haushaltsnahe"], "rechnung").map((k) => k.key)).toEqual(["handwerkerrechnung", "dienstleistungsrechnung"]);
    expect(evidenceKindsFor(["anlage-n", "vorsorgeaufwand"], "bescheinigung").map((k) => k.key))
      .toEqual(["lohnsteuerbescheinigung", "beitragsbescheinigung_kv", "basisrente_bescheinigung"]);
  });

  it("rejects values that cannot all be right", () => {
    const lstb = findEvidenceKind("lohnsteuerbescheinigung")!;
    expect(checkEvidenceValues(lstb, { bruttoarbeitslohn: 4820000, lohnsteuer: 795040, solidaritaetszuschlag: 0, kirchensteuer: 63600 })).toEqual([]);
    // Lohnsteuer and Brutto swapped by the reader.
    expect(checkEvidenceValues(lstb, { bruttoarbeitslohn: 795040, lohnsteuer: 4820000 })).toEqual(["Lohnsteuer über der Hälfte des Bruttoarbeitslohns"]);
    const bank = findEvidenceKind("jahressteuerbescheinigung")!;
    expect(checkEvidenceValues(bank, { ertraege: 120000, kapitalertragsteuer: 5000, solidaritaetszuschlag: 275 })).toEqual([]);
    expect(checkEvidenceValues(bank, { sparer_pauschbetrag: 300000 })).toEqual(["Sparer-Pauschbetrag über 2.000 €"]);
    const handwerker = findEvidenceKind("handwerkerrechnung")!;
    expect(checkEvidenceValues(handwerker, { arbeitskosten: 90000, rechnungsbetrag: 60000 })).toEqual(["Arbeitskosten über dem Rechnungsbetrag"]);
  });
});
