/**
 * Shared helpers that both the UI upload endpoint and the inbox
 * watcher use to persist a PDF into the documents store.
 *
 * Keeping them out of `documents.ts` avoids the watcher having to
 * pull in the Encore API layer (api.raw, getAuthData, …) — the
 * watcher runs as a plain Node side-effect from the service boot.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { documents } from "../db/schema";
import {
  DOCUMENTS_MAX_BYTES,
  assertPathUnderDocumentsRoot,
  ensureDir,
  getDocumentDiskPath,
  guessExtension,
} from "./documents.service";
import { enqueueDocumentScan } from "./scan-queue";

export interface ImportedDocument {
  id: number;
  sha256: string;
  disk_path: string;
  status: typeof documents.$inferSelect["status"];
}

/** Thrown when the file already exists in the documents table. */
export class DuplicateDocumentError extends Error {
  readonly existingId: number;
  constructor(existingId: number) {
    super("DOCUMENT_ALREADY_EXISTS");
    this.name = "DuplicateDocumentError";
    this.existingId = existingId;
  }
}

/**
 * Import a PDF that is already on disk (typical inbox flow: the file
 * arrived via rsync/scp).
 *
 * The source file is read, hashed, and *moved* (not copied) into the
 * final DOCUMENTS_DIR slot. A duplicate digest raises
 * `DuplicateDocumentError` and the source file is removed so the
 * inbox doesn't keep re-firing the watcher on the same blob.
 */
export async function importDocumentFromPath(params: {
  userId: number;
  sourcePath: string;
  originalFilename: string;
  mimeType?: string;
}): Promise<ImportedDocument> {
  const { userId, sourcePath } = params;
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) throw new Error(`not a file: ${sourcePath}`);
  if (stat.size === 0) throw new Error(`empty file: ${sourcePath}`);
  if (stat.size > DOCUMENTS_MAX_BYTES) {
    throw new Error(`DOCUMENT_TOO_LARGE (${stat.size} bytes, max ${DOCUMENTS_MAX_BYTES})`);
  }

  const mimeType = params.mimeType ?? "application/pdf";
  const originalFilename = params.originalFilename || path.basename(sourcePath);
  const ext = guessExtension(originalFilename, mimeType);
  const digest = await hashFile(sourcePath);

  const existing = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.sha256, digest)),
  );
  if (existing) {
    // Best-effort cleanup of the duplicate source. Log but don't
    // rethrow — the caller decides what to do.
    await fs.promises.unlink(sourcePath).catch(() => {});
    throw new DuplicateDocumentError(existing.id);
  }

  const { absPath, dirAbs } = getDocumentDiskPath(digest, ext, new Date());
  assertPathUnderDocumentsRoot(absPath);
  await ensureDir(dirAbs);
  await moveFile(sourcePath, absPath);

  const row = await dbFirst<typeof documents.$inferSelect>(
    db
      .insert(documents)
      .values({
        user_id: userId,
        sha256: digest,
        original_filename: originalFilename,
        mime_type: mimeType,
        size_bytes: stat.size,
        disk_path: absPath,
      })
      .returning(),
  );
  if (!row) throw new Error("insert documents: no row returned");

  await enqueueDocumentScan(row.id);

  return {
    id: row.id,
    sha256: digest,
    disk_path: row.disk_path,
    status: row.status,
  };
}

async function hashFile(absPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Move a file across filesystem boundaries. `fs.rename` fails with
 * EXDEV when src and dst live on different devices — the inbox mount
 * and DOCUMENTS_DIR mount are often separate in production — so fall
 * back to copy+unlink.
 */
async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
  }
  await fs.promises.copyFile(src, dst);
  await fs.promises.unlink(src);
}
