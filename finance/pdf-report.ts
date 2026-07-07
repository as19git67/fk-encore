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

export interface TransactionReportOptions {
  title?: string;
  includeDate?: boolean;
  includeCounterparty?: boolean;
  includePurpose?: boolean;
  includeAmount?: boolean;
  includeNotice?: boolean;
  includeTags?: boolean;
}

const DEFAULT_REPORT_OPTIONS: Required<TransactionReportOptions> = {
  title: "Transaktionsübersicht",
  includeDate: true,
  includeCounterparty: true,
  includePurpose: true,
  includeAmount: true,
  includeNotice: true,
  includeTags: true,
};

function formatLocalDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return `${day}.${month}.${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function createTransactionReportPdf(
  rows: ExpenseReportRow[],
  today = new Date().toISOString().slice(0, 10),
  options: TransactionReportOptions = {},
): PDFKit.PDFDocument {
  const opts = { ...DEFAULT_REPORT_OPTIONS, ...options };
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency_code, (totals.get(row.currency_code) ?? 0) + Number(row.amount));

  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: opts.title } });
  pdf.fontSize(18).text(opts.title, { align: "center" });
  pdf.moveDown(0.4).fontSize(9).fillColor("#666").text(`Erstellt am ${formatLocalDate(today)} · ${rows.length} Buchungen`, { align: "center" });
  pdf.moveDown(1).fillColor("#000");
  for (const row of rows) {
    if (pdf.y > 740) pdf.addPage();
    const amount = new Intl.NumberFormat("de-DE", { style: "currency", currency: row.currency_code }).format(Number(row.amount));
    const headlineParts = [
      opts.includeDate ? formatLocalDate(row.booking_date) : null,
      opts.includeCounterparty ? (row.counterparty ?? "(ohne Gegenseite)") : null,
    ].filter((part): part is string => !!part);
    pdf.fontSize(9).font("Helvetica-Bold").text(headlineParts.join("  ") || "Buchung", {
      continued: opts.includeAmount,
    });
    if (opts.includeAmount) pdf.text(amount, { align: "right" });
    pdf.font("Helvetica").fillColor("#444");
    if (opts.includePurpose && row.purpose) pdf.text(row.purpose, { width: 500 });
    if (opts.includeNotice && row.notice) pdf.text(`Notiz: ${row.notice}`, { width: 500 });
    if (opts.includeTags && row.tags.length) pdf.text(`Tags: ${row.tags.join(", ")}`);
    pdf.moveDown(0.5).strokeColor("#ddd").moveTo(42, pdf.y).lineTo(553, pdf.y).stroke().moveDown(0.5).fillColor("#000");
  }
  pdf.moveDown().font("Helvetica-Bold").fontSize(11).text("Summe");
  for (const [currency, total] of totals) pdf.text(new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(total), { align: "right" });
  return pdf;
}

export const createExpenseReportPdf = createTransactionReportPdf;
