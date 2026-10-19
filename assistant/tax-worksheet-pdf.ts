/**
 * The worksheet as a PDF the user keeps next to ELSTER
 * (documentation/plans/steuer-ausfuellhilfe.md, stage 4): first the values
 * by Anlage and person, Zeile · Kennzahl · Bezeichnung · Wert in the order
 * of the form, so they can be typed in one after the other; a value summed
 * from several documents points to an appendix naming each document and
 * amount. Then the documents per Anlage, the bookings by tag, the
 * businesses, the depot's figures and the hints. Plain A4 with pdfkit,
 * like the grouped report.
 */

import PDFDocument from "pdfkit";
import { normalizePdfText } from "../finance/pdf-report";
import type { TaxWorksheet, WorksheetForm } from "./tax-worksheet";

const euroCents = (c: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(c / 100).replace(/\u00a0/g, " ");

export interface SheetRow {
  place: string;
  label: string;
  value: string;
  /** Where the value comes from: the one document, or "siehe Anhang n". */
  from: string;
  /** What is still to do: unchecked Kennzahl, unconfirmed value, prefilled data. */
  marks: string[];
  notes: string[];
}

export interface SheetGroup {
  title: string;
  rows: SheetRow[];
}

export interface SheetAppendix {
  n: number;
  title: string;
  lines: { document: string; part: string; amount: string; state: string }[];
  total: string;
}

export interface KennzahlSheet {
  groups: SheetGroup[];
  appendix: SheetAppendix[];
  skipped: string[];
}

const STATE: Record<string, string> = { read: "ungeprüft", confirmed: "bestätigt", corrected: "korrigiert", rejected: "nicht belegt" };

/** Line, then Kennzahl; fields without a line at the end, in catalogue order. */
function byPlace(a: WorksheetForm["values"][number], b: WorksheetForm["values"][number]): number {
  const la = a.line ?? Number.MAX_SAFE_INTEGER;
  const lb = b.line ?? Number.MAX_SAFE_INTEGER;
  return la - lb || Number(a.kennzahl ?? Infinity) - Number(b.kennzahl ?? Infinity);
}

/** The values by Kennzahl as the PDF lists them; pure, for the tests. */
export function kennzahlSheet(form: WorksheetForm | null): KennzahlSheet {
  const out: KennzahlSheet = { groups: [], appendix: [], skipped: [] };
  if (!form) return out;
  const groups = new Map<string, WorksheetForm["values"]>();
  for (const v of form.values) {
    const title = `${v.anlage_name} – ${v.owner_label}`;
    groups.set(title, [...(groups.get(title) ?? []), v]);
  }
  for (const [title, values] of groups) {
    const rows: SheetRow[] = [];
    for (const v of [...values].sort(byPlace)) {
      let from = "";
      if (v.contributions.length === 1) {
        const c = v.contributions[0]!;
        from = c.document_title + (c.cents !== c.value_cents ? ` (Hälfte von ${euroCents(c.value_cents)})` : "");
      } else if (v.contributions.length > 1) {
        const n = out.appendix.length + 1;
        out.appendix.push({
          n,
          title: `${v.place} ${v.label} – ${v.owner_label}`,
          lines: v.contributions.map((c) => ({
            document: `${c.document_title} (Nr. ${c.document_id})`,
            part: c.field_label,
            amount: euroCents(c.cents) + (c.cents !== c.value_cents ? ` (Hälfte von ${euroCents(c.value_cents)})` : ""),
            state: STATE[c.status] ?? c.status,
          })),
          total: euroCents(v.cents),
        });
        from = `siehe Anhang ${n}`;
      }
      const marks: string[] = [];
      if (!v.checked) marks.push("Kennzahl prüfen");
      if (v.open) marks.push(v.open === v.contributions.length ? "ungeprüft" : `${v.open} ungeprüft`);
      if (v.prefilled) marks.push("vorausgefüllt – nur prüfen");
      rows.push({
        place: v.place,
        label: v.label,
        value: euroCents(v.cents),
        from,
        marks,
        // The prefilled note says the same as the mark.
        notes: [...(v.form_note ? [`Vordruck: ${v.form_note}`] : []), ...v.notes.filter((n) => !n.startsWith("Vom Finanzamt elektronisch vorausgefüllt"))],
      });
    }
    out.groups.push({ title, rows });
  }
  for (const s of form.skipped) {
    out.skipped.push(`${s.document_title} (Nr. ${s.document_id}): ${s.field_label}${s.printed ? ` „${s.printed}“` : ""} – ${s.reason}`);
  }
  return out;
}

const money = (n: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
const germanDate = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "–");

export function renderTaxWorksheetPdf(w: TaxWorksheet, generatedOn: string): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: `Ausfüllhilfe Steuer ${w.year}` } });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const t = (s: string) => normalizePdfText(s);
  const left = 42;
  const right = 553;
  const rule = (color = "#ddd") => pdf.strokeColor(color).lineWidth(0.5).moveTo(left, pdf.y).lineTo(right, pdf.y).stroke();
  const row = (cells: [string, string, string], bold = false) => {
    const y = pdf.y;
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#000");
    pdf.text(t(cells[0]), left, y, { width: 70 });
    pdf.text(t(cells[1]), left + 76, y, { width: 330 });
    pdf.text(t(cells[2]), left + 412, y, { width: right - left - 412, align: "right" });
    pdf.moveDown(0.2);
  };
  const heading = (text: string) => {
    if (pdf.y > 720) pdf.addPage();
    pdf.moveDown(0.6).font("Helvetica-Bold").fontSize(12).fillColor("#000").text(t(text), left);
    pdf.moveDown(0.2);
    rule("#999");
    pdf.moveDown(0.3);
  };

  const sheet = kennzahlSheet(w.form);
  pdf.font("Helvetica-Bold").fontSize(18).text(t(`Ausfüllhilfe Steuererklärung ${w.year}`), { align: "center" });
  pdf.moveDown(0.3).font("Helvetica").fontSize(9).fillColor("#666")
    .text(t(`Erstellt am ${germanDate(generatedOn)} · ${w.documentCount} Dokumente in ${w.sections.length} Anlagen · ${w.bookingCount} steuerrelevante Buchungen`), { align: "center" });
  pdf.moveDown(0.2).text(t(sheet.groups.length
    ? `Die Werte sind von den Belegen ausgelesen und nach Zeile und Kennzahl der Vordrucke ${w.form!.catalogue_year} geordnet${w.form!.joint ? " (Zusammenveranlagung)" : ""}. Ungeprüfte Werte bitte am Dokument prüfen; die Steuer wird hier nicht berechnet.`
    : "Von den Belegen sind noch keine Werte ausgelesen. Jede Zahl bitte direkt aus dem Dokument übernehmen."), { align: "center" });
  pdf.fillColor("#000");

  // Values by Kennzahl, ready for ELSTER.
  const kzRow = (r: SheetRow) => {
    if (pdf.y > 740) pdf.addPage();
    const y = pdf.y;
    pdf.font("Helvetica").fontSize(9).fillColor("#000");
    pdf.text(t(r.place), left, y, { width: 96 });
    const labelY = pdf.y;
    pdf.text(t(r.label), left + 100, y, { width: 270 });
    const afterLabel = pdf.y;
    pdf.font("Helvetica-Bold").text(t(r.value), left + 374, y, { width: right - left - 374, align: "right" });
    pdf.y = Math.max(labelY, afterLabel, pdf.y);
    pdf.font("Helvetica").fontSize(8).fillColor("#555");
    const sub = [r.from, ...r.marks].filter(Boolean).join(" · ");
    if (sub) pdf.text(t(sub), left + 100, pdf.y, { width: right - left - 100 });
    for (const n of r.notes) pdf.text(t(n), left + 100, pdf.y, { width: right - left - 100 });
    pdf.fillColor("#000").moveDown(0.3);
  };
  const kzHead = () => {
    const y = pdf.y;
    pdf.font("Helvetica-Bold").fontSize(9).fillColor("#000");
    pdf.text(t("Zeile · Kz"), left, y, { width: 96 });
    pdf.text(t("Bezeichnung · Herkunft"), left + 100, y, { width: 270 });
    pdf.text(t("Wert"), left + 374, y, { width: right - left - 374, align: "right" });
    pdf.moveDown(0.2);
  };
  for (const g of sheet.groups) {
    heading(g.title);
    kzHead();
    for (const r of g.rows) kzRow(r);
  }
  if (sheet.skipped.length) {
    heading("Nicht übernommene Werte");
    pdf.font("Helvetica").fontSize(9);
    for (const s of sheet.skipped) pdf.text(t(`• ${s}`), left, pdf.y, { width: right - left });
  }

  for (const s of w.sections) {
    heading(s.name);
    row(["Datum", "Dokument", "Nr."], true);
    for (const d of s.documents) {
      if (pdf.y > 760) pdf.addPage();
      row([germanDate(d.date), `${d.title}${d.from ? ` · ${d.from}` : ""}`, String(d.id)]);
    }
  }

  if (w.tags.length) {
    heading(`Steuerrelevante Buchungen ${w.year} nach Tag`);
    for (const tag of w.tags) {
      if (pdf.y > 740) pdf.addPage();
      row(["", `${tag.tag} (${tag.count})`, money(tag.sum)], true);
      for (const b of tag.bookings.slice(0, 40)) {
        if (pdf.y > 760) pdf.addPage();
        row([germanDate(b.date), [b.counterparty, b.purpose].filter(Boolean).join(" · ") || `Buchung ${b.id}`, money(b.amount)]);
      }
      if (tag.bookings.length > 40) row(["", `… und ${tag.bookings.length - 40} weitere`, ""]);
      pdf.moveDown(0.3);
    }
    rule();
    row(["", `Summe aller steuerrelevanten Buchungen (${w.bookingCount})`, money(w.bookingTotal)], true);
  }

  for (const b of w.businesses) {
    heading(`${b.name} – EÜR ${w.year} (${b.tax_section.replace("anlage-", "Anlage ").toUpperCase()})`);
    if (b.exempt === true) {
      row(["", "Steuerfrei nach § 3 Nr. 72 EStG – keine Angaben in Anlage G und Anlage EÜR; Zahlen nur zur Information.", ""], true);
    }
    row(["", `Betriebseinnahmen (${b.bookings} Buchungen)`, money(b.income)]);
    row(["", "Betriebsausgaben einschließlich AfA", money(b.expenses)]);
    row(["", "davon AfA aus dem Anlagenverzeichnis", money(b.afa)]);
    rule();
    row(["", b.result >= 0 ? "Gewinn" : "Verlust", money(b.result)], true);
    for (const h of b.hints) row(["", `Hinweis: ${h}`, ""]);
  }
  if (w.depot) {
    heading(`Depot ${w.year} (Anlage KAP, aus dem Portfolio)`);
    row(["", `Erträge aus Dividenden und Zinsen (${w.depot.dividend_count} Zahlungen)`, money(Number(w.depot.income))]);
    row(["", `Realisierte Gewinne (${w.depot.sell_count} Verkäufe)${w.depot.realized_complete ? "" : " – unvollständig"}`, money(Number(w.depot.realized))]);
    row(["", "Einbehaltene Steuern", money(Number(w.depot.taxes))]);
    row(["", "Gebühren", money(Number(w.depot.fees))]);
  }

  if (w.hints.length) {
    heading("Hinweise");
    pdf.font("Helvetica").fontSize(9);
    for (const h of w.hints) pdf.text(t(`• ${h}`), left, pdf.y, { width: right - left });
  }

  if (sheet.appendix.length) {
    pdf.addPage();
    pdf.font("Helvetica-Bold").fontSize(14).text(t("Anhang: zusammengesetzte Werte"), left);
    for (const a of sheet.appendix) {
      heading(`Anhang ${a.n}: ${a.title}`);
      row(["Status", "Dokument · Wert auf dem Beleg", "Betrag"], true);
      for (const l of a.lines) {
        if (pdf.y > 760) pdf.addPage();
        row([l.state, `${l.document} · ${l.part}`, l.amount]);
      }
      rule();
      row(["", "Summe", a.total], true);
    }
  }

  pdf.end();
  return done;
}
