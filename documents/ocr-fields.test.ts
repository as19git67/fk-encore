import { describe, it, expect } from "vitest";
import {
  buildFieldMap,
  labelType,
  pairForBox,
  splitRowCells,
} from "./ocr-fields";
import type { OcrWord } from "./ocr-layout";

/** One word. Heights are 20px, so a column gap is anything over ~44px. */
function w(text: string, left: number, top = 100, width = 40): OcrWord {
  return { text, left, top, right: left + width, bottom: top + 20, confidence: 90 };
}

describe("labelType", () => {
  it("types the German office vocabulary", () => {
    expect(labelType("Rechnungsdatum")).toBe("date");
    expect(labelType("Belegdatum")).toBe("date");
    expect(labelType("Betrag")).toBe("amount");
    expect(labelType("Gesamtsumme")).toBe("amount");
    expect(labelType("IBAN")).toBe("iban");
    expect(labelType("Rechnungsnummer")).toBe("document_number");
    expect(labelType("Invoice No.")).toBe("document_number");
  });

  it("does not read a number label as a date because it ends in digits", () => {
    // Ordering matters: `\w*nummer` and `\w*datum` both match compounds, so
    // the specific patterns have to be tried in the right order.
    expect(labelType("Rechnungsnummer")).toBe("document_number");
    expect(labelType("Rechnungsdatum")).toBe("date");
  });

  it("puts Kontonummer with the bank details, not with reference numbers", () => {
    expect(labelType("Kontonummer")).toBe("iban");
  });

  it("accepts a colon-terminated label with no type expectation", () => {
    expect(labelType("Sachbearbeiter:")).toBe("text");
  });

  it("rejects prose that merely contains a label word", () => {
    // The failure this guards: a sentence mentioning "Datum" becoming a label
    // and capturing the rest of the sentence as its value.
    expect(labelType("Bitte beachten Sie das Datum der Zahlung")).toBe(null);
    expect(labelType("")).toBe(null);
  });

  it("rejects an ordinary word", () => {
    expect(labelType("Musterstadt")).toBe(null);
  });
});

describe("splitRowCells", () => {
  it("splits on a column-width gap and keeps word gaps together", () => {
    const row = [w("Sehr", 100), w("geehrte", 145), w("Damen", 800)];
    expect(splitRowCells(row).map((c) => c.map((x) => x.text))).toEqual([
      ["Sehr", "geehrte"],
      ["Damen"],
    ]);
  });
});

describe("buildFieldMap — same row", () => {
  it("pairs a label with the value in the next cell", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180), w("23.08.2002", 600)]];
    const [pair] = buildFieldMap(rows);

    expect(pair.label).toBe("Rechnungsdatum");
    expect(pair.valueText).toBe("23.08.2002");
    expect(pair.expectedType).toBe("date");
    expect(pair.pairing).toBe("same_row");
  });

  it("pairs the case that started all this", () => {
    // `Invoice No.  E0300008SA` — the value is an identifier, and the label
    // says so. No charset rule needed to excuse it.
    const rows = [[w("Invoice", 100), w("No.", 145), w("E0300008SA", 600, 100, 130)]];
    const [pair] = buildFieldMap(rows);

    expect(pair.label).toBe("Invoice No.");
    expect(pair.valueText).toBe("E0300008SA");
    expect(pair.expectedType).toBe("document_number");
  });

  it("splits a colon-terminated label from a value sharing its cell", () => {
    const rows = [[w("Betrag:", 100), w("7.500,00", 145)]];
    const [pair] = buildFieldMap(rows);

    expect(pair.label).toBe("Betrag:");
    expect(pair.valueText).toBe("7.500,00");
    expect(pair.expectedType).toBe("amount");
  });

  it("keeps a multi-word value together", () => {
    const rows = [[w("IBAN", 100), w("DE00", 600), w("0000", 650), w("0000", 700)]];
    const [pair] = buildFieldMap(rows);
    expect(pair.valueText).toBe("DE00 0000 0000");
  });

  it("does not pair two labels with each other", () => {
    // A header row: `Datum   Rechnungsnummer`. Reading the second as the
    // first's value would invent a field that is not on the page.
    const rows = [[w("Datum", 100), w("Rechnungsnummer", 600, 100, 200)]];
    expect(buildFieldMap(rows)).toEqual([]);
  });

  it("finds several fields on one row", () => {
    const rows = [
      [w("Datum:", 100), w("23.08.2002", 160), w("Betrag:", 900), w("20,11", 980)],
    ];
    const pairs = buildFieldMap(rows);
    expect(pairs.map((p) => [p.label, p.valueText])).toEqual([
      ["Datum:", "23.08.2002"],
      ["Betrag:", "20,11"],
    ]);
  });

  it("ignores a row with no label at all", () => {
    expect(buildFieldMap([[w("Sehr", 100), w("geehrte", 800)]])).toEqual([]);
  });
});

