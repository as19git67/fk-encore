import { describe, expect, it } from "vitest";
import { anchor, rankReadings, type Reading } from "./letterhead";
import type { OcrWord } from "./ocr-layout";

/** A row of words laid out left to right at a given height. */
function row(top: number, ...texts: string[]): OcrWord[] {
  let left = 100;
  return texts.map((text) => {
    const word = { text, left, top, right: left + text.length * 12, bottom: top + 20, confidence: 90 };
    left = word.right + 8;
    return word;
  });
}

describe("anchor — locating a model's answer in the page's own words", () => {
  it("finds a phrase and reports where it sits", () => {
    const rows = [row(40, "Muster", "Bauspar", "AG"), row(80, "Postfach", "1307")];
    const found = anchor("Muster Bauspar AG", rows);
    expect(found?.text).toBe("Muster Bauspar AG");
    expect(found?.bbox.top).toBe(40);
    expect(found?.similarity).toBe(1);
  });

  it("spans a row boundary", () => {
    // The case the whole anchor exists for: a letterhead set across two lines.
    // A matcher confined to one row finds only half the name.
    const rows = [row(40, "Muster", "Bauspar"), row(70, "Bauspar", "AG")];
    const found = anchor("Muster Bauspar Bauspar AG", rows);
    expect(found?.bbox.top).toBe(40);
    expect(found?.bbox.bottom).toBe(90);
  });

  it("survives the misreadings the pipeline exists to repair", () => {
    // The model and the OCR disagree about exactly the glyphs in question.
    // Demanding equality would reject the answers worth having.
    const rows = [row(40, "Muster", "Bauspar", "A6")];
    expect(anchor("Muster Bauspar AG", rows)?.similarity).toBeGreaterThan(0.8);
  });

  it("refuses an answer the page does not carry", () => {
    // The property that keeps a hallucinated sender out of the database.
    const rows = [row(40, "Muster", "Bauspar", "AG")];
    expect(anchor("Ein voellig anderes Unternehmen", rows)).toBeNull();
  });

  it("is indifferent to how either side split the words", () => {
    // The model returns prose, the OCR returns boxes, and they break a name
    // differently. Folding drops the spaces, so neither split can matter.
    const rows = [row(40, "Muster-Bauspar", "AG")];
    expect(anchor("Muster Bauspar AG", rows)?.similarity).toBe(1);
  });

  it("locates a date", () => {
    const rows = [row(40, "Deutsche", "Post"), row(70, "24.04.2023")];
    expect(anchor("24.04.2023", rows)?.bbox.top).toBe(70);
  });

  it("ignores an answer too short to identify anything", () => {
    expect(anchor("AG", [row(40, "AG")])).toBeNull();
  });

  it("returns null for a page with no words", () => {
    expect(anchor("Muster Bauspar AG", [])).toBeNull();
  });
});

describe("rankReadings — several places point at the same field", () => {
  const box = { left: 0, top: 0, right: 10, bottom: 10 };
  const reading = (
    value: string,
    source: Reading<string>["source"],
    bbox: Reading<string>["bbox"] = null,
  ): Reading<string> => ({ value, source, bbox });

  it("prefers a value two sources arrived at independently", () => {
    // Agreement outranks everything, including a better-placed lone reading.
    const picked = rankReadings([
      reading("2023-04-24", "vision", box),
      reading("2021-01-18", "scan", box),
      reading("2021-01-18", "classify"),
    ]);
    expect(picked?.value).toBe("2021-01-18");
  });

  it("prefers a reading that was located on the page", () => {
    const picked = rankReadings([reading("A", "classify"), reading("B", "vision", box)]);
    expect(picked?.value).toBe("B");
  });

  it("falls back to source order when nothing else separates them", () => {
    const picked = rankReadings([reading("B", "scan", box), reading("A", "vision", box)]);
    expect(picked?.value).toBe("A");
  });

  it("still takes an unlocated reading over none at all", () => {
    expect(rankReadings([reading("A", "classify")])?.value).toBe("A");
  });

  it("returns null when there is nothing to rank", () => {
    // Distinct from a reading that was found and rejected.
    expect(rankReadings([])).toBeNull();
  });

  it("counts agreement even when neither reading is located", () => {
    const picked = rankReadings([
      reading("A", "vision", box),
      reading("B", "scan"),
      reading("B", "classify"),
    ]);
    expect(picked?.value).toBe("B");
  });
});
