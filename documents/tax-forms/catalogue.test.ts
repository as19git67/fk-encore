import { describe, expect, it } from "vitest";
import { TAX_SECTIONS } from "../tax-sections";
import { EVIDENCE_KINDS } from "../tax-evidence-kinds";
import { CATALOGUE_YEARS, findFormField, formCatalogue, kennzahlFor, placeLabel } from "./catalogue";

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
    expect(later.fields.every((f) => f.kennzahl === null && f.line === null && f.kennzahlSpouse === null && f.formNote === null && f.source === null)).toBe(true);
    expect(formCatalogue(2025).exact).toBe(true);
  });

  it("gives a spouse's Kennzahl and a form note only together with their source", () => {
    for (const year of CATALOGUE_YEARS) {
      for (const f of formCatalogue(year).fields) {
        if (f.kennzahlSpouse !== null) expect(f.kennzahl, `${f.key}: Person B without Person A`).not.toBeNull();
        if (f.kennzahlSpouse !== null || f.formNote !== null) expect(f.source, `${f.key} without its source`).not.toBeNull();
        if (f.kennzahl !== null) expect(f.kennzahl, f.key).toMatch(/^\d{2,3}$/);
      }
    }
  });
});

describe("catalogue 2025", () => {
  const fields = formCatalogue(2025).fields;
  const kz = (key: string) => findFormField(2025, key)!;

  it("names the Vordruck every field was checked against", () => {
    for (const f of fields) expect(f.source, f.key).toMatch(/^Anlage .+ 2025, Vordruck \d{6}[a-z]?_25, FMS-Ausgabe 2025\/4\.1\.1\.0/);
  });

  // Pinned as read off the official 2025 Vordrucke: a change here is a change of the form, not of the code.
  it.each([
    ["n.bruttoarbeitslohn", 5, "110", null],
    ["n.lohnsteuer", 6, "140", null],
    ["werbungskosten.fortbildung", 60, "330", null],
    ["vorsorge.rv_arbeitnehmer", 4, "300", "400"],
    ["vorsorge.kv_arbeitnehmer", 11, "320", "420"],
    ["vorsorge.av_arbeitnehmer", 43, "370", "470"],
    ["kap.ertraege", 7, "410", null],
    ["kap.kapitalertragsteuer", 37, "480", null],
    ["r.rente_jahresbetrag", 4, "101", null],
    ["sonder.spenden", 5, "123", null],
    ["haushaltsnahe.handwerker", 9, "214", null],
    ["agb.krankheitskosten", 24, "302", null],
    ["kind.betreuungskosten", 67, "51", null],
  ])("%s: Zeile %i, Kz %s (Person B %s)", (key, line, kennzahl, spouse) => {
    expect(kz(key)).toMatchObject({ line, kennzahl, kennzahlSpouse: spouse });
  });

  it("keeps Kennzahlen apart within a Vordruck", () => {
    const seen = new Map<string, string>();
    for (const f of fields) {
      for (const k of [f.kennzahl, f.kennzahlSpouse]) {
        if (k === null) continue;
        const id = `${f.source}|${k}`;
        // Kirchensteuer gezahlt/erstattet share a line, never a Kennzahl.
        expect(seen.get(id), `${f.key} and ${seen.get(id)} share Kz ${k}`).toBeUndefined();
        seen.set(id, f.key);
      }
    }
  });

  it("leaves the Kennzahl open where the form has none or the evidence cannot say which", () => {
    expect(kz("v.mieteinnahmen")).toMatchObject({ line: 13, kennzahl: null });
    expect(kz("vorsorge.kv_wahlleistungen")).toMatchObject({ line: null, kennzahl: null });
    expect(kz("vorsorge.kv_wahlleistungen").formNote).toContain("Zeile 22");
    expect(kz("av.altersvorsorgebeitraege").formNote).toContain("Anbieter");
  });

  it("fills the Anlage Sonderausgaben once per return", () => {
    expect(kz("sonder.kirchensteuer_gezahlt").scope).toBe("return");
    expect(kz("sonder.kirchensteuer_erstattet").scope).toBe("return");
  });

  it("says where a value goes, per owner", () => {
    expect(kennzahlFor(kz("vorsorge.pv_arbeitnehmer"), "spouse")).toBe("423");
    expect(kennzahlFor(kz("n.kirchensteuer"), "spouse")).toBe("142");
    expect(placeLabel(kz("vorsorge.pv_arbeitnehmer"), "self")).toBe("Zeile 13 · Kz 323");
    expect(placeLabel(kz("v.umlagen"), "property:1")).toBe("Zeile 20 (ohne Kennzahl)");
    expect(placeLabel(kz("vorsorge.kv_erstattungen"), "self")).toBe("siehe Hinweis zum Vordruck");
    expect(placeLabel(findFormField(2099, "n.bruttoarbeitslohn")!, "self")).toBe("Kennzahl prüfen");
  });
});
