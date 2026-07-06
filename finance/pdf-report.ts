import PDFDocument from "pdfkit";

export interface ExpenseReportRow {
  booking_date: string;
  counterparty: string | null;
  purpose: string | null;
  amount: string;
  currency_code: string;
  notice: string | null;
  tags: string[];
}

export function createExpenseReportPdf(rows: ExpenseReportRow[], today = new Date().toISOString().slice(0, 10)): PDFKit.PDFDocument {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency_code, (totals.get(row.currency_code) ?? 0) + Number(row.amount));

  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: "Spesenabrechnung" } });
  pdf.fontSize(18).text("Spesenabrechnung", { align: "center" });
  pdf.moveDown(0.4).fontSize(9).fillColor("#666").text(`Erstellt am ${today} · ${rows.length} Buchungen`, { align: "center" });
  pdf.moveDown(1).fillColor("#000");
  for (const row of rows) {
    if (pdf.y > 740) pdf.addPage();
    const amount = new Intl.NumberFormat("de-DE", { style: "currency", currency: row.currency_code }).format(Number(row.amount));
    pdf.fontSize(9).font("Helvetica-Bold").text(`${row.booking_date.slice(0, 10)}  ${row.counterparty ?? "(ohne Gegenseite)"}`, { continued: true });
    pdf.text(amount, { align: "right" });
    pdf.font("Helvetica").fillColor("#444").text(row.purpose ?? "", { width: 500 });
    if (row.notice) pdf.text(`Notiz: ${row.notice}`, { width: 500 });
    if (row.tags.length) pdf.text(`Tags: ${row.tags.join(", ")}`);
    pdf.moveDown(0.5).strokeColor("#ddd").moveTo(42, pdf.y).lineTo(553, pdf.y).stroke().moveDown(0.5).fillColor("#000");
  }
  pdf.moveDown().font("Helvetica-Bold").fontSize(11).text("Summen");
  for (const [currency, total] of totals) pdf.text(new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(total), { align: "right" });
  return pdf;
}
