/**
 * The EÜR of one business and year as a PDF (documentation/plans/
 * betriebe-euer.md, stage 2): the income lines, the expense lines, the
 * AfA from the register, the totals and the result, each line with its
 * bookings so the figure can be checked against the form. Plain A4 with
 * pdfkit, like the grouped report. Every number comes from `buildEuer`.
 */

import PDFDocument from "pdfkit";
import type { EuerLine, EuerReport } from "./euer";
import { normalizePdfText } from "./pdf-report";

const money = (c: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(c / 100);
const germanDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function createEuerPdf(r: EuerReport, generatedOn: string): PDFKit.PDFDocument {
  const t = (s: string) => normalizePdfText(s);
  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: t(`EÜR ${r.business} ${r.year}`) } });
  const left = 42;
  const right = 553;
  const rule = (color = "#ddd") => pdf.strokeColor(color).lineWidth(0.5).moveTo(left, pdf.y).lineTo(right, pdf.y).stroke();
  const row = (label: string, value: string, opts: { bold?: boolean; indent?: number; muted?: boolean } = {}) => {
    if (pdf.y > 760) pdf.addPage();
    const y = pdf.y;
    const indent = opts.indent ?? 0;
    pdf.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.indent ? 8.5 : 10).fillColor(opts.muted ? "#555" : "#000");
    pdf.text(t(label), left + indent, y, { width: right - left - indent - 110 });
    pdf.text(value, right - 100, y, { width: 100, align: "right" });
    pdf.moveDown(0.15);
    pdf.fillColor("#000");
  };
  const heading = (text: string) => {
    if (pdf.y > 700) pdf.addPage();
    pdf.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#000").text(t(text), left);
    pdf.moveDown(0.2);
    rule("#999");
    pdf.moveDown(0.3);
  };
  const lines = (list: EuerLine[]) => {
    for (const l of list) {
      const label = `${l.form_line ? `${l.form_line} · ` : ""}${l.name}${l.count ? ` (${l.count} Buchung${l.count === 1 ? "" : "en"})` : ""}`;
      row(label, money(l.sum), { bold: l.count > 0 });
      for (const b of l.bookings) {
        row(`${germanDate(b.booking_date)}  ${b.counterparty ?? "(ohne Gegenseite)"}${b.purpose ? ` · ${b.purpose}` : ""}`, money(Math.round(Number(b.amount) * 100)), { indent: 14, muted: true });
      }
    }
  };

  pdf.font("Helvetica-Bold").fontSize(18).text(t(`Einnahmen-Überschuss-Rechnung ${r.year}`), { align: "center" });
  pdf.moveDown(0.2).font("Helvetica").fontSize(12).text(t(r.business), { align: "center" });
  pdf.moveDown(0.3).fontSize(9).fillColor("#666")
    .text(t(`Erstellt am ${germanDate(generatedOn)} · ${r.booking_count} Buchungen${r.tag ? ` mit Tag „${r.tag}“` : ""} · AfA aus dem Anlagenverzeichnis`), { align: "center" });
  pdf.fillColor("#000");

  heading("Betriebseinnahmen");
  lines(r.income);
  pdf.moveDown(0.2);
  rule();
  row("Summe Betriebseinnahmen", money(r.total_income), { bold: true });

  heading("Betriebsausgaben");
  lines(r.expenses);
  row(`Absetzung für Abnutzung (AfA)${r.afa.assets.length ? ` (${r.afa.assets.length} Anlagegüter)` : ""}`, money(r.afa.sum), { bold: r.afa.sum !== 0 });
  for (const a of r.afa.assets) row(a.name, money(a.afa), { indent: 14, muted: true });
  pdf.moveDown(0.2);
  rule();
  row("Summe Betriebsausgaben", money(r.total_expenses), { bold: true });

  pdf.moveDown(0.6);
  rule("#000");
  pdf.moveDown(0.2);
  row(r.result >= 0 ? "Gewinn" : "Verlust", money(r.result), { bold: true });

  if (r.hints.length) {
    heading("Hinweise");
    pdf.font("Helvetica").fontSize(9).fillColor("#333");
    for (const h of r.hints) pdf.text(t(`– ${h}`), left, pdf.y, { width: right - left });
    pdf.fillColor("#000");
  }
  pdf.moveDown(1).font("Helvetica").fontSize(8).fillColor("#666")
    .text(t("Die Zuordnung der Buchungen folgt den Tags; Buchungen ohne passende Zeile stehen unter „Sonstige“. Alle Beträge vor der Übernahme in die Anlage EÜR prüfen."), left, pdf.y, { width: right - left });
  return pdf;
}
