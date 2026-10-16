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

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}](?:[\uFE0E\uFE0F]|\u200D[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}])*/gu;
const PDF_WINANSI_EXTRA = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017D, 0x017E,
  0x0192, 0x02C6, 0x02DC,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E,
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203A,
  0x20AC, 0x2122,
]);

const EMOJI_TEXT_REPLACEMENTS = new Map<string, string>([
  ["😀", ":)"], ["😃", ":)"], ["😄", ":)"], ["😁", ":)"], ["🙂", ":)"], ["😊", ":)"], ["☺", ":)"],
  ["😉", ";)"],
  ["😂", ":D"], ["🤣", ":D"],
  ["😍", "<3"], ["🥰", "<3"], ["😘", "<3"], ["❤", "<3"], ["♥", "<3"],
  ["😢", ":("], ["😭", ":("], ["☹", ":("], ["🙁", ":("],
  ["😎", "B)"],
  ["😠", ">:("], ["😡", ">:("],
  ["👍", "+1"], ["👎", "-1"],
  ["✅", "[ok]"], ["❌", "[x]"], ["⭐", "*"], ["★", "*"],
]);

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

function replaceEmojiForPdf(value: string): string {
  const stripped = value.replace(/[\uFE0E\uFE0F\u200D]/g, "");
  const exact = EMOJI_TEXT_REPLACEMENTS.get(stripped);
  if (exact) return exact;
  const codePoints = Array.from(stripped, (char) => char.codePointAt(0) ?? 0);
  if (codePoints.some((cp) => cp >= 0x1F600 && cp <= 0x1F64F)) return ":)";
  return "";
}

function isPdfStandardFontChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return char === "\n" || char === "\r" || char === "\t" || (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || PDF_WINANSI_EXTRA.has(cp);
}

export function normalizePdfText(value: string): string {
  return Array
    .from(value.replace(EMOJI_RE, replaceEmojiForPdf).replace(/[\uFE0E\uFE0F\u200D]/g, ""))
    .map((char) => isPdfStandardFontChar(char) ? char : "?")
    .join("");
}

export function createTransactionReportPdf(
  rows: ExpenseReportRow[],
  today = new Date().toISOString().slice(0, 10),
  options: TransactionReportOptions = {},
): PDFKit.PDFDocument {
  const opts = { ...DEFAULT_REPORT_OPTIONS, ...options };
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency_code, (totals.get(row.currency_code) ?? 0) + Number(row.amount));

  const title = normalizePdfText(opts.title);
  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: title } });
  pdf.fontSize(18).text(title, { align: "center" });
  pdf.moveDown(0.4).fontSize(9).fillColor("#666").text(`Erstellt am ${formatLocalDate(today)} · ${rows.length} Buchungen`, { align: "center" });
  pdf.moveDown(1).fillColor("#000");
  for (const row of rows) {
    if (pdf.y > 740) pdf.addPage();
    const amount = new Intl.NumberFormat("de-DE", { style: "currency", currency: row.currency_code }).format(Number(row.amount));
    const headlineParts = [
      opts.includeDate ? formatLocalDate(row.booking_date) : null,
      opts.includeCounterparty ? normalizePdfText(row.counterparty ?? "(ohne Gegenseite)") : null,
    ].filter((part): part is string => !!part);
    pdf.fontSize(9).font("Helvetica-Bold").text(headlineParts.join("  ") || "Buchung", {
      continued: opts.includeAmount,
    });
    if (opts.includeAmount) pdf.text(amount, { align: "right" });
    pdf.font("Helvetica").fillColor("#444");
    if (opts.includePurpose && row.purpose) pdf.text(normalizePdfText(row.purpose), { width: 500 });
    if (opts.includeNotice && row.notice) pdf.text(`Notiz: ${normalizePdfText(row.notice)}`, { width: 500 });
    if (opts.includeTags && row.tags.length) pdf.text(`Tags: ${normalizePdfText(row.tags.join(", "))}`);
    pdf.moveDown(0.5).strokeColor("#ddd").moveTo(42, pdf.y).lineTo(553, pdf.y).stroke().moveDown(0.5).fillColor("#000");
  }
  pdf.moveDown().font("Helvetica-Bold").fontSize(11).text("Summe");
  for (const [currency, total] of totals) pdf.text(new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(total), { align: "right" });
  return pdf;
}

