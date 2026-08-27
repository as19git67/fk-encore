import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  PageRotationSampler,
  isReusableRotation,
  readPngAspect,
  type RotationDetection,
} from "./ocr-preprocess";

/**
 * Write just enough PNG for `readPngAspect`: the 8-byte signature and an
 * IHDR whose width/height sit at offsets 16 and 20.
 */
function writePngHeader(dir: string, name: string, width: number, height: number): string {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * Rotation detection is a full Tesseract start-up per page (`--psm 0`),
 * measured at ~1.6 s against ~1.8 s for the recognition pass that actually
 * produces text. Run on every page it dominated the OCR stage: 14.5 s of
 * rotation against 21.6 s of recognition on a five-page scan. Reusing one
 * confident upright verdict across the document took that to 3.7 s (−74 %)
 * with byte-identical output.
 *
 * What these tests protect is the *asymmetry* that makes the reuse safe.
 * Extending "upright" too far leaves a page unrotated — the behaviour from
 * before auto-rotate existed. Extending "90°" too far would spin a page that
 * was already fine and destroy text that reads perfectly today. If a future
 * change starts caching non-zero angles, or caches a verdict that was really
 * a failure falling back to 0, the saving stays and the safety quietly does
 * not.
 */

describe("documents.ocr-preprocess isReusableRotation", () => {
  const reusable = (d: RotationDetection) => isReusableRotation(d, true);

  it("reuses a confident upright verdict — the case worth optimizing", () => {
    expect(reusable({ rotate: 0, confident: true })).toBe(true);
  });

  it("never reuses a rotation, however confident", () => {
    // Applying this to a page that was already upright destroys it. The
    // saving is not worth that, so rotated documents keep paying per page.
    for (const rotate of [90, 180, 270]) {
      expect(reusable({ rotate, confident: true }), `${rotate}°`).toBe(false);
    }
  });

  it("does not reuse a 0 that stands for 'could not tell'", () => {
    // detectOcrRotation returns 0 for a missing osd model, a tesseract
    // error, a below-threshold reading and a rejected probe alike. Only the
    // confident flag separates knowledge from a shrug.
    expect(reusable({ rotate: 0, confident: false })).toBe(false);
  });

  it("can be switched off entirely", () => {
    expect(isReusableRotation({ rotate: 0, confident: true }, false)).toBe(false);
  });
});

describe("documents.ocr-preprocess readPngAspect", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fk-aspect-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads portrait and landscape from the IHDR chunk", async () => {
    await expect(readPngAspect(writePngHeader(tmp, "p.png", 1700, 2339))).resolves.toBe("portrait");
    await expect(readPngAspect(writePngHeader(tmp, "l.png", 2339, 1700))).resolves.toBe("landscape");
  });

  it("returns null for a non-PNG, so the caller measures instead of guessing", async () => {
    const file = path.join(tmp, "x.png");
    fs.writeFileSync(file, Buffer.alloc(24, 1));
    await expect(readPngAspect(file)).resolves.toBeNull();
  });

  it("returns null rather than throwing on a missing or truncated file", async () => {
    await expect(readPngAspect(path.join(tmp, "nope.png"))).resolves.toBeNull();
    const short = path.join(tmp, "short.png");
    fs.writeFileSync(short, Buffer.alloc(8));
    await expect(readPngAspect(short)).resolves.toBeNull();
  });
});

describe("documents.ocr-preprocess PageRotationSampler", () => {
  let tmp: string;

  /** Counts how often the expensive detector actually ran. */
  function detector(result: RotationDetection) {
    const calls: string[] = [];
    return {
      calls,
      fn: async (p: string) => {
        calls.push(p);
        return result;
      },
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fk-sampler-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects once and lets the rest of the document inherit it", async () => {
    const d = detector({ rotate: 0, confident: true });
    const sampler = new PageRotationSampler(d.fn);
    const pages = [1, 2, 3, 4, 5].map((n) => writePngHeader(tmp, `p${n}.png`, 1700, 2339));

    const results = [];
    for (const p of pages) results.push(await sampler.resolve(p));

    expect(d.calls).toHaveLength(1);
    expect(results.map((r) => r.rotate)).toEqual([0, 0, 0, 0, 0]);
    // `detected` is what the timing log reports as "(reused)".
    expect(results.map((r) => r.detected)).toEqual([true, false, false, false, false]);
  });

  it("keeps measuring every page when the document really is rotated", async () => {
    const d = detector({ rotate: 90, confident: true });
    const sampler = new PageRotationSampler(d.fn);
    for (const n of [1, 2, 3]) await sampler.resolve(writePngHeader(tmp, `p${n}.png`, 1700, 2339));
    expect(d.calls).toHaveLength(3);
  });

  it("keeps measuring when detection was inconclusive", async () => {
    const d = detector({ rotate: 0, confident: false });
    const sampler = new PageRotationSampler(d.fn);
    for (const n of [1, 2, 3]) await sampler.resolve(writePngHeader(tmp, `p${n}.png`, 1700, 2339));
    expect(d.calls).toHaveLength(3);
  });

  it("measures a landscape page instead of inheriting the portrait verdict", async () => {
    // A landscape sheet inside a portrait document is the case where a
    // shared verdict is least likely to hold, and it is cheap to notice.
    const d = detector({ rotate: 0, confident: true });
    const sampler = new PageRotationSampler(d.fn);
    const portrait1 = writePngHeader(tmp, "p1.png", 1700, 2339);
    const landscape = writePngHeader(tmp, "p2.png", 2339, 1700);
    const portrait2 = writePngHeader(tmp, "p3.png", 1700, 2339);

    await sampler.resolve(portrait1);
    const second = await sampler.resolve(landscape);
    const third = await sampler.resolve(portrait2);

    expect(d.calls).toEqual([portrait1, landscape]);
    expect(second.detected).toBe(true);
    expect(third.detected).toBe(false);
  });

  it("falls back to detecting when the page shape cannot be read", async () => {
    // No aspect means no safe cache key, so nothing is reused — an unreadable
    // raster must not inherit another page's answer.
    const d = detector({ rotate: 0, confident: true });
    const sampler = new PageRotationSampler(d.fn);
    const broken = path.join(tmp, "broken.png");
    fs.writeFileSync(broken, Buffer.alloc(24, 1));
    for (let i = 0; i < 3; i++) await sampler.resolve(broken);
    expect(d.calls).toHaveLength(3);
  });

  it("does not share a verdict between documents", async () => {
    // Each document gets its own sampler; a cache that outlived one would be
    // claiming knowledge about pages it never saw.
    const d = detector({ rotate: 0, confident: true });
    const page = writePngHeader(tmp, "p1.png", 1700, 2339);
    await new PageRotationSampler(d.fn).resolve(page);
    await new PageRotationSampler(d.fn).resolve(page);
    expect(d.calls).toHaveLength(2);
  });
});
