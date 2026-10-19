/**
 * Filling in the tax return (documentation/plans/ki-assistent.md): the
 * worksheet that arranges what the household holds the way the forms ask
 * for it, as a reading for the model and as a PDF the user keeps next to
 * ELSTER. The figures come from `assistant/tax-worksheet.ts`; nothing here
 * is the model's arithmetic.
 */

import { documents, finance } from "~encore/clients";
import { int, str } from "../format";
import type { WriteToolDefinition } from "../proposals";
import { buildTaxWorksheet, worksheetText, type TaxWorksheet } from "../tax-worksheet";
import { renderTaxWorksheetPdf } from "../tax-worksheet-pdf";
import { createEuerPdf } from "../../finance/euer-pdf";
import type { EuerReport } from "../../finance/euer";
import type { ToolContext, ToolSpec } from "../types";

const DOCUMENTS = ["module.documents", "documents.view"];

function mayFinance(ctx: ToolContext): boolean {
  return ["module.finance", "finance.view"].every((p) => ctx.user.permissions.includes(p));
}

function yearOf(args: Record<string, unknown>): number {
  const year = int(args.year, { min: 1990, max: 2100 });
  if (year === undefined) throw new Error("year is required (e.g. 2025)");
  return year;
}

export const taxWorksheet: ToolSpec = {
  name: "tax_worksheet",
  kind: "read",
  summary: "The worksheet for filling in one year's tax return: the values read off the evidence by Anlage, person, Zeile and Kennzahl (summed over the documents, with the law applied, each with the documents it came from and whether the user confirmed it), per Anlage the flagged documents, the bookings marked tax-relevant in the year summed by tag, the depot's income, gains and taxes of the year, and hints (evidence not read yet, values not confirmed, an Anlage that had documents last year but none yet). For the PDF of it, tax_worksheet_pdf.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "the tax year, e.g. 2025" },
      person_id: { type: "integer", description: "the Steuerakte of a household member with their own tax return (subject person id); default: the user's own" },
    },
    required: ["year"],
  },
  async run(args, ctx) {
    const year = yearOf(args);
    const w = await buildTaxWorksheet({ year, personId: int(args.person_id), mayFinance: mayFinance(ctx) });
    const rows = w.sections.flatMap((s) => s.documents.map((d) => ({
      section: s.name, title: d.title, date: d.date, from: d.from, id: d.id, route: `/dokumente/${d.id}`,
    })));
    const ids = [...new Set(rows.map((r) => r.id))];
    return {
      text: worksheetText(w),
      digest: `[earlier result of tax_worksheet: ${year}, ${w.form?.values.length ?? 0} form values, ${w.documentCount} documents in ${w.sections.length} Anlagen, ${w.bookingCount} bookings]`,
      rowCount: w.documentCount,
      ref: ids.length ? { type: "document", ids } : undefined,
      block: {
        kind: "documents",
        tool: "tax_worksheet",
        total: ids.length,
        subtitle: `Ausfüllhilfe ${year} · ${w.form?.values.length ? `${w.form.values.length} Werte nach Kennzahl · ` : ""}${w.sections.length} Anlagen · ${w.bookingCount} Buchungen`,
        rows,
        route: `/dokumente/steuer?year=${year}`,
      },
    };
  },
};

export const taxWorksheetPdf: WriteToolDefinition = {
  name: "tax_worksheet_pdf",
  summary: "Propose the worksheet for one year's tax return as a PDF ('Ausfüllhilfe Steuer <Jahr>'), stored as a document linked to the flagged documents: per Anlage the documents, the tax-relevant bookings by tag, the depot's figures and the hints.",
  permissions: DOCUMENTS,
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "the tax year, e.g. 2025" },
      person_id: { type: "integer", description: "the Steuerakte of a household member with their own tax return" },
    },
    required: ["year"],
  },
  async prepare(args, ctx) {
    const year = yearOf(args);
    const personId = int(args.person_id);
    const w = await buildTaxWorksheet({ year, personId, mayFinance: mayFinance(ctx) });
    if (!w.documentCount && !w.bookingCount) {
      throw new Error(`nothing is flagged for the tax year ${year}; flag documents on the Steuer page first`);
    }
    const documentIds = [...new Set(w.sections.flatMap((s) => s.documents.map((d) => d.id)))];
    return {
      summary: `Ausfüllhilfe Steuer ${year} als PDF: ${w.documentCount} Dokumente in ${w.sections.length} Anlagen, ${w.bookingCount} steuerrelevante Buchungen${w.depot ? ", Depotzahlen des Jahres" : ""}`,
      arguments: { year, person_id: personId ?? null, document_ids: documentIds },
      count: w.documentCount + w.bookingCount,
      note: `${w.hints.length ? `Hints in the PDF: ${w.hints.join(" ")} ` : ""}The PDF is stored as a document linked to the flagged documents.`,
    };
  },
  async execute(args, ctx) {
    const year = yearOf(args);
    const w = await buildTaxWorksheet({ year, personId: int(args.person_id), mayFinance: mayFinance(ctx) });
    const stored = await storeTaxWorksheetPdf(w, ctx.today);
    return {
      summary: `Ausfüllhilfe Steuer ${year} als Dokument abgelegt (${w.sections.length} Anlagen, ${w.bookingCount} Buchungen)`,
      route: `/dokumente/${stored.id}`,
      details: { document_id: stored.id, sections: w.sections.length, bookings: w.bookingCount },
    };
  },
};

