/**
 * Rain over a day of the stay, and what the app offers for it
 * (plan `reise-planen-und-unterwegs.md`, stage 7, step 1).
 *
 * The old planner moved outdoor spots back into the pool when it
 * rained. On a trip of ideas nothing goes back by itself: the
 * travellers put each spot on its day, so the weather may only offer
 * to move it to another day. Two offers, both shown first and applied
 * only when somebody taps:
 *
 *   - **Swap the days.** Every spot that may move trades places with
 *     the spots of a drier day. Offered only when the drier day holds
 *     nothing outdoors, otherwise the swap would carry its outdoor
 *     spots into the rain.
 *   - **Move only the outdoor spots** to the drier day.
 *
 * What never moves: a spot that is done or skipped (the diary) and a
 * spot a fixed time belongs to (a ticket, the light, a reservation). A fixed time belongs
 * to its date, so its spot stays with it; the sheet says so.
 *
 * Pure: days, forecast classes and today in, notes out.
 */

import type { DayWalk } from "./day-walk";
import { shelterOf } from "./shelter";
import { travelLeg } from "./travel";

/** How wet a day is, 0 dry, 1 showers, 2 wet. Absent: no forecast. */
export type Wetness = 0 | 1 | 2;

export interface NoteStop {
  osmRef: string;
  name: string;
  category: string;
  kind?: string | null;
  /** Planned, and no fixed time hangs on it. */
  movable: boolean;
  /** Why it stays, when it does not move: "Termin 14:00" and the like. */
  staysBecause?: string;
}

export interface NoteDay {
  dayIndex: number;
  /** Before today: never a source and never a target. */
  past: boolean;
  /** Where the day begins and ends; two days only trade at the same place. */
  walk: DayWalk;
  stops: NoteStop[];
}

export interface DayWeather {
  wetness: Wetness;
  /** First hour of rain within the day's window, in minutes of the day. */
  rainFromMinutes: number | null;
  /** Highest temperature in the window. */
  temperatureC: number | null;
}

export interface SpotName {
  osmRef: string;
  name: string;
}

export interface SwapOffer {
  withDayIndex: number;
  /** What the rainy day gets from the drier one. */
  gets: SpotName[];
  /** What the drier day gets from the rainy one. */
  gives: SpotName[];
  /** What stays on either day, with the reason. */
  stays: Array<SpotName & { dayIndex: number; because: string }>;
}

export interface OutdoorOffer {
  toDayIndex: number;
  moves: SpotName[];
}

export interface WeatherNote {
  dayIndex: number;
  wetness: 1 | 2;
  rainFromMinutes: number | null;
  temperatureC: number | null;
  /** The movable outdoor spots this note is about. */
  outdoor: SpotName[];
  /** The drier day, with its weather, when there is one. */
  drierDayIndex: number | null;
  drierWetness: Wetness | null;
  swap: SwapOffer | null;
  outdoorMove: OutdoorOffer | null;
}

export interface StopMove {
  osmRef: string;
  name: string;
  fromDayIndex: number;
  toDayIndex: number;
}

/** Within a hundred metres is the same place. */
function samePlace(a: DayWalk, b: DayWalk): boolean {
  const near = (p: DayWalk["start"], q: DayWalk["start"]) => travelLeg(p, q, "foot").distanceM <= 100;
  return near(a.start, b.start) && near(a.end, b.end);
}

function isOutdoor(stop: NoteStop): boolean {
  return shelterOf(stop.category, stop.kind) === "outdoor";
}

const named = (stop: NoteStop): SpotName => ({ osmRef: stop.osmRef, name: stop.name });

/**
 * One note per day with rain and at least one outdoor spot that may
 * move. A day with rain but nothing outdoors needs no note: the
 * museum does not mind.
 */
