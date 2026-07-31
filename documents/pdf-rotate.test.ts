import { describe, it, expect } from "vitest";
import {
  pageLooksRotated,
  parseWordBoxes,
  rotateArgs,
  type WordBox,
} from "./pdf-rotate";

/** An upright word box: wider than tall, roughly 7pt per character. */
function upright(text: string, x = 100, y = 700): WordBox {
  return { text, xMin: x, yMin: y, xMax: x + text.length * 7, yMax: y + 10 };
}

/** The same word drawn sideways: the box swaps its axes. */
function sideways(text: string, x = 60, y = 600): WordBox {
  return { text, xMin: x, yMin: y, xMax: x + 10, yMax: y + text.length * 7 };
}

describe("parseWordBoxes", () => {
  it("reads the pages and word boxes pdftotext -bbox emits", () => {
    // Shape and numbers taken from real output for the document that prompted
    // this: an A4 page whose content is drawn rotated 90°.
    const xml = `<doc>
  <page width="595.275600" height="841.889800">
    <word xMin="59.344900" yMin="599.788700" xMax="65.344900" yMax="656.806700">Verwendungszweck</word>
    <word xMin="59.344900" yMin="754.744200" xMax="65.344900" yMax="773.410200">Datum</word>
  </page>
</doc>`;

    const pages = parseWordBoxes(xml);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    expect(pages[0].words).toHaveLength(2);
    expect(pages[0].words[0]).toEqual({
      text: "Verwendungszweck",
      xMin: 59.3449,
      yMin: 599.7887,
      xMax: 65.3449,
      yMax: 656.8067,
    });
  });

  it("numbers pages in document order", () => {
    const page = (w: string) =>
      `<page width="595" height="842"><word xMin="1" yMin="1" xMax="9" yMax="5">${w}</word></page>`;
    const pages = parseWordBoxes(`<doc>${page("eins")}${page("zwei")}${page("drei")}</doc>`);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.words[0].text)).toEqual(["eins", "zwei", "drei"]);
  });

  it("decodes entities and drops empty or unparseable words", () => {
    const xml = `<doc><page width="595" height="842">
      <word xMin="1" yMin="1" xMax="9" yMax="5">R&amp;V</word>
      <word xMin="1" yMin="1" xMax="9" yMax="5">   </word>
      <word xMin="x" yMin="1" xMax="9" yMax="5">kaputt</word>
    </page></doc>`;
    expect(parseWordBoxes(xml)[0].words.map((w) => w.text)).toEqual(["R&V"]);
  });

  it("returns nothing for output it does not understand", () => {
    expect(parseWordBoxes("")).toEqual([]);
    expect(parseWordBoxes("<html><body>kein bbox</body></html>")).toEqual([]);
  });
});

describe("pageLooksRotated", () => {
  it("flags a page whose words are taller than wide", () => {
    const words = ["Verwendungszweck", "Buchungstext", "Betrag", "Datum", "Summe", "Roland"].map(
      (w) => sideways(w),
    );
    expect(pageLooksRotated(words)).toBe(true);
  });

  it("leaves a normal upright page alone", () => {
    const words = ["Rechnung", "Betrag", "Datum", "Summe", "Kunde", "Nummer"].map((w) => upright(w));
    expect(pageLooksRotated(words)).toBe(false);
  });

  it("is not fooled by a rotated stamp on an upright page", () => {
    const words = [
      ...["Rechnung", "Betrag", "Datum", "Summe", "Kunde", "Nummer", "Zahlung", "Konto"].map((w) =>
        upright(w),
      ),
      sideways("BEZAHLT"),
      sideways("KOPIE"),
    ];
    expect(pageLooksRotated(words)).toBe(false);
  });

  it("ignores short words, which are too square to judge", () => {
    // Only 2-character words, all tall — not enough measurable evidence.
    const words = ["AG", "GB", "ff", "zu", "an", "im"].map((w) => sideways(w));
    expect(pageLooksRotated(words)).toBe(false);
  });

  it("stays quiet on a page with almost no text", () => {
    expect(pageLooksRotated([])).toBe(false);
    expect(pageLooksRotated([sideways("Seite"), sideways("eins")])).toBe(false);
  });
});

describe("rotateArgs", () => {
  it("builds one argument per angle, with its pages", () => {
    expect(rotateArgs(new Map([[1, 90]]))).toEqual(["--rotate=+90:1"]);
  });

  it("groups pages that share an angle and orders them", () => {
    const args = rotateArgs(new Map([[3, 90], [1, 90], [2, 180]]));
    expect(args).toEqual(["--rotate=+90:1,3", "--rotate=+180:2"]);
  });

  it("skips pages that need no rotation", () => {
    expect(rotateArgs(new Map([[1, 0], [2, 270]]))).toEqual(["--rotate=+270:2"]);
    expect(rotateArgs(new Map([[1, 0]]))).toEqual([]);
    expect(rotateArgs(new Map())).toEqual([]);
  });
});
