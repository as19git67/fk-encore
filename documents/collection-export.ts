/**
 * Where a Sammelmappe's built PDF is kept, and how to tell it is out of date.
 *
 * The PDF is built in the background (collections.ts, `startCollectionExport`)
 * and kept on disk, one file per collection and reader: a group folder leaves
 * out what the particular reader may not open, so the file differs between
 * readers. It lives inside DOCUMENTS_DIR — writable by the process, like the
 * `_ocr` and `_thumbs` caches — and fsck skips the directory.
 *
 * A kept file is only ever the folder as it is now. Every change to the
 * folder itself — title, note, switches, members, order, page selection, a
 * rule run, a new summary — throws its files away on the spot
 * (`discardCollectionExports`). Changes that happen to a *member* instead (a
 * new title, a re-scanned file, access lost) are not tracked from the
 * document side; every build records a fingerprint of its inputs, and the
 * status check throws the file away the moment the folder no longer matches
 * it. A stale PDF is therefore never offered.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { and, eq, ne } from "drizzle-orm";
import db from "../db/database";
import { dbExec } from "../db/adapter";
import { documentCollectionExports } from "../db/schema";
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

/**
 * The folder changed: every reader's kept PDF of it is gone. A build still
 * running keeps its row; what it writes is caught by the fingerprint check.
 */
export async function discardCollectionExports(collectionId: number): Promise<void> {
  await dbExec(
    db
      .delete(documentCollectionExports)
      .where(
        and(
          eq(documentCollectionExports.collection_id, collectionId),
          ne(documentCollectionExports.status, "running"),
        ),
      ),
  );
  await removeCollectionExports(collectionId);
}

/** Remove one reader's kept file. */
export async function removeCollectionExport(collectionId: number, userId: number): Promise<void> {
  await fs.promises.rm(collectionExportPath(collectionId, userId), { force: true }).catch(() => {});
}

/** Remove every reader's file of a collection. */
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
    redactions: Array<{ page: number; x: number; y: number; w: number; h: number }>;
  }>;
  /** Switched-on members the reader may not open. */
  not_visible: number[];
}

/** A stable digest of a build's inputs: equal digests, equal PDFs. */
export function collectionExportFingerprint(inputs: CollectionExportInputs): string {
  return crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}
