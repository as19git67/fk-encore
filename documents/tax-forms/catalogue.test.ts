import { describe, expect, it } from "vitest";
import { TAX_SECTIONS } from "../tax-sections";
import { EVIDENCE_KINDS } from "../tax-evidence-kinds";
import { CATALOGUE_YEARS, findFormField, formCatalogue } from "./catalogue";

describe("form catalogue", () => {
  it("has unique keys in known sections, every year", () => {
    const sections = new Set<string>(TAX_SECTIONS.map((s) => s.slug));
    for (const year of CATALOGUE_YEARS) {
      const { fields } = formCatalogue(year);
      expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
      for (const f of fields) expect(sections.has(f.anlage), `${f.key} in ${f.anlage}`).toBe(true);
    }
  });

  it("feeds every evidence field into a field of every catalogue", () => {
    for (const year of CATALOGUE_YEARS) {
      for (const kind of EVIDENCE_KINDS) {
        for (const field of kind.fields) {
          if (field.formKey) expect(findFormField(year, field.formKey), `${kind.key}.${field.key} → ${field.formKey}`).toBeDefined();
        }
      }
      // The party-donation redirect has a field of its own.
      expect(findFormField(year, "sonder.spenden_parteien")).toBeDefined();
    }
  });

  it("never states a Kennzahl that was not checked against the form", () => {
    for (const year of CATALOGUE_YEARS) {
      for (const f of formCatalogue(year).fields) {
        if (f.kennzahl !== null || f.line !== null) expect(f.source, `${f.key} has a Kennzahl without its source`).not.toBeNull();
      }
    }
  });

  it("uses the newest older catalogue for a year without one, with lines and Kennzahlen cleared", () => {
    const later = formCatalogue(2099);
    expect(later.exact).toBe(false);
    expect(later.year).toBe(CATALOGUE_YEARS[0]);
    expect(later.fields.every((f) => f.kennzahl === null && f.line === null)).toBe(true);
    expect(formCatalogue(2025).exact).toBe(true);
  });
});
