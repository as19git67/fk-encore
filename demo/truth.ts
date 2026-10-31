/**
 * How well the pipeline read the demo documents
 * (documentation/plans/demodaten.md, stage 2): each imported document
 * against what the generator knows about it (`demo_truth`). A document
 * still in the queue is counted as pending, not as a miss.
 */

import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { demoTruth, documentCategories, documents } from "../db/schema";
import type { TruthRecord } from "./doc-writer";

export type TruthField = "category" | "document_type" | "sender" | "date" | "tax_role";

export interface FieldScore {
  field: TruthField;
  /** Documents compared on this field (finished, and with a firm truth). */
  compared: number;
  hits: number;
}

export interface KindScore {
  kind: string;
  documents: number;
  /** Category hits among the finished ones. */
  category_hits: number;
  finished: number;
}

export interface TruthReport {
  documents: number;
  /** Still waiting for text extraction or classification. */
  pending: number;
  failed: number;
  fields: FieldScore[];
  kinds: KindScore[];
}

/** Letters and digits only, lower case: "Stadtwerke Musterstadt" ≈ "STADTWERKE MUSTERSTADT GmbH". */
function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function senderHit(truth: string, display: string | null, sender: string | null): boolean {
  const t = norm(truth);
  return [display, sender].some((v) => {
    const n = norm(v);
    return n.length >= 4 && (n.includes(t) || t.includes(n));
  });
}

/** A category is right when it is the expected one or a child of it. */
export function categoryHit(truth: string, slug: string | null): boolean {
  return slug !== null && (slug === truth || slug.startsWith(`${truth}-`));
}

export async function truthReport(runId: number): Promise<TruthReport> {
  const truths = await db
    .select({ document_id: demoTruth.document_id, kind: demoTruth.kind, truth: demoTruth.truth })
    .from(demoTruth)
    .where(eq(demoTruth.run_id, runId));
  const ids = truths.map((t) => t.document_id).filter((id): id is number => id !== null);
  const rows = ids.length
    ? await db
        .select({
          id: documents.id,
          status: documents.status,
          slug: documentCategories.slug,
          document_type: documents.document_type,
          sender: documents.sender,
          correspondent_display: documents.correspondent_display,
          doc_date: documents.doc_date,
          tax_role: documents.tax_role,
        })
        .from(documents)
        .leftJoin(documentCategories, and(eq(documentCategories.id, documents.category_id)))
        .where(inArray(documents.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const fields: Record<TruthField, FieldScore> = {
    category: { field: "category", compared: 0, hits: 0 },
    document_type: { field: "document_type", compared: 0, hits: 0 },
    sender: { field: "sender", compared: 0, hits: 0 },
    date: { field: "date", compared: 0, hits: 0 },
    tax_role: { field: "tax_role", compared: 0, hits: 0 },
  };
  const kinds = new Map<string, KindScore>();
  let pending = 0;
  let failed = 0;
  let present = 0;

  for (const t of truths) {
    const doc = t.document_id === null ? undefined : byId.get(t.document_id);
    if (!doc) continue; // deleted by hand since
    present += 1;
    const k = kinds.get(t.kind) ?? { kind: t.kind, documents: 0, category_hits: 0, finished: 0 };
    kinds.set(t.kind, k);
    k.documents += 1;
    if (doc.status === "failed") {
      failed += 1;
      continue;
    }
    if (doc.status !== "ready") {
      pending += 1;
      continue;
    }
    const truth = t.truth as unknown as TruthRecord;
    k.finished += 1;
    const score = (field: TruthField, hit: boolean) => {
      fields[field].compared += 1;
      if (hit) fields[field].hits += 1;
    };
    const cat = categoryHit(truth.category, doc.slug);
    score("category", cat);
    if (cat) k.category_hits += 1;
    score("document_type", doc.document_type === truth.document_type);
    score("sender", senderHit(truth.sender, doc.correspondent_display, doc.sender));
    score("date", (doc.doc_date ?? "").slice(0, 10) === truth.date);
    if (truth.tax_role) score("tax_role", doc.tax_role === truth.tax_role);
  }

  return {
    documents: present,
    pending,
    failed,
    fields: Object.values(fields),
    kinds: [...kinds.values()].sort((a, b) => b.documents - a.documents),
  };
}