describe("buildFieldMap — stacked", () => {
  it("pairs a lone label with the row beneath it", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180)], [w("23.08.2002", 100, 125)]];
    const [pair] = buildFieldMap(rows);

    expect(pair.valueText).toBe("23.08.2002");
    expect(pair.pairing).toBe("stacked");
  });

  it("refuses a value that is not aligned under the label", () => {
    // The right-hand column's content is not this label's value, however
    // directly it follows in reading order.
    const rows = [[w("Rechnungsdatum", 100, 100, 180)], [w("Musterstadt", 900, 125)]];
    expect(buildFieldMap(rows)).toEqual([]);
  });

  it("refuses a value too far below the label", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180)], [w("23.08.2002", 100, 200)]];
    expect(buildFieldMap(rows)).toEqual([]);
  });

  it("does not pair a label with another label beneath it", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180)], [w("Belegdatum", 100, 125, 140)]];
    expect(buildFieldMap(rows)).toEqual([]);
  });
});

describe("buildFieldMap — column header", () => {
  it("pairs each header with the value in its column", () => {
    const rows = [
      [w("Datum", 100, 100), w("Rechnungsnummer", 700, 100, 200)],
      [w("23.08.2002", 100, 125, 120), w("100234", 700, 125)],
    ];
    const pairs = buildFieldMap(rows);

    expect(pairs.map((p) => [p.label, p.valueText, p.pairing])).toEqual([
      ["Datum", "23.08.2002", "column_header"],
      ["Rechnungsnummer", "100234", "column_header"],
    ]);
  });

  it("assigns a right-aligned value to the header whose band contains it", () => {
    // The usual table: a left-aligned "Betrag" header with the amount pushed
    // to the right edge of its column. A strict left-edge match would lose it.
    const rows = [
      [w("Buchungstag", 100, 100, 150), w("Betrag", 700, 100)],
      [w("23.08.2002", 100, 125, 120), w("7.500,00", 860, 125)],
    ];
    const pairs = buildFieldMap(rows);
    expect(pairs.map((p) => [p.label, p.valueText])).toEqual([
      ["Buchungstag", "23.08.2002"],
      ["Betrag", "7.500,00"],
    ]);
  });

  it("needs at least two headers before treating a row as a table head", () => {
    // One label plus one value is a same-row or stacked field, not a table —
    // and reading it as a table would split the value across phantom columns.
    const rows = [[w("Datum", 100, 100)], [w("23.08.2002", 100, 125, 120)]];
    expect(buildFieldMap(rows)[0].pairing).toBe("stacked");
  });
});

describe("buildFieldMap — a business letter", () => {
  it("reads the letterhead block without pairing across the columns", () => {
    // The address window sits left of the contact block; `splitColumnBands`
    // has already separated them, so the rows here are per-column. What must
    // not happen is a label from one column claiming a value from the other.
    const rows = [
      [w("Beispiel", 100, 100), w("AG", 165, 100)],
      [w("Rechnungsdatum", 700, 100, 180), w("23.08.2002", 950, 100, 120)],
      [w("Invoice", 700, 130), w("No.", 745, 130), w("E0300008SA", 950, 130, 130)],
      [w("Sehr", 100, 300), w("geehrte", 145, 300), w("Damen", 200, 300)],
    ];
    const pairs = buildFieldMap(rows);

    expect(pairs.map((p) => [p.label, p.valueText, p.expectedType])).toEqual([
      ["Rechnungsdatum", "23.08.2002", "date"],
      ["Invoice No.", "E0300008SA", "document_number"],
    ]);
  });
});

describe("pairForBox", () => {
  it("finds the pair whose value covers a span", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180), w("23 aus oz", 600, 100, 130)]];
    const pairs = buildFieldMap(rows);

    const found = pairForBox(pairs, { left: 600, top: 100, right: 730, bottom: 120 });
    expect(found?.expectedType).toBe("date");
  });

  it("returns null for a span that belongs to no field", () => {
    const rows = [[w("Rechnungsdatum", 100, 100, 180), w("23.08.2002", 600)]];
    const pairs = buildFieldMap(rows);
    expect(pairForBox(pairs, { left: 100, top: 900, right: 200, bottom: 920 })).toBe(null);
  });
});
