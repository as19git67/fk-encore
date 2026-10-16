/**
 * Filling in the tax return (documentation/plans/ki-assistent.md): the
 * worksheet that arranges what the household holds the way the forms ask
 * for it, as a reading for the model and as a PDF the user keeps next to
 * ELSTER. The figures come from `assistant/tax-worksheet.ts`; nothing here
 * is the model's arithmetic.
 */

import { documents } from "~encore/clients";
import { int, str } from "../format";
import type { WriteToolDefinition } from "../proposals";
import { buildTaxWorksheet, worksheetText } from "../tax-worksheet";
import { renderTaxWorksheetPdf } from "../tax-worksheet-pdf";
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
  summary: "The worksheet for filling in one year's tax return: per Anlage the flagged documents with the amount recognised in each and the sum, the bookings marked tax-relevant in the year summed by tag, the depot's income, gains and taxes of the year, and hints (an Anlage that had documents last year but none yet, documents without a recognised amount). For the PDF of it, tax_worksheet_pdf.",
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
      section: s.name, title: d.title, date: d.date, from: d.from, amount: d.amount, id: d.id, route: `/dokumente/${d.id}`,
    })));
    const ids = [...new Set(rows.map((r) => r.id))];
    return {
      text: worksheetText(w),
      digest: `[earlier result of tax_worksheet: ${year}, ${w.documentCount} documents in ${w.sections.length} Anlagen, ${w.bookingCount} bookings]`,
      rowCount: w.documentCount,
      ref: ids.length ? { type: "document", ids } : undefined,
      block: {
        kind: "documents",
        tool: "tax_worksheet",
        total: ids.length,
        subtitle: `Ausfüllhilfe ${year} · ${w.sections.length} Anlagen · ${w.bookingCount} Buchungen`,
        rows,
        route: `/dokumente/steuer?year=${year}`,
      },
    };
  },
};

export const taxWorksheetPdf: WriteToolDefinition = {
  name: "tax_worksheet_pdf",
  summary: "Propose the worksheet for one year's tax return as a PDF ('Ausfüllhilfe Steuer <Jahr>'), stored as a document linked to the flagged documents: per Anlage the documents with their recognised amounts and sums, the tax-relevant bookings by tag, the depot's figures and the hints.",
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
    const personId = int(args.person_id);
    const w = await buildTaxWorksheet({ year, personId, mayFinance: mayFinance(ctx) });
    const pdf = await renderTaxWorksheetPdf(w, ctx.today);
    const stored = (await documents.storeGeneratedDocument({
      filename: `Ausfüllhilfe Steuer ${year}.pdf`,
      title: `Ausfüllhilfe Steuererklärung ${year}`,
      pdf_base64: pdf.toString("base64"),
      linked_document_ids: [...new Set(w.sections.flatMap((s) => s.documents.map((d) => d.id)))].slice(0, 200),
    })) as unknown as { id: number };
    return {
      summary: `Ausfüllhilfe Steuer ${year} als Dokument abgelegt (${w.sections.length} Anlagen, ${w.bookingCount} Buchungen)`,
      route: `/dokumente/${stored.id}`,
      details: { document_id: stored.id, sections: w.sections.length, bookings: w.bookingCount },
    };
  },
};
