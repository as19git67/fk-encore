/**
 * Word positions from text extraction (#1531). Synthetic pages only: every
 * name, address and amount below is made up.
 */

import { describe, it, expect } from "vitest";
import { layoutTextFromRows, parseTesseractTsv, visualRowsFromWords } from "./ocr-layout";
import { amountValue, cleanWordText, findBoxes, wordsFromOcrRows, wordsFromPdfItems, type PageWords, type StoredWord } from "./page-words";

const TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/** A Tesseract TSV for `lines`, each word 20px high, words 12px per char plus a 12px space. */
function tsvFor(lines: string[][], startTop = 100): string {
  const rows = [TSV_HEADER, "1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t"];
  lines.forEach((words, l) => {
    const top = startTop + l * 60;
    let left = 200;
    rows.push(`4\t1\t1\t1\t${l + 1}\t0\t200\t${top}\t1000\t20\t-1\t`);
    words.forEach((w, i) => {
      const width = w.length * 12;
      rows.push(`5\t1\t1\t1\t${l + 1}\t${i + 1}\t${left}\t${top}\t${width}\t20\t${90 + (i % 5)}\t${w}`);
      left += width + 12;
    });
  });
  return rows.join("\n");
}

function scanPage(lines: string[][]): PageWords {
  const rows = visualRowsFromWords(parseTesseractTsv(tsvFor(lines)));
  return { page: 1, width: 2480, height: 3508, unit: "px", rotation: 0, words: wordsFromOcrRows(rows) };
}

const PURCHASE = [
  ["Kaufvertrag", "Beispielstraße", "1,", "12345", "Musterstadt"],
  ["Kaufpreis:", "450.000,00", "EUR"],
  ["Anzahlung", "laut", "Vereinbarung:", "450.000", "€"],
  ["Restbetrag", "fällig", "EUR", "450.000,-"],
  ["Nebenkosten", "12.500,00", "EUR"],
];

describe("words from OCR rows", () => {
  it("are the words the layout text is built from, in the same order", () => {
    const rows = visualRowsFromWords(parseTesseractTsv(tsvFor(PURCHASE)));
    const words = wordsFromOcrRows(rows);
    const layoutWords = layoutTextFromRows(rows).split(/\s+/).filter(Boolean);
    expect(words.map((w) => w.text)).toEqual(layoutWords);
    expect(words[0]).toMatchObject({ text: "Kaufvertrag", left: 200, top: 100, right: 332, bottom: 120 });
    expect(words[0].confidence).toBe(90);
  });

  it("keep a corrected reading the resolver wrote back without a confidence", () => {
    const words = wordsFromOcrRows([[{ text: "450.000,00", left: 1, top: 2, right: 3, bottom: 4 }, { text: "  ", left: 5, top: 2, right: 6, bottom: 4 }]]);
    expect(words).toEqual([{ text: "450.000,00", left: 1, top: 2, right: 3, bottom: 4 }]);
  });

  it("drop a word that is nothing but control characters", () => {
    const words = wordsFromOcrRows([[{ text: "\u0000\u0007", left: 1, top: 2, right: 3, bottom: 4 }, { text: "Musterstadt", left: 5, top: 2, right: 9, bottom: 4 }]]);
    expect(words.map((w) => w.text)).toEqual(["Musterstadt"]);
  });
});

describe("cleanWordText", () => {
  it("removes what Postgres jsonb rejects and keeps everything else", () => {
    expect(cleanWordText("ab\u0000c")).toBe("abc");
    expect(cleanWordText("\u0000")).toBe("");
    expect(cleanWordText("x\u001fy\u007fz\u0085")).toBe("xyz");
    expect(cleanWordText("a\ud800b\udc00c")).toBe("abc");
    expect(cleanWordText("Straße 12,50 € 😀")).toBe("Straße 12,50 € 😀");
  });
});

