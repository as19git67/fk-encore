/**
 * Cache of the PDF actually served for a document, when that differs from the
 * file the user uploaded. Two things can put an entry here:
 *
 *  1. **A searchable ("sandwich") PDF.** For PDFs that lack a usable text
 *     layer (plain image scans), the OCR pass bakes an invisible, positioned
 *     text layer onto the rasterized pages — see `buildSearchablePdf` in
 *     `text-extract.ts`. That lets the in-app viewer select/copy text directly
 *     on the scanned page, and is what the download endpoint hands out so an
 *     exported file always carries a text layer. Those pages are also turned
 *     upright on the way (`ocr-preprocess.ts`).
 *
 *  2. **An upright copy.** A born-digital PDF needs no text layer, but can
 *     still be drawn sideways on its page — a wide table exported to A4
 *     portrait being the usual reason. `pdf-rotate.ts` detects that and writes
 *     a copy carrying the right `/Rotate`, losslessly, so the reader no longer
 *     has to tilt their head. The crisp original text is preserved; nothing is
 *     rasterized.
 *
 * A document that is neither gets no entry, and the original is served.
 *
 * Like the thumbnail cache, these are derived artifacts keyed by document
 * id and stored under a `_ocr` subdirectory of DOCUMENTS_DIR. Document
 * bytes are immutable per id (the sha256 digest is the dedup key and never
 * changes for a row), so a cached `<id>.pdf` never goes stale — it only
 * needs rebuilding when the file is replaced and removing on hard-delete.
 */

import fs from "fs";
import path from "path";
import { assertPathUnderDocumentsRoot, DOCUMENTS_DIR } from "./documents.service";
import { buildSearchablePdf, hasUsableTextLayer } from "./text-extract";
import { buildUprightPdf } from "./pdf-rotate";

console.log("[boot] documents/ocr-pdf.ts: all imports resolved");

/**
 * On-disk cache for generated searchable PDFs. Lives inside DOCUMENTS_DIR
 * (writable by the process) as an `_ocr` subdirectory, mirroring the
 * `_thumbs` cache.
 */
export const DOCUMENTS_OCR_DIR = process.env.DOCUMENTS_OCR_DIR
  ? path.resolve(process.env.DOCUMENTS_OCR_DIR)
  : path.join(DOCUMENTS_DIR, "_ocr");

export function ocrPdfFilePath(documentId: number): string {
  return path.join(DOCUMENTS_OCR_DIR, `${documentId}.pdf`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Persist already-built searchable PDF bytes to the cache. */
export async function writeOcrPdf(documentId: number, bytes: Buffer): Promise<string> {
  await fs.promises.mkdir(DOCUMENTS_OCR_DIR, { recursive: true });
  const dest = ocrPdfFilePath(documentId);
  await fs.promises.writeFile(dest, bytes);
  return dest;
}

/**
 * Return the cached PDF to serve for `documentId`, building it from the PDF
 * at `diskPath` if absent. Returns null when the original is the right thing
 * to serve — it already has a text layer and its pages are upright — or when
 * neither derived form could be produced. Best-effort: never throws.
 */
export async function ensureSearchablePdf(
  documentId: number,
  diskPath: string,
): Promise<string | null> {
  const dest = ocrPdfFilePath(documentId);
  if (await fileExists(dest)) return dest;

  try {
    assertPathUnderDocumentsRoot(diskPath);
    // A born-digital PDF is already selectable; don't pay for OCR. It may
    // still be drawn sideways, which a lossless /Rotate fixes without
    // touching its text.
    if (await hasUsableTextLayer(diskPath)) {
      return (await buildUprightPdf(diskPath, dest)) ? dest : null;
    }

    const bytes = await buildSearchablePdf(diskPath);
    if (!bytes || bytes.length === 0) return null;
    return await writeOcrPdf(documentId, bytes);
  } catch (err) {
    console.warn(
      `[documents.ocr-pdf] failed to build derived PDF for document ${documentId}: ${(err as Error).message}`,
    );
    return null;
  }
}

/** Remove a cached searchable PDF. Best-effort; safe to call when absent. */
export async function removeOcrPdf(documentId: number): Promise<void> {
  await fs.promises.rm(ocrPdfFilePath(documentId), { force: true }).catch(() => {});
}
