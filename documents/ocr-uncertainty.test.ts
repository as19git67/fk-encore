import { describe, it, expect } from "vitest";
import {
  confusableFold,
  findUncertainSpans,
  hasImplausibleCharset,
  patternMiss,
  spanBbox,
  tooSmallToRead,
} from "./ocr-uncertainty";
import type { OcrWord } from "./ocr-layout";

function word(text: string, left: number, confidence = 96, width = 40): OcrWord {
  return { text, left, top: 100, right: left + width, bottom: 120, confidence };
}

describe("confusableFold", () => {
  it("folds shapes OCR swaps onto one skeleton", () => {
    expect(confusableFold("23 AUG 02")).toBe(confusableFold("23 AUC 02"));
    expect(confusableFold("l234")).toBe(confusableFold("1234"));
    expect(confusableFold("DE00")).toBe(confusableFold("DEOO"));
  });

  it("keeps digits apart that no misreading conflates", () => {
    // The guardrail the whole design rests on: an amount must never fold onto
    // a different amount, or the resolver would accept a rewritten number as
    // agreement between engines.
    expect(confusableFold("7.500")).not.toBe(confusableFold("7.800"));
    expect(confusableFold("20,11")).not.toBe(confusableFold("20,17"));
  });

  it("ignores separators OCR invents or loses", () => {
    expect(confusableFold("23.08.02")).toBe(confusableFold("23 08 02"));
  });
});

describe("hasImplausibleCharset", () => {
  it("flags a letter wedged inside a digit run", () => {
    expect(hasImplausibleCharset("20,1l")).toBe(true);
    expect(hasImplausibleCharset("7.5O0")).toBe(true);
  });

  it("flags a lowercase run broken by a capital", () => {
    expect(hasImplausibleCharset("aUs")).toBe(true);
  });

  it("flags runs of pure punctuation from a scanned page edge", () => {
    expect(hasImplausibleCharset("||")).toBe(true);
    expect(hasImplausibleCharset("--—")).toBe(true);
  });

  it("leaves real German office tokens alone", () => {
    for (const ok of ["GmbH", "KGaA", "Rechnung", "20,11EUR", "AUG02", "Str.", "5m", "12345"]) {
      expect(hasImplausibleCharset(ok), ok).toBe(false);
    }
  });

  it("does not flag a single character", () => {
    expect(hasImplausibleCharset("a")).toBe(false);
  });
});

describe("patternMiss", () => {
  it("recognizes a spelled-out date whose month is not a month", () => {
    expect(patternMiss("23 aus oz")).toBe(null); // 'oz' is not a year shape
    expect(patternMiss("23 aus 02")).toBe("date");
  });

  it("accepts a real spelled-out date as clean", () => {
    expect(patternMiss("23 AUG 02")).toBe(null);
    expect(patternMiss("23 August 2002")).toBe(null);
  });

  it("recognizes a numeric date with a damaged component", () => {
    expect(patternMiss("23.O8.02")).toBe("date");
    expect(patternMiss("23.08.02")).toBe(null);
  });

  it("recognizes an amount carrying a misread letter", () => {
    expect(patternMiss("7.5O0")).toBe("amount");
    expect(patternMiss("1.234,56")).toBe(null);
  });

  it("recognizes an IBAN with letters where digits belong", () => {
    expect(patternMiss("DE00 0000 O000 0000 0000 00")).toBe("iban");
    expect(patternMiss("DE00 0000 0000 0000 0000 00")).toBe(null);
  });

  it("recognizes a damaged document-number marker", () => {
    expect(patternMiss("#l234")).toBe("document_number");
    expect(patternMiss("#1234")).toBe(null);
  });

  it("says nothing about text that resembles no known shape", () => {
    expect(patternMiss("Sehr geehrte Damen und Herren")).toBe(null);
    expect(patternMiss("")).toBe(null);
  });
});

