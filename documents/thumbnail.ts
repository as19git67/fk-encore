/**
 * Preview-thumbnail cache for documents.
 *
 * The documents grid (#632) shows a small raster preview of page 1 of
 * each PDF, mirroring the photo grid. Rendering a PDF page on the fly
 * for every visible grid cell would be far too expensive, so we keep a
 * persistent cache of pre-rendered WebP thumbnails under
 * `DOCUMENTS_THUMBS_DIR`, keyed by document id.
 *
 * The cache is warmed during the scan pipeline (see `runTextExtract` in
 * document-ops.ts) so freshly-scanned documents already have a preview,
 * and `ensureThumbnail` rebuilds lazily on first request for documents
 * that were imported before this feature existed.
 *
 * Document bytes are immutable per id (the sha256 digest is the dedup
 * key and never changes for a given row), so a cached `<id>.webp` never
 * goes stale and only needs removing when the document is hard-deleted.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import sharp from "sharp";
import { assertPathUnderDocumentsRoot } from "./documents.service";

console.log("[boot] documents/thumbnail.ts: all imports resolved");

/** On-disk cache for rendered preview thumbnails. */
export const DOCUMENTS_THUMBS_DIR = path.resolve(
  process.env.DOCUMENTS_THUMBS_DIR || "uploads/documents-thumbs",
);

/** Target width of the cached thumbnail in CSS pixels (×DPR handled client-side). */
const THUMB_WIDTH = parseInt(process.env.DOCUMENTS_THUMB_WIDTH ?? "480", 10);

/** Render DPI for pdftoppm. 96 is plenty for a 480px-wide preview. */
const THUMB_DPI = parseInt(process.env.DOCUMENTS_THUMB_DPI ?? "96", 10);

export function thumbnailFilePath(documentId: number): string {
  return path.join(DOCUMENTS_THUMBS_DIR, `${documentId}.webp`);
}

/** Render page 1 of `pdfPath` to a single PNG at `<outPrefix>.png`. */
function renderFirstPage(pdfPath: string, outPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pdftoppm",
      ["-f", "1", "-l", "1", "-r", String(THUMB_DPI), "-png", "-singlefile", pdfPath, outPrefix],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the thumbnail for `documentId` from the PDF at `diskPath` and
 * write it to the cache. Best-effort: returns the cache path on success
 * or null when the source can't be rendered (e.g. corrupt PDF, missing
 * poppler). Never throws — callers fall back to a generic icon.
 */
export async function buildThumbnail(
  documentId: number,
  diskPath: string,
): Promise<string | null> {
  const dest = thumbnailFilePath(documentId);
  let tmpDir: string | null = null;
  try {
    assertPathUnderDocumentsRoot(diskPath);
    await fs.promises.mkdir(DOCUMENTS_THUMBS_DIR, { recursive: true });
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "doc-thumb-"));
    const outPrefix = path.join(tmpDir, "page");
    await renderFirstPage(diskPath, outPrefix);
    const png = `${outPrefix}.png`;
    if (!(await fileExists(png))) return null;

    await sharp(png, { failOn: "none" })
      .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(dest);
    return dest;
  } catch (err) {
    console.warn(
      `[documents.thumbnail] failed to build thumbnail for document ${documentId}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    if (tmpDir) {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Return the cache path for `documentId`'s thumbnail, building it from
 * `diskPath` if it does not yet exist. Returns null when the thumbnail
 * cannot be produced.
 */
export async function ensureThumbnail(
  documentId: number,
  diskPath: string,
): Promise<string | null> {
  const dest = thumbnailFilePath(documentId);
  if (await fileExists(dest)) return dest;
  return buildThumbnail(documentId, diskPath);
}

/** Remove a cached thumbnail. Best-effort; safe to call when absent. */
export async function removeThumbnail(documentId: number): Promise<void> {
  await fs.promises.rm(thumbnailFilePath(documentId), { force: true }).catch(() => {});
}