/**
 * The worksheet as a PDF, stored as a document linked to the flagged
 * documents. The proposal above and the button on the Steuer page
 * (`tax-worksheet-api.ts`) both end here.
 */
export async function storeTaxWorksheetPdf(w: TaxWorksheet, today: string): Promise<{ id: number }> {
  const pdf = await renderTaxWorksheetPdf(w, today);
  return (await documents.storeGeneratedDocument({
    filename: `Ausfüllhilfe Steuer ${w.year}.pdf`,
    title: `Ausfüllhilfe Steuererklärung ${w.year}`,
    pdf_base64: pdf.toString("base64"),
    linked_document_ids: [...new Set(w.sections.flatMap((s) => s.documents.map((d) => d.id)))].slice(0, 200),
  })) as unknown as { id: number };
}

const FINANCE_AND_DOCUMENTS = ["module.finance", "finance.view", "module.documents", "documents.view"];

async function euerOf(args: Record<string, unknown>): Promise<{ id: number; r: EuerReport }> {
  const id = int(args.business_id);
  if (id === undefined) throw new Error("business_id is required (from list_businesses)");
  const year = yearOf(args);
  const r = (await finance.getBusinessEuer({ id, year })) as unknown as EuerReport;
  return { id, r };
}

export const euerPdf: WriteToolDefinition = {
  name: "euer_pdf",
  summary: "Propose the Einnahmen-Überschuss-Rechnung of one business and year as a PDF ('EÜR <Betrieb> <Jahr>'), stored as a document: the income and expense lines with their bookings, the AfA from the asset register, the totals and the result. Read it first with euer_report when the user wants to see the figures.",
  permissions: FINANCE_AND_DOCUMENTS,
  parameters: {
    type: "object",
    properties: {
      business_id: { type: "integer", description: "id from list_businesses" },
      year: { type: "integer", description: "the tax year, e.g. 2025" },
    },
    required: ["business_id", "year"],
  },
  async prepare(args) {
    const { id, r } = await euerOf(args);
    if (!r.booking_count && !r.afa.sum) throw new Error(`the EÜR ${r.year} of ${r.business} is empty: no booking of ${r.year} carries its tag and no asset is depreciated`);
    return {
      summary: `EÜR ${r.year} ${r.business} als PDF: ${r.booking_count} Buchungen, Einnahmen ${(r.total_income / 100).toFixed(2)} €, Ausgaben ${(r.total_expenses / 100).toFixed(2)} €, ${r.result >= 0 ? "Gewinn" : "Verlust"} ${(r.result / 100).toFixed(2)} €`,
      arguments: { business_id: id, year: r.year },
      count: r.booking_count,
      note: `${r.hints.length ? `Hints in the PDF: ${r.hints.join(" ")} ` : ""}The PDF is stored as a document.`,
    };
  },
  async execute(args, ctx) {
    const { id, r } = await euerOf(args);
    const pdf = createEuerPdf(r, ctx.today);
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
      pdf.end();
    });
    const stored = (await documents.storeGeneratedDocument({
      filename: `EÜR ${r.business} ${r.year}.pdf`,
      title: `Einnahmen-Überschuss-Rechnung ${r.year} ${r.business}`,
      pdf_base64: buffer.toString("base64"),
      linked_document_ids: [],
    })) as unknown as { id: number };
    return {
      summary: `EÜR ${r.year} ${r.business} als Dokument abgelegt (${r.result >= 0 ? "Gewinn" : "Verlust"} ${(r.result / 100).toFixed(2)} €)`,
      route: `/dokumente/${stored.id}`,
      details: { document_id: stored.id, business_id: id, year: r.year, result: r.result },
    };
  },
};
