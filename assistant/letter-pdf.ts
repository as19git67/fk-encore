/**
 * A letter as a DIN 5008 page (form B), rendered with pdfkit (#1534).
 *
 * Form B places the address field 45 mm from the top edge, 20 mm from the
 * left, 85 × 45 mm: a 5 mm return line (Rücksendeangabe), a 12.7 mm zone for
 * notes, then 27.3 mm for the address itself — what shows in the window of a
 * DL envelope. The information block (date) stands at 125 mm, the text runs
 * from 25 mm to 20 mm before the right edge. Fold marks at 105 and 210 mm and
 * the punch mark at 148.5 mm sit on the left edge.
 */

import PDFDocument from "pdfkit";
import { normalizePdfText } from "../finance/pdf-report";

export const MM = 72 / 25.4;

/** The geometry of form B, in mm from the top-left corner. */
export const DIN5008_B = {
  pageWidth: 210,
  pageHeight: 297,
  left: 25,
  right: 20,
  addressLeft: 20,
  addressWidth: 85,
  addressTop: 45,
  returnLineHeight: 5,
  /** Where the recipient's first line starts: after the return line and the note zone. */
  recipientTop: 45 + 5 + 12.7,
  addressBottom: 90,
  infoLeft: 125,
  infoTop: 50,
  subjectTop: 98.46,
  foldMarks: [105, 210],
  punchMark: 148.5,
} as const;

export interface LetterContent {
  /** Name and address, one per line; the first line is the name. */
  sender: string;
  /** The recipient's address, one per line, at most six lines. */
  recipient: string;
  subject: string;
  /** Salutation, text and closing as the user confirmed them. */
  body: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Titles of the enclosures, listed under "Anlagen". */
  attachments: string[];
}

/** A gap the model left for the user: `[[Rechnungsdatum]]`. */
export const GAP_RE = /\[\[([^\]\n]{1,120})\]\]/g;

export function gapsIn(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(GAP_RE)) found.add(m[1].trim());
  return [...found];
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function germanDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function renderLetterPdf(letter: LetterContent): Promise<Buffer> {
  const g = DIN5008_B;
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: 20 * MM, bottom: 20 * MM, left: g.left * MM, right: g.right * MM },
    info: { Title: normalizePdfText(letter.subject) },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const text = (s: string) => normalizePdfText(s);
  const senderLines = lines(letter.sender);
  const textWidth = (g.pageWidth - g.left - g.right) * MM;

  // Letterhead: the sender, right-aligned above the information block.
  pdf.font("Helvetica-Bold").fontSize(11);
  if (senderLines[0]) pdf.text(text(senderLines[0]), g.left * MM, 15 * MM, { width: textWidth, align: "right" });
  pdf.font("Helvetica").fontSize(9).fillColor("#333");
  for (const l of senderLines.slice(1)) pdf.text(text(l), { width: textWidth, align: "right" });
  pdf.fillColor("#000");

  // Return line: the sender in one small line, inside the window's top 5 mm.
  const returnLine = senderLines.join(" · ");
  if (returnLine) {
    pdf.font("Helvetica").fontSize(7).fillColor("#444")
      .text(text(returnLine), (g.addressLeft + 5) * MM, (g.addressTop + 1.5) * MM, {
        width: (g.addressWidth - 5) * MM,
        lineBreak: false,
        ellipsis: true,
      });
    pdf.strokeColor("#888").lineWidth(0.3)
      .moveTo((g.addressLeft + 5) * MM, (g.addressTop + g.returnLineHeight) * MM)
      .lineTo((g.addressLeft + g.addressWidth) * MM, (g.addressTop + g.returnLineHeight) * MM)
      .stroke();
    pdf.fillColor("#000");
  }

  // The recipient, in the address zone of the window.
  pdf.font("Helvetica").fontSize(11);
  let y = g.recipientTop * MM;
  for (const l of lines(letter.recipient).slice(0, 6)) {
    pdf.text(text(l), (g.addressLeft + 5) * MM, y, { width: (g.addressWidth - 5) * MM, lineBreak: false, ellipsis: true });
    y += pdf.currentLineHeight(true);
  }

  // Information block: the date.
  pdf.fontSize(10).text(`Datum: ${germanDate(letter.date)}`, g.infoLeft * MM, g.infoTop * MM, {
    width: (g.pageWidth - g.infoLeft - g.right) * MM,
  });

  // Fold and punch marks.
  pdf.strokeColor("#999").lineWidth(0.4);
  for (const mark of [...g.foldMarks, g.punchMark]) {
    const len = mark === g.punchMark ? 7 : 5;
    pdf.moveTo(3 * MM, mark * MM).lineTo((3 + len) * MM, mark * MM).stroke();
  }

  // Subject and text.
  pdf.font("Helvetica-Bold").fontSize(11).fillColor("#000")
    .text(text(letter.subject), g.left * MM, g.subjectTop * MM, { width: textWidth });
  pdf.moveDown(1.5).font("Helvetica").fontSize(11);
  const paragraphs = letter.body.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const p of paragraphs) {
    pdf.text(text(p.trim()), g.left * MM, pdf.y, { width: textWidth, lineGap: 2 });
    pdf.moveDown(0.8);
  }

  if (letter.attachments.length) {
    pdf.moveDown(0.6).font("Helvetica-Bold").fontSize(10).text("Anlagen", g.left * MM, pdf.y, { width: textWidth });
    pdf.font("Helvetica").fontSize(10);
    for (const a of letter.attachments) pdf.text(`– ${text(a)}`, { width: textWidth });
  }

  pdf.end();
  return done;
}