export const createExpenseReportPdf = createTransactionReportPdf;

/**
 * A report in groups (#1533): each group under its heading with its bookings
 * and a subtotal, then the grand total and, when asked for, the yield with its
 * formula and period. Every number comes from `buildGroupedReport`.
 */
export function createGroupedReportPdf(report: import("./grouped-report").GroupedReport): PDFKit.PDFDocument {
  const money = (c: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: report.currency }).format(c / 100);
  const title = normalizePdfText(report.title);
  const pdf = new PDFDocument({ size: "A4", margin: 42, info: { Title: title } });
  const right = (text: string) => pdf.text(text, { align: "right" });
  const rule = (color = "#ddd") => pdf.strokeColor(color).moveTo(42, pdf.y).lineTo(553, pdf.y).stroke();

  pdf.fontSize(18).text(title, { align: "center" });
  pdf.moveDown(0.4).fontSize(9).fillColor("#666")
    .text(`Erstellt am ${formatLocalDate(report.generated_on)} · ${report.count} Buchungen in ${report.groups.length} Gruppen`, { align: "center" });
  pdf.moveDown(1).fillColor("#000");

  for (const group of report.groups) {
    if (pdf.y > 700) pdf.addPage();
    pdf.font("Helvetica-Bold").fontSize(12).text(normalizePdfText(group.name), { continued: true });
    pdf.font("Helvetica").fontSize(9).fillColor("#666").text(`  ${group.count} Buchungen`);
    pdf.fillColor("#000").moveDown(0.3);
    rule("#999");
    pdf.moveDown(0.3);
    for (const b of group.bookings) {
      if (pdf.y > 760) pdf.addPage();
      const head = `${formatLocalDate(b.booking_date)}  ${normalizePdfText(b.counterparty ?? "(ohne Gegenseite)")}`;
      pdf.font("Helvetica").fontSize(9).text(head, { continued: true });
      right(money(Math.round(Number(b.amount) * 100)));
      if (b.purpose) pdf.fillColor("#555").fontSize(8).text(normalizePdfText(b.purpose), { width: 420 }).fillColor("#000");
      pdf.moveDown(0.2);
    }
    pdf.moveDown(0.2);
    rule();
    pdf.moveDown(0.2).font("Helvetica-Bold").fontSize(10).text(`Zwischensumme ${normalizePdfText(group.name)}`, { continued: true });
    right(money(group.subtotal));
    pdf.font("Helvetica").moveDown(1);
  }

  if (pdf.y > 680) pdf.addPage();
  rule("#000");
  pdf.moveDown(0.3).font("Helvetica-Bold").fontSize(12).text(`Summe (${report.count} Buchungen)`, { continued: true });
  right(money(report.total));

  if (report.yield) {
    const y = report.yield;
    pdf.moveDown(1.2).font("Helvetica-Bold").fontSize(12).text("Rendite");
    pdf.font("Helvetica").fontSize(9).moveDown(0.3);
    for (const [label, value] of [
      ["Investition", money(y.investment)],
      ["Einnahmen", money(y.income)],
      ["Kosten", money(y.costs)],
      ["Ertrag (Einnahmen + Kosten)", money(y.net)],
    ] as const) {
      pdf.text(label, { continued: true });
      right(value);
    }
    pdf.moveDown(0.6).fillColor("#333").fontSize(9).text(normalizePdfText(y.formula), { width: 511 });
    pdf.moveDown(0.4).fillColor("#666").fontSize(8)
      .text("Einfache Rendite ohne Zinseszins: Ertrag geteilt durch die Investition, für p. a. geteilt durch die Jahre seit der ersten Buchung der Investition.", { width: 511 });
    pdf.fillColor("#000");
  }
  return pdf;
}
