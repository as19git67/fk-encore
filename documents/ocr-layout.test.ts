import { describe, it, expect } from "vitest";
import {
  buildVisualRows,
  formatVisualRow,
  layoutTextFromTsv,
  layoutTextFromWords,
  meanWordConfidence,
  parseTesseractTsv,
  shouldUseLayoutText,
  splitColumnBands,
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
    expect(formatVisualRow([word("Frau", 100, 10, 50), word("Kaltenbach", 155, 10, 60)])).toBe(
      "Frau Kaltenbach",
    );
  });

  it("marks a wide horizontal gap as a column break", () => {
    const row = [word("12.03.19", 100, 10, 80, 20), word("77213-9042", 600, 10, 100, 20)];
    expect(formatVisualRow(row)).toBe("12.03.19   77213-9042");
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
      word("12.03.19", 620, 180, 110, 22),
      word("Rechnungs-Nr.", 900, 140, 180, 22),
      word("77213-9042", 900, 180, 150, 22),
      word("geb.", 620, 620, 60, 22),
      word("17.11.1955", 690, 620, 140, 22),
    ];

    expect(layoutTextFromWords(words)).toBe(
      ["Datum   Rechnungs-Nr.", "12.03.19   77213-9042", "geb. 17.11.1955"].join("\n"),
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

/**
 * Measured on a production insurance letter, whose letterhead prints the
 * recipient's address window on the left and the sender's contact block on the
 * right. Sharing baselines, the two were merged into single lines: the
 * recipient's name and the sender's agent details ended up on one line, and the
 * return-address line picked up the right-hand column's postcode.
 *
 * Tesseract's own `block_num` does not separate them — on that letter it put
 * the return-address line and the right column's postcode in one block. The
 * corridor between the columns does, and it closes by itself where the body
 * text starts spanning the page.
 *
 * Geometry only; every fixture below is synthetic.
 */
describe("splitColumnBands", () => {
  /**
   * Two columns of a letterhead, at x=100 (left) and x=700 (right). The left
   * block is a four-line address window, the right one a longer contact block,
   * so most rows carry only one of them — which is what tells the two apart
   * from a table, where nearly every row reaches across.
   */
  function letterhead(): OcrWord[][] {
    return [
      [word("Empfänger", 100, 100)],
      [word("Beispielstraße", 100, 130), word("Postanschrift:", 700, 130)],
      [word("12345", 100, 160), word("Beispiel", 700, 160), word("AG", 745, 160)],
      [word("Telefon:", 700, 190)],
      [word("E-Mail:", 700, 220)],
      [word("Internet:", 700, 250)],
    ];
  }

  it("separates two blocks printed side by side", () => {
    const out = splitColumnBands(letterhead()).map(formatVisualRow);
    // Left column first, whole, then the right one — neither line mixes them.
    expect(out).toEqual([
      "Empfänger", "Beispielstraße", "12345",
      "Postanschrift:", "Beispiel AG",
      "Telefon:", "E-Mail:", "Internet:",
    ]);
  });

  it("leaves a table joined", () => {
    // The case the corridor detector cannot tell apart on gap width alone: a
    // table has the same wide gaps, but nearly every row reaches across them,
    // and splitting would separate a header from the value beneath it —
    // exactly what extractAlignedColumnDate reads by their shared column.
    const table: OcrWord[][] = [
      [word("Datum", 100, 100), word("Rechnungs-Nr.", 700, 100)],
      [word("12.03.19", 100, 130), word("77213-9042", 700, 130)],
      [word("13.03.19", 100, 160), word("77213-9043", 700, 160)],
      [word("14.03.19", 100, 190), word("77213-9044", 700, 190)],
    ];
    expect(splitColumnBands(table).map(formatVisualRow)).toEqual([
      "Datum   Rechnungs-Nr.",
      "12.03.19   77213-9042",
      "13.03.19   77213-9043",
      "14.03.19   77213-9044",
    ]);
  });

  it("stops where the body text starts spanning the page", () => {
    const rows = [
      ...letterhead(),
      [word("Sehr", 100, 280), word("geehrte", 145, 280), word("Damen", 400, 280),
       word("und", 600, 280), word("Herren,", 700, 280)],
    ];
    const out = splitColumnBands(rows).map(formatVisualRow);
    expect(out[out.length - 1]).toBe("Sehr geehrte   Damen   und   Herren,");
  });

  it("is not kept alive by the stray marks a scan leaves at the page edge", () => {
    // A column of lone "|" marks down the margin is enough to make every row
    // look like it reaches across some corridor. Left counting, it kept the
    // band growing past the two real columns, and the split then landed on the
    // margin instead of between them.
    const rows = letterhead().map((row, i) => [...row, word("|", 1200, 100 + i * 30, 4)]);
    const out = splitColumnBands(rows).map(formatVisualRow);
    expect(out.slice(0, 3)).toEqual(["Empfänger", "Beispielstraße", "12345"]);
  });

  it("does not split a band too short to be a column", () => {
    const two = letterhead().slice(1, 3);
    expect(splitColumnBands(two).map(formatVisualRow)).toEqual([
      "Beispielstraße   Postanschrift:",
      "12345   Beispiel AG",
    ]);
  });

  it("changes nothing on a single-column page", () => {
    const rows = [
      [word("Rechnung", 100, 100)],
      [word("Position", 100, 130)],
      [word("Summe", 100, 160)],
    ];
    expect(splitColumnBands(rows)).toEqual(rows);
  });
});

describe("shouldUseLayoutText", () => {
  it("accepts a reconstruction carrying the same characters", () => {
    expect(shouldUseLayoutText("Datum 12.03.19\nEndbetrag 20,11", "Datum\n12.03.19\nEndbetrag\n20,11")).toBe(true);
  });

  it("rejects an empty reconstruction", () => {
    expect(shouldUseLayoutText("", "Datum 12.03.19")).toBe(false);
    expect(shouldUseLayoutText("   \n  ", "Datum 12.03.19")).toBe(false);
  });

  it("rejects a reconstruction that lost content", () => {
    expect(shouldUseLayoutText("Datum", "Datum 12.03.19 Endbetrag 20,11 Rechnungs-Nr. 77213")).toBe(
      false,
    );
  });

  it("accepts the reconstruction when tesseract's own text is empty", () => {
    expect(shouldUseLayoutText("Datum 12.03.19", "")).toBe(true);
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
