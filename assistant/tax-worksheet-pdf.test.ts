/**
 * The worksheet PDF by Kennzahl (steuer-ausfuellhilfe, stage 4): rows in
 * the order of the form, sums pointing to an appendix that names every
 * document, and what is left to check. Synthetic values only.
 */

import { describe, expect, it } from "vitest";
import type { TaxWorksheet, WorksheetForm } from "./tax-worksheet";
import { kennzahlSheet, renderTaxWorksheetPdf } from "./tax-worksheet-pdf";

type FormValue = WorksheetForm["values"][number];
type Contribution = FormValue["contributions"][number];

const contribution = (id: number, title: string, cents: number, status: Contribution["status"] = "read", valueCents = cents): Contribution => ({
  value_id: id, document_id: id, document_title: title, evidence_kind: "lohnsteuerbescheinigung", evidence_kind_name: "Lohnsteuerbescheinigung",
  field_label: "Bruttoarbeitslohn", cents, value_cents: valueCents, printed: null, quote: null, page: null, status, note: null,
});

const value = (over: Partial<FormValue>): FormValue => ({
  key: "n.bruttoarbeitslohn", anlage: "anlage-n", anlage_name: "Anlage N", label: "Bruttoarbeitslohn",
  owner: "self", owner_label: "Person A (Sie)", line: 5, kennzahl: "110", place: "Zeile 5 · Kz 110", checked: true,
  source: "Anlage N 2025", form_note: null, prefilled: false, cents: 0, contributions: [], notes: [], open: 0, previous_cents: null,
  ...over,
});

const FORM: WorksheetForm = {
  year: 2025, catalogue_year: 2025, exact: true, joint: true, documents_read: 3, documents_unread: 0, previous: null,
  values: [
    value({ key: "n.lohnsteuer", label: "Lohnsteuer", line: 6, kennzahl: "140", place: "Zeile 6 · Kz 140", cents: 795040, contributions: [contribution(1, "Lohnsteuerbescheinigung Beispiel GmbH", 795040, "confirmed")] }),
    value({
      cents: 4200000, prefilled: true, open: 1,
      notes: ["Vom Finanzamt elektronisch vorausgefüllt: nur prüfen."],
      contributions: [contribution(1, "Lohnsteuerbescheinigung Beispiel GmbH", 3000000), contribution(2, "Lohnsteuerbescheinigung Muster AG", 1200000, "confirmed")],
    }),
    value({ key: "kap.verluste_aktien", anlage: "anlage-kap", anlage_name: "Anlage KAP", label: "Verluste Aktien", line: 13, kennzahl: "416", place: "Zeile 13 · Kz 416", cents: 50000, contributions: [contribution(3, "Steuerbescheinigung Beispielbank", 50000, "read", 100000)], open: 1 }),
    value({ key: "kap.verluste_sonstige", anlage: "anlage-kap", anlage_name: "Anlage KAP", label: "Verluste sonstige", line: 12, kennzahl: "415", place: "Zeile 12 · Kz 415", cents: 1000, contributions: [contribution(3, "Steuerbescheinigung Beispielbank", 1000, "corrected")] }),
    value({ key: "vorsorge.kv_wahlleistungen", anlage: "vorsorgeaufwand", anlage_name: "Vorsorgeaufwand", label: "Wahlleistungen", line: null, kennzahl: null, place: "siehe Hinweis zum Vordruck", form_note: "Gesetzlich versichert: Zeile 22.", cents: 30000, contributions: [contribution(4, "Beitragsbescheinigung Beispielkasse", 30000, "confirmed")] }),
  ],
  skipped: [{ value_id: 9, document_id: 9, document_title: "Rechnung Malerbetrieb", evidence_kind_name: "Handwerkerrechnung", field_label: "Rechnungsbetrag brutto", form_label: null, value_cents: 99900, printed: "999,00", quote: null, status: "rejected", reason: "Zahl steht nicht im Text", note: null }],
};

