import { describe, it, expect } from "vitest";
import {
  buildVisualRows,
  formatVisualRow,
  layoutTextFromTsv,
  layoutTextFromWords,
  meanWordConfidence,
  parseTesseractTsv,
  shouldUseLayoutText,
  type OcrWord,
} from "./ocr-layout";

const TSV_HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/** Build one word-level TSV row (level 5) with the given geometry and text. */
function tsvWord(left: number, top: number, width: number, height: number, text: string): string {
  return `5\t1\t1\t1\t1\t1\t${left}\t${top}\t${width}\t${height}\t96\t${text}`;
}

function word(text: string, left: number, top: number, width = 40, height = 20): OcrWord {
  return { text, left, top, right: left + width, bottom: top + height };
}

describe("parseTesseractTsv", () => {
  it("keeps word-level rows and converts them to boxes", () => {
    const tsv = [
      TSV_HEADER,
      "1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t",
      "4\t1\t1\t1\t1\t0\t100\t200\t300\t20\t-1\t",
      tsvWord(100, 200, 60, 20, "Rechnung"),
      tsvWord(200, 200, 40, 20, "20,11"),
    ].join("\n");

    expect(parseTesseractTsv(tsv)).toEqual([
      { text: "Rechnung", left: 100, top: 200, right: 160, bottom: 220 },
      { text: "20,11", left: 200, top: 200, right: 240, bottom: 220 },
    ]);
  });

  it("drops blank words that tesseract emits for layout gaps", () => {
    const tsv = [TSV_HEADER, tsvWord(10, 10, 5, 20, " "), tsvWord(30, 10, 40, 20, "Datum")].join("\n");
    expect(parseTesseractTsv(tsv).map((w) => w.text)).toEqual(["Datum"]);
  });

  it("returns nothing for output without the expected columns", () => {
    expect(parseTesseractTsv("not a tsv at all")).toEqual([]);
    expect(parseTesseractTsv("")).toEqual([]);
  });
});

describe("buildVisualRows", () => {
  it("merges words that share a baseline across block boundaries", () => {
    // Two words far apart horizontally — tesseract would put them in separate
    // blocks — but on the same baseline.
    const rows = buildVisualRows([word("links", 100, 500), word("rechts", 1800, 500)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].map((w) => w.text)).toEqual(["links", "rechts"]);
  });

  it("keeps words on different baselines apart and orders rows top to bottom", () => {
    const rows = buildVisualRows([word("unten", 100, 900), word("oben", 100, 100)]);
    expect(rows.map((r) => r[0].text)).toEqual(["oben", "unten"]);
  });

  it("shares a row between mixed font sizes on the same baseline", () => {
    // A large heading (height 40) and small print (height 16) whose boxes end
    // at the same y. Grouping by box top would split them.
    const big = { text: "Endbetrag", left: 100, top: 460, right: 300, bottom: 500 };
    const small = { text: "20,11", left: 900, top: 484, right: 980, bottom: 500 };
    const rows = buildVisualRows([big, small]);
    expect(rows).toHaveLength(1);
    expect(rows[0].map((w) => w.text)).toEqual(["Endbetrag", "20,11"]);
  });

  it("returns nothing for no words", () => {
    expect(buildVisualRows([])).toEqual([]);
  });
});

describe("formatVisualRow", () => {
  it("joins adjacent words with a single space", () => {
    expect(formatVisualRow([word("Frau", 100, 10, 50), word("Ellrich", 155, 10, 60)])).toBe(
      "Frau Ellrich",
    );
  });

  it("marks a wide horizontal gap as a column break", () => {
    const row = [word("01.04.19", 100, 10, 80, 20), word("50094-5146", 600, 10, 100, 20)];
    expect(formatVisualRow(row)).toBe("01.04.19   50094-5146");
  });
});

