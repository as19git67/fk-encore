/**
 * Deletes a document with everything on disk that belongs to it: the tax
 * hardlinks, the file, the folders it leaves empty, the thumbnail and the
 * searchable PDF. The rows that hang off the document (tags, tax values,
 * links, queue jobs) go with it by foreign key.
 *
 * Used by `DELETE /documents/:id` after its access check and by the demo
 * data's removal (demo/remove.ts), which removes what it imported.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { documents } from "../db/schema";
import { assertPathUnderDocumentsRoot, pruneEmptyDirs } from "./documents.service";
import { removeOcrPdf } from "./ocr-pdf";
import { dropTaxLinks } from "./relocate";
import { removeThumbnail } from "./thumbnail";

export async function purgeDocument(id: number): Promise<void> {
  const [row] = await db.select({ disk_path: documents.disk_path }).from(documents).where(eq(documents.id, id));
  if (!row) return;
  // Drop tax hardlinks first so we don't leave dangling entries under
  // `_steuer/` after the canonical inode is freed.
  try {
    await dropTaxLinks(id);
  } catch (err) {
    console.warn(`[documents] delete: dropTaxLinks(${id}) failed: ${(err as Error).message}`);
  }
  await db.delete(documents).where(eq(documents.id, id));
  try {
    assertPathUnderDocumentsRoot(row.disk_path);
    await fs.promises.unlink(row.disk_path).catch(() => {});
    await pruneEmptyDirs(path.dirname(row.disk_path));
  } catch (err) {
    console.warn(`[documents] delete: failed to unlink ${row.disk_path}: ${(err as Error).message}`);
  }
  await removeThumbnail(id);
  await removeOcrPdf(id);
}
