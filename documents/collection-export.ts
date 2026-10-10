/**
 * Where a Sammelmappe's built PDF is kept, and how to tell it is out of date.
 *
 * The PDF is built in the background (collections.ts, `startCollectionExport`)
 * and kept on disk, one file per collection and reader: a group folder leaves
 * out what the particular reader may not open, so the file differs between
 * readers. It lives inside DOCUMENTS_DIR — writable by the process, like the
 * `_ocr` and `_thumbs` caches — and fsck skips the directory.
 *
 * Nothing invalidates the file on write. Instead every build records a
 * fingerprint of its inputs, and the status endpoint compares it with the
 * fingerprint of the folder as it is now. That catches every kind of change —
 * order, page selection, a member's new title or a re-scanned file, a member
 * the reader lost access to — without each mutation having to remember to
 * throw the file away.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DOCUMENTS_DIR } from "./documents.service";

console.log("[boot] documents/collection-export.ts: all imports resolved");

export const DOCUMENTS_COLLECTIONS_DIR = process.env.DOCUMENTS_COLLECTIONS_DIR
  ? path.resolve(process.env.DOCUMENTS_COLLECTIONS_DIR)
  : path.join(DOCUMENTS_DIR, "_collections");

export function collectionExportPath(collectionId: number, userId: number): string {
  return path.join(DOCUMENTS_COLLECTIONS_DIR, `${collectionId}-${userId}.pdf`);
}

/**
 * Write the bytes next to their final name and rename into place, so a
 * download running while the next build finishes never reads half a file.
 */
export async function writeCollectionExport(
  collectionId: number,
  userId: number,
  bytes: Buffer,
): Promise<void> {
  await fs.promises.mkdir(DOCUMENTS_COLLECTIONS_DIR, { recursive: true });
  const dest = collectionExportPath(collectionId, userId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, dest);
}

/** Remove every reader's file of a collection (on delete). */
export async function removeCollectionExports(collectionId: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(DOCUMENTS_COLLECTIONS_DIR);
  } catch {
    return;
  }
  const prefix = `${collectionId}-`;
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".pdf"))
      .map((name) =>
        fs.promises.rm(path.join(DOCUMENTS_COLLECTIONS_DIR, name), { force: true }).catch(() => {}),
      ),
  );
}

/** Everything a build reads, in the order it reads it. */
export interface CollectionExportInputs {
  title: string;
  notes: string | null;
  summary: string | null;
  include_cover: boolean;
  include_toc: boolean;
  include_summary: boolean;
  members: Array<{
    document_id: number;
    sha256: string;
    disk_path: string;
    receipt_ocr_state: string | null;
    title: string | null;
    original_filename: string;
    sender: string | null;
    doc_date: string | null;
    excluded_pages: number[];
  }>;
  /** Switched-on members the reader may not open. */
  not_visible: number[];
}

/** A stable digest of a build's inputs: equal digests, equal PDFs. */
export function collectionExportFingerprint(inputs: CollectionExportInputs): string {
  return crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}
