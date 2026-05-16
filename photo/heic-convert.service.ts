// HEIC → JPEG conversion. Extracted from photo.service.ts so that
// modules which need to read HEIC images (suggestion compute, the
// recipe render pipeline) can import this without going through
// photo.service — a static import there closes a cycle that broke
// Encore's analyzer at boot time on the e2e workflow.

import fs from "fs";
import { createRequire } from "module";
import { getHeicDecodeCached, setHeicDecodeCached } from "./heic-cache";

// heic-convert is a CJS module without TS types; load via createRequire
// in the same way photo.service did, so the runtime semantics are
// identical.
const _require = createRequire(import.meta.url);
type HeicConvertFn = (opts: {
  buffer: ArrayBuffer | Buffer;
  format: "JPEG" | "PNG";
  quality: number;
}) => Promise<ArrayBuffer>;
const heicConvert: HeicConvertFn = _require("heic-convert");

// HEIC/HEIF brands recognized by ISO/IEC 23008-12. Files with a `.heic`
// extension whose `ftyp` box advertises a different brand (or no `ftyp`
// at all — e.g. the iOS app occasionally uploads a JPEG with a HEIC
// filename) would otherwise crash heic-convert with "input buffer is
// not a HEIC image".
const HEIC_BRANDS = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2",
]);

export function isHeicBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  return HEIC_BRANDS.has(buf.toString("ascii", 8, 12));
}

/**
 * Decode a HEIC file at `filePath` into a JPEG buffer.
 *
 * Sharp's bundled libvips in this build lacks HEIC decode support; this
 * helper uses heic-convert (libheif via WASM) instead. Decoded buffers
 * are held in a small LRU keyed by (filePath, mtimeMs) so back-to-back
 * pipelines (quality, embedding, thumbnail prewarm, on-demand
 * /photos/file, auto-levels, render) that touch the same HEIC pay the
 * decode cost at most once.
 *
 * If the file's content turns out NOT to be HEIC despite the filename
 * — e.g. an iOS upload that snuck through with a .heic extension on a
 * JPEG body — the function falls back to sharp for a normalising
 * JPEG re-encode so callers always get a valid JPEG buffer back.
 */
export async function convertHeicToJpeg(filePath: string): Promise<Buffer> {
  let mtimeMs = 0;
  try {
    const st = await fs.promises.stat(filePath);
    mtimeMs = st.mtimeMs;
    const cached = getHeicDecodeCached(filePath, mtimeMs);
    if (cached) return cached;
  } catch {
    // stat failed — fall through, readFile below will report the real error
  }

  const inputBuffer = await fs.promises.readFile(filePath);
  let decoded: Buffer;
  if (isHeicBuffer(inputBuffer)) {
    const outputBuffer = await heicConvert({
      buffer: inputBuffer,
      format: "JPEG",
      quality: 0.9,
    });
    decoded = Buffer.from(outputBuffer);
  } else {
    // File extension claims HEIC but content is not. Re-encode via sharp so
    // the JPEG cache file written by the caller stays valid.
    const sharp = (await import("sharp")).default;
    decoded = await sharp(inputBuffer, { failOn: "none" })
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  if (mtimeMs > 0) setHeicDecodeCached(filePath, mtimeMs, decoded);
  return decoded;
}
