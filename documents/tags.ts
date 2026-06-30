import { inArray, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documentTagLinks, documentTags } from "../db/schema";

export async function fetchTagsForDocuments(ids: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (ids.length === 0) return map;
  const rows = await dbAll<{ document_id: number; name: string }>(
    db
      .select({ document_id: documentTagLinks.document_id, name: documentTags.name })
      .from(documentTagLinks)
      .innerJoin(documentTags, eq(documentTagLinks.tag_id, documentTags.id))
      .where(inArray(documentTagLinks.document_id, ids)),
  );
  for (const row of rows) {
    const tags = map.get(row.document_id) ?? [];
    tags.push(row.name);
    map.set(row.document_id, tags);
  }
  return map;
}
