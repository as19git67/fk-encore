/**
 * The worksheet as a PDF the user keeps next to ELSTER: one page per
 * Anlage with the documents, the bookings by
 * tag, the depot's figures and the hints. Plain A4 with pdfkit, like the
 * grouped report.
 */

import PDFDocument from "pdfkit";
import { normalizePdfText } from "../finance/pdf-report";
import type { TaxWorksheet } from "./tax-worksheet";

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

  pdf.font("Helvetica-Bold").fontSize(18).text(t(`Ausfüllhilfe Steuererklärung ${w.year}`), { align: "center" });
  pdf.moveDown(0.3).font("Helvetica").fontSize(9).fillColor("#666")
    .text(t(`Erstellt am ${germanDate(generatedOn)} · ${w.documentCount} Dokumente in ${w.sections.length} Anlagen · ${w.bookingCount} steuerrelevante Buchungen`), { align: "center" });
  pdf.moveDown(0.2).text(t("Die Werte auf den Belegen werden noch nicht ausgelesen. Jede Zahl bitte direkt aus dem Dokument übernehmen."), { align: "center" });
  pdf.fillColor("#000");

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

  pdf.end();
  return done;
}
