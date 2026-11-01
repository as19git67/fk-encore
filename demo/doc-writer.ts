/**
 * Lays the demo documents down (documentation/plans/demodaten.md, stage 2):
 * each planned document is worded (template or model), rendered to a PDF
 * and imported through `importDocumentFromPath` — the helper the inbox
 * watcher uses — with nothing prefilled, so text extraction,
 * classification, reference numbers, tax values and duplicate detection
 * run as for any upload. What the generator knows about the document goes
 * into `demo_truth` next to it, to measure the pipeline against later.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import db from "../db/database";
import { demoTruth } from "../db/schema";
import { DuplicateDocumentError, importDocumentFromPath } from "../documents/import";
import { llmTexts } from "./doc-text-llm";
import type { DocumentPlan, PlannedDocument } from "./documents";
import { layoutDocument, renderPdf, renderScanPdf, templateTexts } from "./pdf-render";
import { createRandom } from "./random";
import { register } from "./registry";
import { DemoCancelled, type WriteHooks } from "./writer";

export type TextSource = "template" | "llm";

export interface WrittenDocuments {
  documents: number;
  /** How many the model worded; the rest kept the template. */
  worded: number;
  scans: number;
}

/** What `demo_truth.truth` holds for a document. */
export interface TruthRecord {
  key: string;
  category: string;
  document_type: string;
  tax_role: string | null;
  sender: string;
  date: string;
  total_cents: number | null;
  booking_id: number | null;
  scan: boolean;
  worded_by: TextSource;
}

/** A name as a scanner or a download would give it: says nothing about the content. */
function fileName(doc: PlannedDocument, n: number): string {
  const stamp = doc.date.replace(/-/g, "");
  return doc.scan ? `Scan_${stamp}_${String(n).padStart(4, "0")}.pdf` : `Dokument_${stamp}_${String(n).padStart(4, "0")}.pdf`;
}

export async function writeDocuments(
  runId: number,
  ownerId: number,
  seed: number,
  plan: DocumentPlan,
  bookingIds: number[],
  text: TextSource,
  hooks: WriteHooks = {},
): Promise<WrittenDocuments> {
  const rnd = createRandom(seed ^ 0x5ca7);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `fk-demo-${runId}-`));
  let written = 0;
  let worded = 0;
  let scans = 0;
  try {
    for (const [i, doc] of plan.documents.entries()) {
      if (hooks.cancelled && i % 10 === 0 && (await hooks.cancelled())) throw new DemoCancelled();
      const modelTexts = text === "llm" ? await llmTexts(doc) : null;
      const texts = modelTexts ?? templateTexts(doc);
      const pages = layoutDocument(doc, texts);
      const pdf = doc.scan ? await renderScanPdf(pages, rnd, texts.subject) : await renderPdf(pages, texts.subject);
      const name = fileName(doc, i + 1);
      const file = path.join(dir, name);
      await fs.writeFile(file, pdf);

      let documentId: number;
      try {
        documentId = (await importDocumentFromPath({ userId: ownerId, sourcePath: file, originalFilename: name, sourceFolder: "Demodaten" })).id;
      } catch (err) {
        // Two identical PDFs would be one document; the plan never makes them, so skip rather than fail.
        if (err instanceof DuplicateDocumentError) continue;
        throw err;
      }
      // Registered right away: if a later document fails, removal still finds this one.
      await register(runId, "documents", [documentId]);
      const truth: TruthRecord = {
        key: doc.key,
        category: doc.truth.category,
        document_type: doc.truth.documentType,
        tax_role: doc.truth.taxRole,
        sender: doc.sender,
        date: doc.date,
        total_cents: doc.totalCents,
        booking_id: doc.booking === null ? null : (bookingIds[doc.booking] ?? null),
        scan: doc.scan,
        worded_by: modelTexts ? "llm" : "template",
      };
      await db.insert(demoTruth).values({ run_id: runId, document_id: documentId, kind: doc.kind, truth: truth as unknown as Record<string, unknown> });
      written += 1;
      if (modelTexts) worded += 1;
      if (doc.scan) scans += 1;
      if (written % 5 === 0 || i === plan.documents.length - 1) await hooks.progress?.(i + 1, plan.documents.length);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { documents: written, worded, scans };
}
