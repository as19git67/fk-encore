/**
 * The rules of the weather note of a stay (stage 7, step 1): which day
 * gets a note, which drier day it points at, and what never moves.
 */

import { describe, expect, it } from "vitest";
import { movesOf, weatherNotes, dayWeatherOf, type DayWeather, type NoteDay, type NoteStop } from "./stay-weather";

const HOME = { lat: 48.1, lon: 11.5 };
const walk = { start: HOME, end: HOME };

function stop(osmRef: string, category: string, extra: Partial<NoteStop> = {}): NoteStop {
  return { osmRef, name: osmRef, category, movable: true, ...extra };
}

function day(dayIndex: number, stops: NoteStop[], extra: Partial<NoteDay> = {}): NoteDay {
  return { dayIndex, past: false, walk, stops, ...extra };
}

const wx = (wetness: 0 | 1 | 2): DayWeather => ({ wetness, rainFromMinutes: wetness ? 11 * 60 : null, temperatureC: 13 });

describe("weatherNotes", () => {
  it("offers both the swap and the outdoor move when the drier day is all indoors", () => {
    const days = [
      day(0, [stop("park", "outdoors"), stop("tower", "viewpoint")]),
      day(1, [stop("museum", "museum")]),
    ];
    const [note] = weatherNotes(days, new Map([[0, wx(2)], [1, wx(0)]]));
    expect(note.dayIndex).toBe(0);
    expect(note.outdoor.map((s) => s.osmRef)).toEqual(["park", "tower"]);
    expect(note.drierDayIndex).toBe(1);
    expect(note.swap?.gets.map((s) => s.osmRef)).toEqual(["museum"]);
    expect(note.outdoorMove?.moves.map((s) => s.osmRef)).toEqual(["park", "tower"]);
    expect(movesOf(note, "swap")).toHaveLength(3);
  });

  it("offers no swap that would carry the drier day's outdoor spots into the rain", () => {
    const days = [day(0, [stop("park", "outdoors")]), day(1, [stop("garden", "outdoors")])];
    const [note] = weatherNotes(days, new Map([[0, wx(2)], [1, wx(0)]]));
    expect(note.swap).toBeNull();
    expect(note.outdoorMove?.toDayIndex).toBe(1);
  });

  it("keeps a spot with a fixed time on its day and says why", () => {
    const days = [
      day(0, [stop("park", "outdoors"), stop("tour", "museum", { movable: false, staysBecause: "Führung 14:00" })]),
      day(1, [stop("library", "museum")]),
    ];
    const [note] = weatherNotes(days, new Map([[0, wx(2)], [1, wx(0)]]));
    expect(note.swap?.gives.map((s) => s.osmRef)).toEqual(["park"]);
    expect(note.swap?.stays).toEqual([{ osmRef: "tour", name: "tour", dayIndex: 0, because: "Führung 14:00" }]);
  });

  it("is silent without rain, without outdoor spots, without forecast and for past days", () => {
    const days = [day(0, [stop("museum", "museum")]), day(1, [stop("park", "outdoors")]), day(2, [stop("p2", "outdoors")], { past: true })];
    expect(weatherNotes(days, new Map([[0, wx(2)], [1, wx(0)], [2, wx(2)]]))).toEqual([]);
    expect(weatherNotes([day(0, [stop("park", "outdoors")])], new Map())).toEqual([]);
  });

  it("names no target when no day is a full class drier or the day is elsewhere", () => {
    const away = { start: { lat: 48.6, lon: 11.5 }, end: { lat: 48.6, lon: 11.5 } };
    const days = [day(0, [stop("park", "outdoors")]), day(1, []), day(2, [], { walk: away })];
    const [note] = weatherNotes(days, new Map([[0, wx(1)], [1, wx(1)], [2, wx(0)]]));
    expect(note.drierDayIndex).toBeNull();
    expect(note.swap).toBeNull();
    expect(note.outdoorMove).toBeNull();
  });

  it("prefers the driest day, then the nearest", () => {
    const days = [day(0, [stop("park", "outdoors")]), day(1, []), day(2, []), day(3, [])];
    const [note] = weatherNotes(days, new Map([[0, wx(2)], [1, wx(1)], [2, wx(0)], [3, wx(0)]]));
    expect(note.drierDayIndex).toBe(2);
  });
});

describe("dayWeatherOf", () => {
  it("classes the day and finds the first hour of rain", () => {
    const hours = [9, 10, 11, 12].map((h) => ({ minutes: h * 60, precipitationMm: h >= 11 ? 1.5 : 0, temperatureC: 12 + h / 10 }));
    expect(dayWeatherOf(hours)).toEqual({ wetness: 2, rainFromMinutes: 11 * 60, temperatureC: 13 });
    expect(dayWeatherOf([])).toBeNull();
  });
});
