import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A born-digital PDF must not be OCR'd.
 *
 * `extractPdfText` decides between the PDF's own text layer and an OCR pass,
 * and the decision rests on the text layer alone. The OCR call nevertheless
 * sat *above* that decision, so every document with a usable text layer paid
 * for a full `ocrPdf` — pdftoppm rasterizing every page, tesseract reading each
 * one — and the result was discarded unread on the next line. Nothing consumed
 * it: `source` is never persisted, and the `ocr_confidence` column belongs to
 * the receipt extractor, not to this path.
 *
 * It is by far the most expensive step in the pipeline, so paying it for
 * nothing made text extraction outrun classification and starve the queue —
 * which is how it was found, during a re-run over the whole corpus.
 *
 * Pinned by source order rather than by behaviour: `ocrPdf` is module-internal
 * and shells out to two binaries, so the honest way to state "this must not be
 * reached" is that the return precedes the call.
 */
describe("documents.text-extract: OCR is not run for a usable text layer", () => {
  const source = readFileSync(join(import.meta.dirname, "text-extract.ts"), "utf8");

  // The text-layer return, located by the one part of it that is not
  // formatting: the discriminant, with its trailing comma. Matching the whole
  // return statement made this test fail the moment a field was added to
  // ExtractResult and the object wrapped onto several lines — a reformat, with
  // the property under test untouched. The comma is what keeps this off the
  // `source: "text_layer" | "ocr" | "mixed"` union in the interface far above,
  // which would otherwise be found first and put `decision` before the guard.
  const TEXT_LAYER_RETURN = 'source: "text_layer",';

  it("returns the text layer before reaching the OCR call", () => {
    const decision = source.indexOf(TEXT_LAYER_RETURN);
    const ocrCall = source.indexOf("await ocrPdf(");
    expect(decision, "text-layer return not found").toBeGreaterThan(-1);
    expect(ocrCall, "ocrPdf call not found").toBeGreaterThan(-1);
    expect(decision).toBeLessThan(ocrCall);
  });

  it("guards that return with forceOcr, so recovery still reaches OCR", () => {
    // force_ocr exists to rescue documents whose text layer is broken in a way
    // `hasPoorSpacing` does not catch. Returning early regardless would make
    // that option silently do nothing.
    const decision = source.indexOf(TEXT_LAYER_RETURN);
    const guard = source.lastIndexOf("if (!options.forceOcr && textLayerLooksGood) {", decision);
    expect(guard).toBeGreaterThan(-1);
  });

  it("still builds the searchable PDF on every path that does run OCR", () => {
    // Those are exactly the scanned pages, which have no selectable text in
    // the viewer without the sandwich PDF.
    expect(source).toContain("wantSearchablePdf: true");
  });
});
