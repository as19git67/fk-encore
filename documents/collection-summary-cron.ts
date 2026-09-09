/**
 * Keeps every Sammelmappe's summary current.
 *
 * The summary is generated automatically after every change, but never on the
 * request that made the change: adding ten documents one after another would
 * otherwise mean ten model runs the user waits through, nine of them
 * describing a folder that has already moved on. The mutation sets
 * `summary_stale`; this job coalesces those into one run per collection.
 *
 * It runs often — a folder somebody just filled should carry its summary by
 * the time they open the export dialog — and does nothing at all when no
 * collection is stale, which is the normal case.
 *
 * Failures leave the collection stale on purpose. An llm-service that is down
 * must not cost the folder its previous, still-useful summary; the reason is
 * recorded in `summary_error` so a permanently broken setup is visible in the
 * UI instead of looking like a folder nobody has summarised yet.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { api } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import {
  documentCategories,
  documentCollectionItems,
  documentCollections,
  documents,
} from "../db/schema";
import {
  generateCollectionSummary,
  LlmServiceUnavailableError,
  type CollectionSummaryMember,
} from "./collection-summary";
import { everyMs, schedule } from "../lib/local-cron";

console.log("[boot] documents/collection-summary-cron.ts: all imports resolved");

/** Collections rewritten per run. Bounded so one busy user cannot starve the rest. */
const BATCH_SIZE = parseInt(process.env.DOCUMENTS_COLLECTION_SUMMARY_BATCH ?? "5", 10);

export interface CollectionSummaryRunResult {
  considered: number;
  written: number;
  failed: number;
  /** Collections left alone because they hold no documents yet. */
  emptied: number;
}

/**
 * Regenerate the summary of every stale collection, oldest change first.
 *
 * An empty collection gets its summary cleared rather than a model run: there
 * is nothing to summarise, and leaving the previous text would describe
 * documents that are no longer in the folder.
 */
export async function refreshStaleCollectionSummaries(
  limit = BATCH_SIZE,
): Promise<CollectionSummaryRunResult> {
  const stale = await dbAll<{
    id: number;
    title: string;
    notes: string | null;
  }>(
    db
      .select({
        id: documentCollections.id,
        title: documentCollections.title,
        notes: documentCollections.notes,
      })
      .from(documentCollections)
      .where(eq(documentCollections.summary_stale, true))
      .orderBy(asc(documentCollections.updated_at))
      .limit(limit),
  );

  const result: CollectionSummaryRunResult = {
    considered: stale.length,
    written: 0,
    failed: 0,
    emptied: 0,
  };

  for (const collection of stale) {
    const members = await dbAll<CollectionSummaryMember>(
      db
        .select({
          title: documents.title,
          sender: documents.sender,
          doc_date: documents.doc_date,
          category_name: documentCategories.name,
          summary: documents.summary,
        })
        .from(documentCollectionItems)
        .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
        .leftJoin(documentCategories, eq(documentCategories.id, documents.category_id))
        .where(
          and(
            eq(documentCollectionItems.collection_id, collection.id),
            eq(documentCollectionItems.included, true),
          ),
        )
        .orderBy(asc(documentCollectionItems.position)),
    );

    if (members.length === 0) {
      await dbExec(
        db
          .update(documentCollections)
          .set({
            summary: null,
            summary_stale: false,
            summary_error: null,
            summary_generated_at: sql`now()`,
          })
          .where(eq(documentCollections.id, collection.id)),
      );
      result.emptied++;
      continue;
    }

    try {
      const summary = await generateCollectionSummary({
        title: collection.title,
        notes: collection.notes,
        members,
      });
      await dbExec(
        db
          .update(documentCollections)
          .set({
            summary,
            summary_stale: false,
            summary_error: null,
            summary_generated_at: sql`now()`,
          })
          .where(eq(documentCollections.id, collection.id)),
      );
      result.written++;
    } catch (err) {
      const reason =
        err instanceof LlmServiceUnavailableError
          ? "llm-service nicht erreichbar"
          : ((err as Error)?.message ?? String(err));
      console.warn(
        `[documents] collection ${collection.id} summary failed: ${reason}`,
      );
      // Stays stale: the next run tries again, and the old summary survives.
      await dbExec(
        db
          .update(documentCollections)
          .set({ summary_error: reason.slice(0, 500) })
          .where(eq(documentCollections.id, collection.id)),
      );
      result.failed++;
    }
  }
  return result;
}

export const runCollectionSummaries = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/documents/collections/refresh-summaries",
  },
  async (): Promise<CollectionSummaryRunResult> => {
    return await refreshStaleCollectionSummaries();
  },
);

schedule({
  name: "documents-collection-summaries",
  description: "Rewrite the summary of every changed Sammelmappe",
  service: "documents",
  scheduleLabel: "every 5 minutes",
  nextFire: everyMs(5 * 60_000),
  run: () => runCollectionSummaries(),
});
