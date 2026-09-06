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
});
