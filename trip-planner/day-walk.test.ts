/**
 * Where a day begins and ends (§4.4, §4.5).
 *
 * The rule is three lines and the bug it fixes was invisible for
 * exactly that reason: on an ordinary day every answer is the same
 * point, so nothing disagrees until the day is a day trip or the day
 * the train leaves.
 */

import { describe, expect, it } from "vitest";
import { dayWalkOf, dayWalkOfStored, endsOfStored } from "./day-walk";

const QUARTERS = { lat: 45.7648, lon: 10.8102 };
const OUTING = { lat: 45.4384, lon: 10.9916 };
const STATION = { lat: 45.4290, lon: 10.9820 };

describe("dayWalkOf", () => {
  it("makes an ordinary day a loop around the quarters", () => {
    expect(dayWalkOf(QUARTERS, null)).toEqual({ start: QUARTERS, end: QUARTERS });
  });

  it("walks a day trip around its own destination", () => {
    // The reported case: the day was planned around the outing, and
    // every rewalk of it used the quarters — an hour of driving charged
    // to a morning block nobody had touched (§4.5).
    expect(dayWalkOf(QUARTERS, OUTING)).toEqual({ start: OUTING, end: OUTING });
  });

  it("starts where the arrival left the group", () => {
    const ends = { start: { ...STATION, label: "Ankunft" }, end: null };
    expect(dayWalkOf(QUARTERS, null, ends)).toEqual({ start: STATION, end: QUARTERS });
  });

  it("ends at the platform on the day the train leaves", () => {
    // After the last train the walk back to the hotel is a walk nobody
    // makes, and planning it costs the evening a stop (§4.4).
    const ends = { start: null, end: { ...STATION, label: "Abfahrt" } };
    expect(dayWalkOf(QUARTERS, null, ends)).toEqual({ start: QUARTERS, end: STATION });
  });

  it("lets a fixpoint outrank the day's own anchor", () => {
    // Both can be true at once: a day out that ends at a station is a
    // transfer day, and it starts where the outing is.
    const ends = { start: null, end: { ...STATION, label: "Abfahrt" } };
    expect(dayWalkOf(QUARTERS, OUTING, ends)).toEqual({ start: OUTING, end: STATION });
  });

  it("ignores a fixpoint that names no place", () => {
    // A booked slot without a coordinate says nothing about where the
    // day happens, and treating it as the origin would put the day at
    // latitude null.
    const ends = { start: null, end: null };
    expect(dayWalkOf(QUARTERS, null, ends)).toEqual({ start: QUARTERS, end: QUARTERS });
    expect(dayWalkOf(QUARTERS, { lat: Number.NaN, lon: 10 })).toEqual({
      start: QUARTERS,
      end: QUARTERS,
    });
  });
});

describe("dayWalkOfStored", () => {
  it("reads a stored day trip", () => {
    const day = {
      anchor: { lat: OUTING.lat, lon: OUTING.lon },
      fixpoints: [],
      blocks: [{ startMinutes: 9 * 60 }],
    };
    expect(dayWalkOfStored(QUARTERS, day)).toEqual({ start: OUTING, end: OUTING });
  });

  it("reads a stored departure", () => {
    const day = {
      anchor: null,
      fixpoints: [{
        label: "Zug",
        kind: "departure" as const,
        startMinutes: 17 * 60 + 45,
        durationMinutes: 0,
        lat: STATION.lat,
        lon: STATION.lon,
      }],
      blocks: [{ startMinutes: 9 * 60 }],
    };
    expect(dayWalkOfStored(QUARTERS, day)).toEqual({ start: QUARTERS, end: STATION });
  });

  it("counts a fixpoint's duration when deciding it is before the day", () => {
    // An arrival at 8:00 that lets go at 9:30 has not finished before a
    // day starting at 9:00 — it is not the day's origin. Getting the
    // end minutes wrong here is exactly the mistake a caller writing
    // this mapping by hand makes.
    const arrival = {
      label: "Ankunft",
      kind: "appointment" as const,
      startMinutes: 8 * 60,
      lat: STATION.lat,
      lon: STATION.lon,
    };
    const before = endsOfStored({
      anchor: null,
      fixpoints: [{ ...arrival, durationMinutes: 30 }],
      blocks: [{ startMinutes: 9 * 60 }],
    });
    const overlapping = endsOfStored({
      anchor: null,
      fixpoints: [{ ...arrival, durationMinutes: 90 }],
      blocks: [{ startMinutes: 9 * 60 }],
    });
    expect(before.start?.lat).toBe(STATION.lat);
    expect(overlapping.start).toBeNull();
  });

  it("takes no notice of a block without an hour", () => {
    // A day at trip resolution has blocks with no start (§4.3); they
    // must not be read as "the day begins at midnight".
    const ends = endsOfStored({
      anchor: null,
      fixpoints: [{
        label: "Ankunft",
        kind: "appointment" as const,
        startMinutes: 8 * 60,
        durationMinutes: 30,
        lat: STATION.lat,
        lon: STATION.lon,
      }],
      blocks: [{ startMinutes: null }],
    });
    expect(ends.start).toBeNull();
  });

  it("falls back to the leg for a day that says nothing", () => {
    expect(dayWalkOfStored(QUARTERS, {})).toEqual({ start: QUARTERS, end: QUARTERS });
  });
});