describe("layoutTextFromWords", () => {
  it("keeps a label with its value instead of the neighbouring column", () => {
    // The production case: on the scan "geb." introduces the patient's birth
    // date on its own line, while the invoice date sits in a table above.
    // Tesseract's block order pulled the two dates together and left the
    // label behind; row reconstruction restores the visual reading.
    const words = [
      word("Datum", 620, 140, 90, 22),
      word("01.04.19", 620, 180, 110, 22),
      word("Rechnungs-Nr.", 900, 140, 180, 22),
      word("50094-5146", 900, 180, 150, 22),
      word("geb.", 620, 620, 60, 22),
      word("08.06.1967", 690, 620, 140, 22),
    ];

    expect(layoutTextFromWords(words)).toBe(
      ["Datum   Rechnungs-Nr.", "01.04.19   50094-5146", "geb. 08.06.1967"].join("\n"),
    );
  });

  it("returns an empty string when there is nothing to render", () => {
    expect(layoutTextFromWords([])).toBe("");
  });
});

describe("layoutTextFromTsv", () => {
  it("reconstructs a page end to end", () => {
    const tsv = [
      TSV_HEADER,
      tsvWord(100, 100, 80, 20, "HERRN"),
      tsvWord(700, 100, 90, 20, "Rechnung"),
      tsvWord(100, 140, 120, 20, "ANTON"),
      tsvWord(230, 140, 110, 20, "BEISPIEL"),
    ].join("\n");

    expect(layoutTextFromTsv(tsv)).toBe(["HERRN   Rechnung", "ANTON BEISPIEL"].join("\n"));
  });

  it("yields an empty string for unusable output", () => {
    expect(layoutTextFromTsv("")).toBe("");
  });
});

describe("shouldUseLayoutText", () => {
  it("accepts a reconstruction carrying the same characters", () => {
    expect(shouldUseLayoutText("Datum 01.04.19\nEndbetrag 20,11", "Datum\n01.04.19\nEndbetrag\n20,11")).toBe(true);
  });

  it("rejects an empty reconstruction", () => {
    expect(shouldUseLayoutText("", "Datum 01.04.19")).toBe(false);
    expect(shouldUseLayoutText("   \n  ", "Datum 01.04.19")).toBe(false);
  });

  it("rejects a reconstruction that lost content", () => {
    expect(shouldUseLayoutText("Datum", "Datum 01.04.19 Endbetrag 20,11 Rechnungs-Nr. 50094")).toBe(
      false,
    );
  });

  it("accepts the reconstruction when tesseract's own text is empty", () => {
    expect(shouldUseLayoutText("Datum 01.04.19", "")).toBe(true);
  });
});

describe("meanWordConfidence", () => {
  it("averages the confidence of recognized words", () => {
    const tsv = [
      TSV_HEADER,
      "5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t90\tRechnung",
      "5\t1\t1\t1\t1\t2\t60\t10\t40\t20\t80\tSumme",
    ].join("\n");
    expect(meanWordConfidence(tsv)).toBe(85);
  });

  it("ignores the structural rows and their -1 confidence", () => {
    const tsv = [
      TSV_HEADER,
      "1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t",
      "4\t1\t1\t1\t1\t0\t10\t10\t100\t20\t-1\t",
      "5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t70\tRechnung",
    ].join("\n");
    expect(meanWordConfidence(tsv)).toBe(70);
  });

  it("ignores words tesseract emitted without text", () => {
    const tsv = [
      TSV_HEADER,
      "5\t1\t1\t1\t1\t1\t10\t10\t5\t20\t0\t ",
      "5\t1\t1\t1\t1\t2\t30\t10\t40\t20\t60\tDatum",
    ].join("\n");
    expect(meanWordConfidence(tsv)).toBe(60);
  });

  it("returns null when nothing was recognized", () => {
    expect(meanWordConfidence(TSV_HEADER)).toBeNull();
    expect(meanWordConfidence("")).toBeNull();
    expect(meanWordConfidence("kein tsv")).toBeNull();
  });
});
