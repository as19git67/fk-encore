import { describe, it, expect } from "vitest";
import { retentionFor, retainUntilYear } from "./retention";

describe("retentionFor", () => {
  it("keeps lifelong records permanently (by category)", () => {
    expect(retentionFor({ categorySlug: "familie-urkunden", documentType: "urkunde", taxRelevant: false }).cls)
      .toBe("dauerhaft");
    expect(retentionFor({ categorySlug: "rechtliches-nachlass", documentType: "bescheid", taxRelevant: false }).cls)
      .toBe("dauerhaft");
  });

  it("keeps lifelong records permanently (by document type, any category)", () => {
    expect(retentionFor({ categorySlug: "finanzen-rechnungen", documentType: "ausweis", taxRelevant: false }).cls)
      .toBe("dauerhaft");
    expect(retentionFor({ categorySlug: "sonstiges", documentType: "vollmacht", taxRelevant: false }).cls)
      .toBe("dauerhaft");
  });

  it("permanent wins over tax relevance", () => {
    // A pension notice is permanent even though it may be tax-relevant.
    expect(retentionFor({ categorySlug: "altersvorsorge-gesetzlich", documentType: "bescheid", taxRelevant: true }).cls)
      .toBe("dauerhaft");
  });

  it("assigns ~10 years to tax-relevant papers", () => {
    const a = retentionFor({ categorySlug: "finanzen-rechnungen", documentType: "rechnung", taxRelevant: true });
    expect(a.cls).toBe("steuer_10");
    expect(a.years).toBe(10);
    // Tax categories are tax-relevant even without the flag.
    expect(retentionFor({ categorySlug: "behoerden-steuerbescheid", documentType: "bescheid", taxRelevant: false }).cls)
      .toBe("steuer_10");
  });

  it("keeps contracts until the contract ends", () => {
    const r = retentionFor({ categorySlug: "vertraege-strom", documentType: "vertrag", taxRelevant: false });
    expect(r.cls).toBe("bis_ende");
    expect(r.years).toBeNull();
  });

  it("keeps purchases until warranty/guarantee ends", () => {
    const r = retentionFor({ categorySlug: "anschaffungen", documentType: "beleg", taxRelevant: false });
    expect(r.cls).toBe("bis_ende");
    expect(r.label).toMatch(/Garantie/);
  });

  it("marks short-lived paperwork as discardable", () => {
    expect(retentionFor({ categorySlug: "altersvorsorge-lebensversicherung", documentType: "standmitteilung", taxRelevant: false }).cls)
      .toBe("kurz");
    expect(retentionFor({ categorySlug: "behoerden-mitteilungen", documentType: "mitteilung", taxRelevant: false }).cls)
      .toBe("kurz");
  });

  it("falls back to 'unbekannt' when no rule matches", () => {
    expect(retentionFor({ categorySlug: null, documentType: null, taxRelevant: false }).cls).toBe("unbekannt");
    expect(retentionFor({ categorySlug: "sonstiges", documentType: "bericht", taxRelevant: false }).cls).toBe("unbekannt");
  });
});

describe("retainUntilYear", () => {
  const taxInfo = retentionFor({ categorySlug: "finanzen-steuern", documentType: "bescheid", taxRelevant: true });

  it("adds the retention years to the tax year when present", () => {
    expect(retainUntilYear(taxInfo, { taxYear: 2024, docDate: "2025-06-01" })).toBe(2034);
  });

  it("falls back to the document-date year when no tax year", () => {
    expect(retainUntilYear(taxInfo, { taxYear: null, docDate: "2023-03-15" })).toBe(2033);
  });

  it("returns null when the class is not year-based", () => {
    const perm = retentionFor({ categorySlug: "familie-urkunden", documentType: "urkunde", taxRelevant: false });
    expect(retainUntilYear(perm, { taxYear: 2024, docDate: "2024-01-01" })).toBeNull();
  });

  it("returns null when no reference year is available", () => {
    expect(retainUntilYear(taxInfo, { taxYear: null, docDate: null })).toBeNull();
    expect(retainUntilYear(taxInfo, { taxYear: null, docDate: "kein-datum" })).toBeNull();
  });
});