describe("words from a text layer", () => {
  it("split an item at its spaces and turn the baseline into a top-left box", () => {
    const words = wordsFromPdfItems(
      [{ str: "Kaufpreis: 450.000,00 EUR", width: 125, height: 10, transform: [10, 0, 0, 10, 72, 700] }],
      [0, 0, 595, 842],
    );
    expect(words.map((w) => w.text)).toEqual(["Kaufpreis:", "450.000,00", "EUR"]);
    // The width is shared out by advance widths, not evenly: "Kaufpreis: "
    // is narrow, the digits are wide.
    const advance: Record<string, number> = {
      K: 667, a: 556, u: 556, f: 278, p: 556, r: 333, e: 556, i: 222, s: 500,
      ":": 278, " ": 278, ",": 278, ".": 278, E: 667, U: 722, R: 722,
    };
    const units = (t: string) => [...t].reduce((n, ch) => n + (advance[ch] ?? 556), 0);
    const scale = 125 / units("Kaufpreis: 450.000,00 EUR");
    expect(words[1].left).toBeCloseTo(72 + units("Kaufpreis: ") * scale);
    expect(words[1].right).toBeCloseTo(72 + units("Kaufpreis: 450.000,00") * scale);
    expect(words[1].top).toBeCloseTo(842 - 708);
    expect(words[1].bottom).toBeCloseTo(842 - 698);
  });

  it("drop a run of unmappable glyphs and clean control characters out of a word", () => {
    // pdf.js reports a glyph its font cannot map as U+0000, here as a run of
    // its own between two words and inside one — jsonb would reject either.
    const words = wordsFromPdfItems(
      [
        { str: "Nummer AB12", width: 60, height: 9, transform: [9, 0, 0, 9, 100, 700] },
        { str: "\u0000", width: 4, height: 9, transform: [9, 0, 0, 9, 160, 700] },
        { str: "00\u000007", width: 20, height: 9, transform: [9, 0, 0, 9, 164, 700] },
      ],
      [0, 0, 595, 842],
    );
    expect(words.map((w) => w.text)).toEqual(["Nummer", "AB12", "0007"]);
    expect(words[2].left).toBeCloseTo(164);
  });

  it("skip items without text or geometry", () => {
    expect(wordsFromPdfItems([{ str: "", transform: [1, 0, 0, 1, 0, 0] }, { str: "x", transform: [] }], [0, 0, 100, 100])).toEqual([]);
  });
});

describe("amountValue", () => {
  it("reads every printed form of an amount", () => {
    for (const form of ["450.000,00", "450.000", "450.000,-", "450.000,--", "450000", "€450.000", "450.000,00EUR", "450,000.00"]) {
      expect(amountValue(form), form).toBe(450000);
    }
    expect(amountValue("12,50")).toBe(12.5);
  });

  it("refuses what is not an amount", () => {
    for (const other of ["01.02.2026", "Kaufpreis", "DE00", "12.34.56", ""]) {
      expect(amountValue(other), other).toBeNull();
    }
  });
});

describe("findBoxes", () => {
  const page = scanPage(PURCHASE);

  function covers(box: { x: number; y: number; w: number; h: number }, word: StoredWord): boolean {
    const x = word.left / page.width;
    const y = word.top / page.height;
    return x >= box.x - 1e-4 && y >= box.y - 1e-4
      && word.right / page.width <= box.x + box.w + 1e-4
      && word.bottom / page.height <= box.y + box.h + 1e-4;
  }

  it("finds an amount in three printed forms, with its currency", () => {
    const boxes = findBoxes([page], "450.000 EUR");
    expect(boxes).toHaveLength(3);
    const byText = (t: string) => page.words.find((w) => w.text === t)!;
    expect(covers(boxes[0], byText("450.000,00"))).toBe(true);
    expect(covers(boxes[0], page.words.filter((w) => w.text === "EUR")[0])).toBe(true);
    expect(covers(boxes[1], byText("450.000"))).toBe(true);
    expect(covers(boxes[1], byText("€"))).toBe(true);
    expect(covers(boxes[2], byText("450.000,-"))).toBe(true);
    // "EUR 450.000,-": the code before the number belongs to the box.
    expect(covers(boxes[2], page.words.filter((w) => w.text === "EUR")[1])).toBe(true);
    // The label is not part of the amount.
    expect(covers(boxes[0], byText("Kaufpreis:"))).toBe(false);
    // Other amounts stay unmarked.
    expect(boxes.every((b) => !covers(b, byText("12.500,00")))).toBe(true);
  });

  it("returns the same boxes however the amount is asked for", () => {
    const expected = findBoxes([page], "450.000");
    for (const q of ["450000", "450.000,00 €", "EUR 450.000,-"]) {
      expect(findBoxes([page], q), q).toEqual(expected);
    }
  });

  it("finds an amount split over two words", () => {
    const split = scanPage([["Summe", "450", ".000,00", "EUR"]]);
    expect(findBoxes([split], "450.000,00")).toHaveLength(1);
  });

  it("merges a phrase into one box per occurrence", () => {
    const boxes = findBoxes([page], "beispielstraße 1");
    expect(boxes).toHaveLength(1);
    const street = page.words.find((w) => w.text === "Beispielstraße")!;
    const number = page.words.find((w) => w.text === "1,")!;
    expect(covers(boxes[0], street) && covers(boxes[0], number)).toBe(true);
    expect(boxes[0].page).toBe(1);
  });

  it("finds nothing for text that is not there, and boxes stay inside the page", () => {
    expect(findBoxes([page], "Grundbuch")).toEqual([]);
    for (const b of findBoxes([page], "450.000")) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1);
      expect(b.y + b.h).toBeLessThanOrEqual(1);
    }
  });

  it("does not join words from different lines into a phrase", () => {
    // "Musterstadt" ends line 1, "Kaufpreis:" starts line 2.
    expect(findBoxes([page], "Musterstadt Kaufpreis")).toEqual([]);
  });
});
