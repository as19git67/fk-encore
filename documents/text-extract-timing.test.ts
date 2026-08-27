import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Text extraction is the pipeline's slowest stage and runs single-threaded
 * (`DOC_SCAN_TEXT_CONCURRENCY` defaults to 1, tesseract being CPU-bound), so
 * one slow document holds up every document behind it. Until these timings
 * existed the container log said only that a document had been extracted — not
 * which stage had taken the time, and the stages have completely different
 * remedies. The first measurement made with them found rotation detection
 * costing more than recognition itself (10.3 s against 7.8 s on a ten-page
 * document), which no amount of reading the code had suggested.
 *
 * Pinned at source level rather than by behaviour: the timings are log output
 * from a function that shells out to four binaries, and there is no PDF fixture
 * in the repo to drive it. What these guard is that the lines keep naming every
 * stage — a summary that silently stops reporting one is worse than no summary,
 * because the missing stage looks like it costs nothing.
 */
describe("documents.text-extract: stage timings", () => {
  const source = readFileSync(join(import.meta.dirname, "text-extract.ts"), "utf8");
  const ops = readFileSync(join(import.meta.dirname, "document-ops.ts"), "utf8");

  it("names every OCR stage in the per-document summary", () => {
    const summary = source.slice(source.indexOf("`ocr done in ${totalMs}ms"));
    for (const stage of ["rasterize", "rotate", "clean", "tesseract", "layout"]) {
      expect(summary.slice(0, 600), `summary omits ${stage}`).toContain(stage);
    }
  });

  it("reports a per-page cost, not only a total", () => {
    // A ten-page document averaging 2 s/page and a one-page document taking
    // 20 s are the same total and completely different problems.
    expect(source).toMatch(/ms\/page/);
  });

  it("gates the per-page lines behind an env var that defaults to on", () => {
    expect(source).toContain("DOCUMENTS_OCR_TIMING_PAGES");
    expect(source).toMatch(/DOCUMENTS_OCR_TIMING_PAGES \?\? "1"/);
  });

  it("tags every line with the document id", () => {
    // Without it, concurrent workers interleave indistinguishably and no
    // extraction can be grepped out of the log as a unit.
    expect(source).toMatch(/options\.docId/);
    expect(ops, "runTextExtract must pass the id down").toMatch(/docId: documentId/);
  });

  it("keeps the job wrapper's own total, which covers more than extraction", () => {
    // The thumbnail warm-up and the served-PDF refresh sit outside
    // extractPdfText but inside the job, so the job total and the extract
    // total answer different questions.
    const line = ops.slice(ops.indexOf("text_extract(${documentId}) done in"));
    for (const stage of ["thumbnail", "extract", "preview", "source="]) {
      expect(line.slice(0, 400), `job summary omits ${stage}`).toContain(stage);
    }
  });
});