describe("kennzahlSheet", () => {
  const sheet = kennzahlSheet(FORM);

  it("groups by Anlage and person and lists the fields in the order of the form", () => {
    expect(sheet.groups.map((g) => [g.title, g.rows.map((r) => r.place)])).toEqual([
      ["Anlage N – Person A (Sie)", ["Zeile 5 · Kz 110", "Zeile 6 · Kz 140"]],
      ["Anlage KAP – Person A (Sie)", ["Zeile 12 · Kz 415", "Zeile 13 · Kz 416"]],
      ["Vorsorgeaufwand – Person A (Sie)", ["siehe Hinweis zum Vordruck"]],
    ]);
  });

  it("points a sum to its appendix and names a single document in the row", () => {
    const [brutto, lohnsteuer] = sheet.groups[0]!.rows;
    expect(brutto).toMatchObject({ value: "42.000,00 €", from: "siehe Anhang 1", marks: ["1 ungeprüft", "vorausgefüllt – nur prüfen"], notes: [] });
    expect(lohnsteuer).toMatchObject({ value: "7.950,40 €", from: "Lohnsteuerbescheinigung Beispiel GmbH", marks: [] });
    expect(sheet.appendix).toEqual([{
      n: 1,
      title: "Zeile 5 · Kz 110 Bruttoarbeitslohn – Person A (Sie)",
      lines: [
        { document: "Lohnsteuerbescheinigung Beispiel GmbH (Nr. 1)", part: "Bruttoarbeitslohn", amount: "30.000,00 €", state: "ungeprüft" },
        { document: "Lohnsteuerbescheinigung Muster AG (Nr. 2)", part: "Bruttoarbeitslohn", amount: "12.000,00 €", state: "bestätigt" },
      ],
      total: "42.000,00 €",
    }]);
  });

  it("carries the form's note and lists what was not taken", () => {
    expect(sheet.groups[2]!.rows[0]!.notes).toEqual(["Vordruck: Gesetzlich versichert: Zeile 22."]);
    // A shared certificate split under joint assessment says so.
    expect(sheet.groups[1]!.rows[1]!.from).toBe("Steuerbescheinigung Beispielbank (Hälfte von 1.000,00 €)");
    expect(sheet.skipped).toEqual(["Rechnung Malerbetrieb (Nr. 9): Rechnungsbetrag brutto „999,00“ – Zahl steht nicht im Text"]);
  });

  it("marks unchecked Kennzahlen and is empty without values", () => {
    const unchecked = kennzahlSheet({ ...FORM, values: [value({ checked: false, place: "Kennzahl prüfen", cents: 100, contributions: [contribution(1, "Beleg", 100, "confirmed")] })], skipped: [] });
    expect(unchecked.groups[0]!.rows[0]!.marks).toEqual(["Kennzahl prüfen"]);
    expect(kennzahlSheet(null)).toEqual({ groups: [], appendix: [], skipped: [], missing: [] });
  });
});

describe("last year in the PDF", () => {
  const withPrevious: WorksheetForm = {
    ...FORM,
    values: [value({ cents: 4200000, previous_cents: 3950000, contributions: [contribution(1, "Lohnsteuerbescheinigung Beispiel GmbH", 4200000, "confirmed")] })],
    skipped: [],
    previous: {
      year: 2024,
      missing: [{ key: "sonder.spenden", anlage_name: "Sonderausgaben", label: "Spenden", owner_label: "Gemeinsam", place: "Zeile 5 · Kz 123", previous_cents: 20000, previous_documents: [{ document_id: 8, document_title: "Zuwendungsbestätigung Beispielverein" }] }],
    },
  };

  it("names last year's value in the row and lists what came last year but not yet", () => {
    const sheet = kennzahlSheet(withPrevious);
    expect(sheet.groups[0]!.rows[0]!.marks).toEqual(["Vorjahr 39.500,00 €"]);
    expect(sheet.missing).toEqual(["Sonderausgaben – Gemeinsam: Zeile 5 · Kz 123 Spenden, 2024: 200,00 € (aus Zuwendungsbestätigung Beispielverein)"]);
  });
});

describe("renderTaxWorksheetPdf", () => {
  const worksheet = (form: WorksheetForm | null): TaxWorksheet => ({
    year: 2025, form, businesses: [], sections: [], documentCount: 3, tags: [], bookingCount: 0, bookingTotal: 0, depot: null, hints: [],
  });

  async function text(pdf: Buffer): Promise<string> {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
    let out = "";
    for (let n = 1; n <= doc.numPages; n++) {
      out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ") + "\n";
    }
    return out.replace(/\s+/g, " ");
  }

  it("lists the values by Kennzahl and the appendix", async () => {
    const t = await text(await renderTaxWorksheetPdf(worksheet(FORM), "2026-10-19"));
    expect(t).toContain("Zusammenveranlagung");
    expect(t).toContain("Anlage N – Person A (Sie)");
    expect(t).toContain("Zeile 5 · Kz 110");
    expect(t).toContain("42.000,00 €");
    expect(t).toContain("siehe Anhang 1");
    expect(t).toContain("Anhang 1: Zeile 5 · Kz 110 Bruttoarbeitslohn");
    expect(t).toContain("Lohnsteuerbescheinigung Muster AG (Nr. 2)");
    expect(t).toContain("Nicht übernommene Werte");
    expect(t).not.toContain("noch keine Werte ausgelesen");
  });

  it("says so when no value is read yet", async () => {
    const t = await text(await renderTaxWorksheetPdf(worksheet(null), "2026-10-19"));
    expect(t).toContain("noch keine Werte ausgelesen");
    expect(t).not.toContain("Anhang");
  });
});
