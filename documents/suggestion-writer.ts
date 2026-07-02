/**
 * Producer for `document_category_suggestions` — previously an unpopulated
 * table with list/accept/reject endpoints and a frontend view but no writer.
 *
 * Signal: when a document from a real, recurring sender keeps landing in the
 * catch-all `sonstiges` bucket, that is evidence the taxonomy is *missing* a
 * category for that sender — exactly what this admin-facing table is for
 * (accepting a suggestion creates a new `document_categories` row).
 *
 * We accumulate one open suggestion per sender (deduplicated by a machine
 * marker in `rationale`) and append example document ids to it. Best-effort:
 * a failure here must never break the classify pipeline.
 */

import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documentCategorySuggestions } from "../db/schema";
import { normalizeForMatch } from "./sender-rules";

/** Prefix that tags an auto-generated (sender-driven) suggestion's rationale so
 *  repeated hits from the same sender collapse into one suggestion. */
export const AUTO_SENDER_MARKER = "auto-sender:";

/** Cap the example list so a chronically-uncategorized sender can't grow an
 *  unbounded array. */
const MAX_EXAMPLES = 20;

export interface OpenSuggestion {
  id: number;
  rationale: string | null;
  example_document_ids: number[];
}

export type SuggestionPlan =
  | { kind: "noop" }
  | { kind: "insert"; marker: string }
  | { kind: "append"; id: number; exampleIds: number[] };

/**
 * Decide whether to insert a new suggestion or append the document to an
 * existing open one for the same sender. Pure so it is unit-tested without a DB.
 */
export function planSuggestion(
  open: readonly OpenSuggestion[],
  sender: string | null | undefined,
  documentId: number,
): SuggestionPlan {
  const key = normalizeForMatch(sender);
  if (!key) return { kind: "noop" };
  const marker = `${AUTO_SENDER_MARKER}${key}`;

  const existing = open.find((s) => (s.rationale ?? "").startsWith(marker));
  if (!existing) return { kind: "insert", marker };

  if (existing.example_document_ids.includes(documentId)) return { kind: "noop" };
  const exampleIds = [...existing.example_document_ids, documentId].slice(-MAX_EXAMPLES);
  return { kind: "append", id: existing.id, exampleIds };
}

/** Human-readable rationale carrying the dedup marker as its prefix. */
export function suggestionRationale(marker: string, sender: string): string {
  return `${marker} — Dokumente von „${sender.trim()}" landen wiederholt in „Sonstiges"; ggf. eigene Kategorie anlegen.`;
}

/**
 * Record that a document fell into `sonstiges`. Inserts or grows the per-sender
 * suggestion. Best-effort — errors are logged and swallowed.
 */
export async function recordUncategorizedDocument(params: {
  documentId: number;
  sender: string | null | undefined;
}): Promise<void> {
  const { documentId, sender } = params;
  if (!normalizeForMatch(sender)) return;
  try {
    const open = await dbAll<OpenSuggestion>(
      db
        .select({
          id: documentCategorySuggestions.id,
          rationale: documentCategorySuggestions.rationale,
          example_document_ids: documentCategorySuggestions.example_document_ids,
        })
        .from(documentCategorySuggestions)
        .where(eq(documentCategorySuggestions.status, "open")),
    );

    const plan = planSuggestion(open, sender, documentId);
    if (plan.kind === "noop") return;

    if (plan.kind === "insert") {
      await db.insert(documentCategorySuggestions).values({
        suggested_name: (sender ?? "").trim().slice(0, 120),
        parent_slug: null,
        example_document_ids: [documentId],
        rationale: suggestionRationale(plan.marker, sender ?? ""),
        status: "open",
      });
      return;
    }

    await db
      .update(documentCategorySuggestions)
      .set({ example_document_ids: plan.exampleIds })
      .where(eq(documentCategorySuggestions.id, plan.id));
  } catch (err) {
    console.warn(
      `[documents] recordUncategorizedDocument(${documentId}) failed: ${(err as Error).message}`,
    );
  }
}
