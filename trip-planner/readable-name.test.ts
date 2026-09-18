import { describe, expect, it } from "vitest";
import { displayName, hasLatinLetters, readableName } from "./readable-name";

describe("hasLatinLetters", () => {
  it("accepts what a German reader can read", () => {
    for (const name of ["Marienplatz", "Café Beispielhof", "Tokyo Skytree", "Aïn Diab"]) {
      expect(hasLatinLetters(name)).toBe(true);
    }
  });

  it("rejects scripts that share no letters with it", () => {
    for (const name of ["東京国立博物館", "מוזיאון ישראל", "Εθνικό Μουσείο", "Эрмитаж", "วัดโพธิ์"]) {
      expect(hasLatinLetters(name)).toBe(false);
    }
  });

  it("does not count digits or punctuation as letters", () => {
    expect(hasLatinLetters("1-2-3")).toBe(false);
    expect(hasLatinLetters("№ 5 (東)")).toBe(false);
  });
});

describe("readableName", () => {
  it("keeps a local name that can be read", () => {
    // The ordinary European case — and the one that must not change.
    // "Marienplatz" is what the signs say and what everybody calls it;
    // an English name a mapper added for tourists does not beat it.
    expect(readableName({
      name: "Marienplatz", nameDe: "Marienplatz", nameEn: "St Mary's Square",
    })).toEqual({ display: "Marienplatz", local: null });
  });

  it("prefers the German name where the local one is unreadable", () => {
    expect(readableName({
      name: "東京国立博物館",
      nameDe: "Tokioter Nationalmuseum",
      nameEn: "Tokyo National Museum",
    })).toEqual({ display: "Tokioter Nationalmuseum", local: "東京国立博物館" });
  });

  it("falls back to English when there is no German one", () => {
    expect(readableName({
      name: "מוזיאון ישראל", nameDe: null, nameEn: "Israel Museum",
    })).toEqual({ display: "Israel Museum", local: "מוזיאון ישראל" });
  });

  it("keeps the local name when nothing else exists", () => {
    // Hard to read beats not there at all, and inventing a
    // transliteration would be inventing data (§15.3).
    expect(readableName({ name: "วัดโพธิ์", nameDe: null, nameEn: null }))
      .toEqual({ display: "วัดโพธิ์", local: null });
  });

  it("uses a translation when the place has no local name at all", () => {
    expect(readableName({ name: null, nameDe: "Altes Rathaus", nameEn: "Old Town Hall" }))
      .toEqual({ display: "Altes Rathaus", local: null });
  });

  it("has nothing to say about a place with no name", () => {
    expect(readableName({ name: null, nameDe: null, nameEn: null }))
      .toEqual({ display: null, local: null });
  });

  it("treats blank strings as absent", () => {
    expect(displayName({ name: "  ", nameDe: "", nameEn: "Israel Museum" }))
      .toBe("Israel Museum");
  });

  it("carries the local name only when it differs from what is shown", () => {
    // Nothing is gained by printing the same string twice.
    expect(readableName({ name: "Marienplatz", nameDe: null, nameEn: null }).local).toBeNull();
  });

  describe("German exonyms (§10.4)", () => {
    it("shows the German name of a place that has one, with the local one beside it", () => {
      // Nobody standing in Rome says "wir gehen zum Colosseo" — but
      // that is what the ticket says, so it comes along.
      expect(readableName({
        name: "Colosseo",
        nameDe: "Kolosseum",
        nameEn: "Colosseum",
        wikidataQid: "Q10285",
      })).toEqual({ display: "Kolosseum", local: "Colosseo" });
    });

    it("counts a Wikipedia article as the same kind of evidence", () => {
      expect(readableName({
        name: "Praha",
        nameDe: "Prag",
        nameEn: "Prague",
        wikipedia: "cs:Praha",
      })).toEqual({ display: "Prag", local: "Praha" });
    });

    it("leaves an ordinary place alone, whatever somebody translated it to", () => {
      // A village church with a helpfully translated name:de. The
      // translation stands on no sign and is on no map the traveller
      // will hold, so the local name stays.
      expect(readableName({
        name: "Église Saint-Nicolas",
        nameDe: "Kirche des heiligen Nikolaus",
        nameEn: null,
      })).toEqual({ display: "Église Saint-Nicolas", local: null });
    });

    it("does not print one name twice when German and local agree", () => {
      expect(readableName({
        name: "Marienplatz",
        nameDe: "Marienplatz",
        nameEn: null,
        wikidataQid: "Q161819",
      })).toEqual({ display: "Marienplatz", local: null });
    });

    it("ignores a German name that differs only in accents or case", () => {
      // "Cafe Central" is the worse spelling of the same name, not a
      // different one — promoting it would drop the accent and then
      // claim the accented form is something else.
      expect(readableName({
        name: "Café Central",
        nameDe: "Cafe central",
        nameEn: null,
        wikidataQid: "Q42",
      })).toEqual({ display: "Café Central", local: null });
    });

    it("never promotes an English name over the local one", () => {
      // `name:en` is often a label added for tourists; the sign, the
      // map and everybody nearby say the local one.
      expect(readableName({
        name: "Piazza del Duomo",
        nameDe: null,
        nameEn: "Cathedral Square",
        wikidataQid: "Q42",
      })).toEqual({ display: "Piazza del Duomo", local: null });
    });

    it("still reaches for German where the script cannot be read at all", () => {
      // The older rule, unchanged: prominence has nothing to do with
      // whether somebody can read 東京国立博物館.
      expect(readableName({
        name: "東京国立博物館",
        nameDe: "Nationalmuseum Tokio",
        nameEn: "Tokyo National Museum",
      })).toEqual({ display: "Nationalmuseum Tokio", local: "東京国立博物館" });
    });
  });
});
