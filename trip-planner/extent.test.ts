/**
 * A spot with an extent (§4.7): the day goes on from where it ends.
 * Places are invented.
 */
import { describe, expect, it } from "vitest";
import { extentOf, leaveFrom, storedExtent, MAX_EXTENT_M } from "./extent";

const START = { lat: 45.88, lon: 10.84 };
/** North of the start by roughly `metres`. */
function north(metres: number) {
  return { lat: START.lat + metres / 111_320, lon: START.lon };
}

describe("leaveFrom", () => {
  it("is the spot itself for a point", () => {
    expect(leaveFrom({ ...START })).toEqual(START);
    expect(leaveFrom({ ...START, extent: null })).toEqual(START);
  });

  it("is the far end for a route", () => {
    const end = north(8_000);
    expect(leaveFrom({ ...START, extent: { end } })).toEqual(end);
  });
});

describe("extentOf", () => {
  it("is null when nothing was given", () => {
    expect(extentOf(START, undefined)).toBeNull();
    expect(extentOf(START, {})).toBeNull();
    expect(extentOf(START, { end: null })).toBeNull();
  });

  it("keeps the end, and length and ascent where given", () => {
    const end = north(8_000);
    expect(extentOf(START, { end, lengthM: 10_400.4, ascentM: 610 })).toEqual({
      end,
      lengthM: 10_400,
      ascentM: 610,
    });
    expect(extentOf(START, { end })).toEqual({ end });
  });

  it("refuses a length or an ascent without an end", () => {
    expect(() => extentOf(START, { lengthM: 5_000 })).toThrow(/Endpunkt/);
    expect(() => extentOf(START, { ascentM: 100 })).toThrow(/Endpunkt/);
  });

  it("refuses two ends farther apart than a block can hold", () => {
    // Half a country apart is a transfer between legs, not a route.
    expect(() => extentOf(START, { end: north(MAX_EXTENT_M + 5_000) })).toThrow(/Transfer/);
  });

  it("refuses a length shorter than the straight line", () => {
    expect(() => extentOf(START, { end: north(8_000), lengthM: 3_000 })).toThrow(/Luftlinie/);
  });

  it("refuses coordinates that are not ones", () => {
    expect(() => extentOf(START, { end: { lat: 95, lon: 10 } })).toThrow(/Koordinate/);
    expect(() => extentOf(START, { end: { lat: Number.NaN, lon: 10 } })).toThrow(/Koordinate/);
  });

  it("refuses a negative ascent and a non-positive length", () => {
    expect(() => extentOf(START, { end: north(8_000), ascentM: -5 })).toThrow(/Anstieg/);
    expect(() => extentOf(START, { end: north(8_000), lengthM: 0 })).toThrow(/Länge/);
  });
});

describe("storedExtent", () => {
  it("reads back what was written, and nothing for anything else", () => {
    const end = north(8_000);
    expect(storedExtent({ end, lengthM: 10_000 })).toEqual({ end, lengthM: 10_000 });
    expect(storedExtent(null)).toBeUndefined();
    expect(storedExtent(undefined)).toBeUndefined();
    expect(storedExtent({})).toBeUndefined();
    expect(storedExtent({ end: { lat: "x" } })).toBeUndefined();
  });
});