describe("findUncertainSpans", () => {
  it("groups a damaged date into one span with its readable neighbour", () => {
    // The motivating case: `23` reads fine, `aus`/`oz` do not. Cropping only
    // the bad words would hand the resolver a fragment with no date shape.
    const row = [word("23", 100, 94), word("aus", 145, 41), word("oz", 190, 38)];
    const spans = findUncertainSpans([row]);

    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("23 aus oz");
    expect(spans[0].reasons).toContain("low_confidence");
    expect(spans[0].bbox).toEqual({ left: 100, top: 100, right: 230, bottom: 120 });
  });

  it("leaves a confidently recognized row alone", () => {
    const row = [word("Sehr", 100), word("geehrte", 145), word("Damen", 190)];
    expect(findUncertainSpans([row])).toEqual([]);
  });

  it("does not merge across a column gap", () => {
    // A wide gap is a column break: the address window left of the contact
    // block. One crop spanning both would ask an unanswerable question.
    const row = [word("aUs", 100, 40), word("Postanschrift:", 900, 95, 120)];
    const spans = findUncertainSpans([row]);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("aUs");
  });

  it("flags a charset-implausible token that reads with high confidence", () => {
    // The case low-confidence filtering alone misses: tesseract can be sure
    // about a reading that cannot be right.
    const row = [word("Betrag", 100, 96), word("20,1l", 145, 91)];
    const spans = findUncertainSpans([row]);
    expect(spans).toHaveLength(1);
    expect(spans[0].reasons).toContain("implausible_charset");
  });

  it("adds pattern_miss on top of the word-level reasons", () => {
    const row = [word("23", 100, 94), word("aus", 145, 41), word("02", 190, 44)];
    const spans = findUncertainSpans([row]);
    expect(spans[0].reasons).toEqual(
      expect.arrayContaining(["low_confidence", "pattern_miss"]),
    );
  });

  it("ranks spans by score and honours the cap", () => {
    const rows = [
      [word("mild", 100, 68)],
      [word("aUs", 100, 12)],
      [word("also", 100, 65)],
    ];
    const spans = findUncertainSpans(rows, { maxSpans: 2 });
    expect(spans).toHaveLength(2);
    expect(spans[0].text).toBe("aUs");
    expect(spans[0].score).toBeGreaterThan(spans[1].score);
  });

  it("treats a word without a measured confidence as readable", () => {
    // Output whose TSV carried no conf column must not turn every word into a
    // suspect — that would send a whole document to the resolver.
    const row: OcrWord[] = [{ text: "Datum", left: 100, top: 100, right: 160, bottom: 120 }];
    expect(findUncertainSpans([row])).toEqual([]);
  });

  it("respects a raised confidence threshold", () => {
    const row = [word("Datum", 100, 75)];
    expect(findUncertainSpans([row])).toEqual([]);
    expect(findUncertainSpans([row], { confidenceThreshold: 80 })).toHaveLength(1);
  });
});

describe("spanBbox", () => {
  it("unions the boxes of every word", () => {
    expect(spanBbox([word("a", 100), word("b", 300)])).toEqual({
      left: 100,
      top: 100,
      right: 340,
      bottom: 120,
    });
  });
});

describe("tooSmallToRead", () => {
  const box = (width: number, height: number) => ({
    left: 100,
    top: 100,
    right: 100 + width,
    bottom: 100 + height,
  });

  it("accepts a box the size of a printed glyph", () => {
    // ~10x18 px at the pipeline's default 200 dpi.
    expect(tooSmallToRead(box(10, 18))).toBe(false);
  });

  it("rejects the specks a scan leaves behind", () => {
    // Every one of these appeared in production as its own uncertain span,
    // read as `.`, `|` or `'`.
    expect(tooSmallToRead(box(2, 2))).toBe(true);
    expect(tooSmallToRead(box(9, 3))).toBe(true);
    expect(tooSmallToRead(box(3, 3))).toBe(true);
  });

  it("rejects a long thin box, which an area test would let through", () => {
    // A table rule read as punctuation: 1x27 px is 27 px2, but no glyph is
    // one pixel wide.
    expect(tooSmallToRead(box(1, 27))).toBe(true);
  });
});

describe("findUncertainSpans — degenerate boxes", () => {
  /** A speck: flagged by confidence, far too small to be a character. */
  function speck(text: string, left: number): OcrWord {
    return { text, left, top: 100, right: left + 2, bottom: 102, confidence: 30 };
  }

  it("does not emit a span for a box too small to hold a glyph", () => {
    // Left in, such a span costs a crop and a model call — and because
    // `overlapRatio` normalises by the span's own area, it sits fully inside
    // any PaddleOCR line containing it and captures that line as its "second
    // reading". One 2x2 px speck drew in a whole unrelated line that way.
    expect(findUncertainSpans([[speck(".", 100)]])).toEqual([]);
  });

  it("still emits the real spans on a row that also carries specks", () => {
    const row = [speck(".", 100), word("aus", 300, 41), speck("|", 900)];
    const spans = findUncertainSpans([row]);

    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("aus");
  });

  it("honours a caller-supplied minimum", () => {
    // A deployment rasterizing at a different DPI scales the threshold rather
    // than losing every small glyph.
    const row = [word("aus", 300, 41, 12)];
    expect(findUncertainSpans([row], { minSpanWidth: 40 })).toEqual([]);
    expect(findUncertainSpans([row], { minSpanWidth: 4 })).toHaveLength(1);
  });
});