export function weatherNotes(
  days: readonly NoteDay[],
  weather: ReadonlyMap<number, DayWeather>,
): WeatherNote[] {
  const notes: WeatherNote[] = [];
  for (const day of days) {
    const here = weather.get(day.dayIndex);
    if (day.past || !here || here.wetness === 0) continue;
    const outdoor = day.stops.filter((stop) => stop.movable && isOutdoor(stop));
    if (outdoor.length === 0) continue;

    const target = drierDay(day, days, weather, here.wetness);
    const note: WeatherNote = {
      dayIndex: day.dayIndex,
      wetness: here.wetness,
      rainFromMinutes: here.rainFromMinutes,
      temperatureC: here.temperatureC,
      outdoor: outdoor.map(named),
      drierDayIndex: target?.dayIndex ?? null,
      drierWetness: target ? weather.get(target.dayIndex)!.wetness : null,
      swap: null,
      outdoorMove: null,
    };
    if (target) {
      note.outdoorMove = { toDayIndex: target.dayIndex, moves: outdoor.map(named) };
      const theirs = target.stops.filter((stop) => stop.movable);
      // A swap that carried the drier day's outdoor spots into the rain
      // would only move the problem.
      if (!theirs.some(isOutdoor)) {
        note.swap = {
          withDayIndex: target.dayIndex,
          gets: theirs.map(named),
          gives: day.stops.filter((stop) => stop.movable).map(named),
          stays: [day, target].flatMap((d) => d.stops
            .filter((stop) => !stop.movable && stop.staysBecause)
            .map((stop) => ({ ...named(stop), dayIndex: d.dayIndex, because: stop.staysBecause! }))),
        };
      }
    }
    notes.push(note);
  }
  return notes;
}

/**
 * The driest other day of the stay with a forecast, a full class drier
 * and at the same place; the nearest one when several are as dry.
 */
function drierDay(
  day: NoteDay,
  days: readonly NoteDay[],
  weather: ReadonlyMap<number, DayWeather>,
  wetness: Wetness,
): NoteDay | null {
  const candidates = days
    .filter((other) => other.dayIndex !== day.dayIndex && !other.past)
    .filter((other) => {
      const there = weather.get(other.dayIndex);
      return there !== undefined && there.wetness <= wetness - 1;
    })
    .filter((other) => samePlace(day.walk, other.walk));
  candidates.sort((a, b) =>
    weather.get(a.dayIndex)!.wetness - weather.get(b.dayIndex)!.wetness
      || Math.abs(a.dayIndex - day.dayIndex) - Math.abs(b.dayIndex - day.dayIndex)
      || a.dayIndex - b.dayIndex);
  return candidates[0] ?? null;
}

/** The moves an offer stands for, so applying and undoing are the same call. */
export function movesOf(note: WeatherNote, kind: "swap" | "outdoor"): StopMove[] | null {
  if (kind === "swap") {
    const swap = note.swap;
    if (!swap) return null;
    return [
      ...swap.gives.map((spot) => ({ ...spot, fromDayIndex: note.dayIndex, toDayIndex: swap.withDayIndex })),
      ...swap.gets.map((spot) => ({ ...spot, fromDayIndex: swap.withDayIndex, toDayIndex: note.dayIndex })),
    ];
  }
  const move = note.outdoorMove;
  if (!move) return null;
  return move.moves.map((spot) => ({ ...spot, fromDayIndex: note.dayIndex, toDayIndex: move.toDayIndex }));
}

/** The sentence for the journal ("Änderungen"). */
export function describeMoves(kind: "swap" | "outdoor", moves: readonly StopMove[], dayLabel: (i: number) => string): string {
  if (moves.length === 0) return "Nichts verschoben";
  const first = moves[0];
  if (kind === "swap") {
    return `Wegen Regen ${dayLabel(first.fromDayIndex)} und ${dayLabel(first.toDayIndex)} getauscht`;
  }
  const names = moves.map((move) => move.name).join(", ");
  return `Wegen Regen ${names} auf ${dayLabel(first.toDayIndex)} verschoben`;
}

/**
 * Summarise the forecast hours of a day's window into a class.
 *
 * Kept here rather than reusing a block summary: a day of ideas is one
 * window, and the note wants the hour the rain starts, which a block
 * summary does not keep.
 */
export function dayWeatherOf(
  hours: ReadonlyArray<{ minutes: number; precipitationMm: number; temperatureC: number }>,
): DayWeather | null {
  if (hours.length === 0) return null;
  const total = hours.reduce((sum, hour) => sum + Math.max(0, hour.precipitationMm), 0);
  // The same boundaries as `weather.ts`: 0.2 mm is a hood up, 2 mm a
  // day you would rather spend indoors.
  const wetness: Wetness = total >= 2 ? 2 : total >= 0.2 ? 1 : 0;
  const rainy = hours.find((hour) => hour.precipitationMm >= 0.1);
  return {
    wetness,
    rainFromMinutes: wetness > 0 && rainy ? rainy.minutes : null,
    temperatureC: Math.round(Math.max(...hours.map((hour) => hour.temperatureC))),
  };
}
