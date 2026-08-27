import { describe, expect, it } from "vitest";

import { renderItems, separatorBetween, type PdfTextItem } from "./pdf-text-layout";
import { ownedBytes } from "./text-extract";

/**
 * `pdf-parse` concatenates text items that share a baseline with nothing
 * between them, fusing tokens the PDF prints far apart:
 *
 *     12345 MusterstadtMax Mustermann        (address block, two columns)
 *     Versicherungsnummer:R-00000000-00      (label and value)
 *     Categories and Subject DescriptorsD.3.4  (real PDF, pdf-parse's own corpus)
 *
 * `hasPoorSpacing` does not catch it — it looks for spaces lost *inside* words,
 * and a fused pair trips at most one of its four signals — so such a page wins
 * the text-layer decision and reaches the classifier and the sender/date scans
 * in that state.
 *
 * The rule these tests pin is that separator insertion may only ever *add*
 * characters. Reordering was built and measured first and had to be abandoned:
 * merging by baseline and re-splitting with `splitColumnBands` fixed a
 * letterhead but turned a two-column journal article into word salad, and
 * `shouldUseLayoutText` waved it through because ink was identical (15782
 * characters either way). A guard that compares ink cannot see a scrambled
 * reading order. So the safety property here is structural, not statistical:
 * removing a character or swapping two items is out of reach by construction.
 */
describe("documents.pdf-text-layout separatorBetween", () => {
  const item = (
    str: string,
    left: number,
    width: number,
    height = 10,
    baseline = 700,
  ): PdfTextItem => ({ str, width, height, transform: [1, 0, 0, height, left, baseline] });

  it("separates a label from a value printed a column apart", () => {
    // `Versicherungsnummer:` ending at 170, value starting at 240 — 7 times the
    // text height, which is a layout decision, not a word space.
    expect(separatorBetween(item("Versicherungsnummer:", 60, 110), item("R-00000000-00", 240, 69)))
      .toBe("   ");
  });

  it("inserts a single space across an ordinary word gap", () => {
    expect(separatorBetween(item("Keywords", 60, 40), item("JavaScript", 104, 50))).toBe(" ");
  });

  it("leaves abutting items alone — that is a word split by a style change", () => {
    // A bold run inside a word arrives as two items that touch. pdf-parse is
    // right to fuse those, and inserting a space would break the word.
    expect(separatorBetween(item("Ver", 60, 20), item("sicherung", 80, 50))).toBe("");
  });

  it("does not double a separator the producer already supplied", () => {
    expect(separatorBetween(item("Postfach ", 60, 50), item("103969", 200, 30))).toBe("");
    expect(separatorBetween(item("Postfach", 60, 50), item(" 103969", 200, 30))).toBe("");
  });

  it("separates an item that starts left of the previous one", () => {
    // Content-stream order regularly emits the right-hand column before the
    // left-hand one sharing its baseline. The two cannot be one word — a split
    // word advances rightward — and fusing them is the worst observed case.
    expect(separatorBetween(item("12345 Musterstadt", 330, 80), item("Max Mustermann", 60, 75)))
      .toBe("   ");
  });

  it("returns nothing when the geometry is unusable", () => {
    const noTransform = { str: "x", transform: [1, 0, 0, 10] } as PdfTextItem;
    expect(separatorBetween(noTransform, item("y", 60, 10))).toBe("");
    expect(separatorBetween(item("y", 60, 10), noTransform)).toBe("");
    const nanX = { str: "x", transform: [1, 0, 0, 10, NaN, 700] } as PdfTextItem;
    expect(separatorBetween(nanX, item("y", 60, 10))).toBe("");
  });

  it("returns nothing for an empty item on either side", () => {
    expect(separatorBetween(item("", 60, 0), item("y", 200, 10))).toBe("");
    expect(separatorBetween(item("y", 60, 10), item("", 200, 0))).toBe("");
  });

  it("falls back to the text matrix when width and height are absent", () => {
    // Some producers emit items without the convenience fields; transform[3]
    // still carries the font scale, so a column gap is still recognizable.
    const bare = (str: string, left: number): PdfTextItem => ({
      str,
      transform: [1, 0, 0, 10, left, 700],
    });
    expect(separatorBetween(bare("Label:", 60), bare("Value", 300))).toBe("   ");
  });
});

describe("documents.pdf-text-layout renderItems", () => {
  const at = (str: string, left: number, baseline: number, width = 40): PdfTextItem => ({
    str,
    width,
    height: 10,
    transform: [1, 0, 0, 10, left, baseline],
  });

  it("keeps pdf-parse's line breaks — one per distinct baseline", () => {
    const out = renderItems([at("first", 60, 700), at("second", 60, 680)], true);
    expect(out).toBe("first\nsecond");
  });

  it("only ever adds characters, never removes or reorders", () => {
    const items = [
      at("12345 Musterstadt", 330, 700, 80),
      at("Max Mustermann", 60, 700, 75),
      at("next line", 60, 680),
    ];
    const rendered = renderItems(items, true);
    // Same items, same order, same content — only whitespace differs.
    expect(rendered.replace(/\s+/g, "")).toBe(
      renderItems(items, false).replace(/\s+/g, ""),
    );
    expect(rendered.indexOf("12345")).toBeLessThan(rendered.indexOf("Max"));
  });

  it("reproduces the fused rendering when switched off", () => {
    const items = [at("Keywords", 60, 700), at("JavaScript", 104, 700, 50)];
    expect(renderItems(items, false)).toBe("KeywordsJavaScript");
    expect(renderItems(items, true)).toBe("Keywords JavaScript");
  });

  it("never inserts a separator across a line break", () => {
    // The items are far apart horizontally but on different baselines; the
    // newline is the separator and a second one would be wrong.
    const out = renderItems([at("left", 60, 700), at("right", 400, 680)], true);
    expect(out).toBe("left\nright");
  });

  it("renders an empty item list as an empty string", () => {
    expect(renderItems([], true)).toBe("");
  });
});

describe("documents.text-extract ownedBytes", () => {
  /**
   * Node pools allocations under 8 KB, so a small `fs.readFile` result is a
   * view into a shared 8192-byte buffer at a non-zero offset. The pdf.js build
   * inside pdf-parse reads the underlying ArrayBuffer without honouring that
   * offset and throws `bad XRef entry` on a valid PDF — silently sending every
   * document under ~8 KB to OCR instead of using the text layer it already had.
   */
  it("returns bytes that own their ArrayBuffer", () => {
    const pooled = Buffer.from("%PDF-1.4 tiny");
    const owned = ownedBytes(pooled);
    expect(owned.byteOffset).toBe(0);
    expect(owned.buffer.byteLength).toBe(pooled.byteLength);
  });

  it("preserves the bytes exactly", () => {
    const source = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a]);
    expect(Buffer.from(ownedBytes(source))).toEqual(source);
  });

  it("copies rather than aliasing, so a later write cannot reach it", () => {
    const source = Buffer.from("abc");
    const owned = ownedBytes(source);
    source[0] = 0x7a;
    expect(owned[0]).toBe(0x61);
  });

  it("handles an empty buffer", () => {
    expect(ownedBytes(Buffer.alloc(0)).byteLength).toBe(0);
  });
});
