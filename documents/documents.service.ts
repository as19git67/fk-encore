/**
 * Storage-layout helpers and constants for the documents module.
 *
 * Documents live under `DOCUMENTS_DIR`, sharded by upload date
 * (YYYY/YYYY-MM/) with the file name set to the sha256 digest of the
 * content plus an extension. The sha256 also acts as a global dedup key
 * (unique in the `documents` table) so the same PDF cannot be imported
 * twice regardless of which user uploaded it.
 *
 * Inbox imports land in the same directory structure; the watcher just
 * picks up files from `DOCUMENTS_INBOX_DIR` and hands them to the same
 * import pipeline as the UI upload endpoint.
 */

import fs from "fs";
import path from "path";

console.log("[boot] documents/documents.service.ts: all imports resolved");

export const DOCUMENTS_DIR = path.resolve(
  process.env.DOCUMENTS_DIR || "uploads/documents",
);

export const DOCUMENTS_INBOX_DIR = path.resolve(
  process.env.DOCUMENTS_INBOX_DIR || "uploads/documents-inbox",
);

/** Hard upload limit in bytes (default 50 MB). */
export const DOCUMENTS_MAX_BYTES =
  parseInt(process.env.DOCUMENTS_MAX_SIZE_MB ?? "50", 10) * 1024 * 1024;

/** Only PDFs for now — scanners always emit PDF. */
export const SUPPORTED_MIME_TYPES = new Set(["application/pdf"]);
export const SUPPORTED_EXTENSIONS = new Set([".pdf"]);

export function guessExtension(filename: string, mimeType: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(ext)) return ext;
  if (mimeType === "application/pdf") return ".pdf";
  return ext || ".bin";
}

/**
 * Resolve the absolute on-disk path for a document given its sha256
 * digest and a reference timestamp (ISO string or Date). The returned
 * path always lives under DOCUMENTS_DIR and uses the YYYY/YYYY-MM/
 * shard layout.
 */
export function getDocumentDiskPath(
  sha256: string,
  ext: string,
  when: Date | string = new Date(),
): { absPath: string; relPath: string; dirAbs: string } {
  const d = when instanceof Date ? when : new Date(when);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const relDir = path.join(year, `${year}-${month}`);
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const relPath = path.join(relDir, `${sha256}${safeExt}`);
  const absPath = path.join(DOCUMENTS_DIR, relPath);
  const dirAbs = path.join(DOCUMENTS_DIR, relDir);
  return { absPath, relPath, dirAbs };
}

/**
 * Path-traversal guard: make sure the provided absolute path really
 * lives under DOCUMENTS_DIR. Used before any fs operation on a row's
 * disk_path so a poisoned DB entry cannot trick the service into
 * touching files outside the document root.
 */
export function assertPathUnderDocumentsRoot(absPath: string): void {
  const resolved = path.resolve(absPath);
  const root = path.resolve(DOCUMENTS_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`document path outside DOCUMENTS_DIR: ${absPath}`);
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
