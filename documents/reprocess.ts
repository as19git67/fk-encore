import { inArray } from "drizzle-orm";
import db from "../db/database";
import { documents } from "../db/schema";
import { requeueDocument } from "./scan-queue";

/**
 * "Nur klassifizieren" for a batch of documents: the extracted text stays,
 * only classification and the embedding run again. A document without text
 * has nothing to classify from, so it starts with text extraction instead.
 *
 * The caller has already narrowed `rows` to the documents it may see, and
 * wakes the workers afterwards.
 */
export async function requeueClassifyOnly(
  rows: readonly { id: number; has_text: boolean }[],
): Promise<{ classified: number; extractedFirst: number }> {
  const withText = rows.filter((r) => r.has_text).map((r) => r.id);
  const withoutText = rows.filter((r) => !r.has_text).map((r) => r.id);
  if (withText.length) {
    await db
      .update(documents)
      .set({ status: "classifying", last_error: null })
      .where(inArray(documents.id, withText));
    for (const id of withText) await requeueDocument(id, ["classify", "embed"]);
  }
  if (withoutText.length) {
    await db
      .update(documents)
      .set({ status: "pending", last_error: null })
      .where(inArray(documents.id, withoutText));
    for (const id of withoutText) await requeueDocument(id);
  }
  return { classified: withText.length, extractedFirst: withoutText.length };
}
