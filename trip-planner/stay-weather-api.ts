/**
 * The weather notes of a stay and applying one (stage 7, step 1 of
 * `reise-planen-und-unterwegs.md`). The rules are in `stay-weather.ts`;
 * this reads the forecast for the stay's days, asks for the notes and
 * moves the spots when somebody taps. Every apply is a line under
 * "Änderungen" and can be taken back from there.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanOps } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { dayWalkOfStored } from "./day-walk";
import { addDays } from "./leg-dates";
import { MoveError, moveStop } from "./move";
import { loadPlan, saveMovedDays, type StoredDay, type StoredLeg, type StoredPlan } from "./plan-store";
import { offsetMinutes, zoneAt } from "./time-zone";
import { forecastFor } from "./weather-service";
import {
  dayWeatherOf,
  describeMoves,
  movesOf,
  weatherNotes,
  type DayWeather,
  type NoteDay,
  type StopMove,
  type WeatherNote,
} from "./stay-weather";
import type { CurrentBlock } from "./redistribute";

/** The journal kind of a batch of moved spots; undone by moving them back. */
export const MOVE_STOPS_OP = "move-stops";
export const MOVE_STOPS_UNDO_OP = "move-stops-undo";

export interface WeatherNotesRequest {
  planId: number;
  legIndex: number;
}

export interface WeatherNotesResponse {
  notes: WeatherNote[];
  /** The forecast could not be fetched; the notes may be missing days. */
  degraded: boolean;
}

export const stayWeatherNotes = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/legs/:legIndex/weather-notes", auth: true },
  async (req: WeatherNotesRequest): Promise<WeatherNotesResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);
    const { notes, degraded } = await notesOf(leg);
    return { notes, degraded };
  },
);

export interface ApplyWeatherNoteRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  /** "swap": trade the days; "outdoor": move only the outdoor spots. */
  kind: string;
}

export interface ApplyWeatherNoteResponse {
  plan: StoredPlan;
  /** What happened, in a sentence for the undo bar. */
  sentence: string;
  /** The journal entry; `POST …/ops/undo` with it takes the change back. */
  opId: number;
}

export const applyStayWeatherNote = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/legs/:legIndex/weather-notes/apply",
    auth: true,
  },
  async (req: ApplyWeatherNoteRequest): Promise<ApplyWeatherNoteResponse> => {
    const userId = requireUser();
    if (req.kind !== "swap" && req.kind !== "outdoor") {
      throw APIError.invalidArgument("kind must be \"swap\" or \"outdoor\"");
    }
    const kind = req.kind;
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);

    // Recomputed rather than replayed: the day may have changed since
    // the note was shown, and moving what is no longer there would be
    // a change nobody saw.
    const { notes } = await notesOf(leg);
    const note = notes.find((n) => n.dayIndex === req.dayIndex);
    const moves = note ? movesOf(note, kind) : null;
    if (!moves || moves.length === 0) {
      throw APIError.failedPrecondition("für diesen Tag gibt es diesen Vorschlag nicht mehr");
    }

    await applyStopMoves(plan, leg, moves);
    const sentence = describeMoves(kind, moves, (i) => dayLabel(leg, i));
    const [op] = await db
      .insert(tripPlanOps)
      .values({
        plan_id: plan.id,
        client_op_id: `weather-${crypto.randomUUID()}`,
        kind: MOVE_STOPS_OP,
        payload: { legIndex: leg.position, moves, sentence },
        actor_id: userId,
      })
      .returning({ id: tripPlanOps.id });

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while moving spots for the weather");
    return { plan: updated, sentence, opId: op.id };
  },
);

/**
 * Move spots between the days of one stay, each to the end of its new
 * day. A spot no longer on the stay, or already on the day it goes to,
 * is left alone: that is what makes the undo of a later-edited day
 * safe rather than an error.
 */
export async function applyStopMoves(
  plan: StoredPlan,
  leg: StoredLeg,
  moves: ReadonlyArray<Pick<StopMove, "osmRef" | "toDayIndex">>,
): Promise<void> {
  const blocksByDay = new Map<number, CurrentBlock[]>(
    leg.days.map((day) => [day.dayIndex, day.blocks as CurrentBlock[]]),
  );
  const changed = new Set<number>();
  for (const move of moves) {
    const fromDay = leg.days.find((day) =>
      blocksByDay.get(day.dayIndex)!.some((block) => block.stops.some((stop) => stop.osmRef === move.osmRef)));
    const toDay = leg.days.find((day) => day.dayIndex === move.toDayIndex);
    if (!fromDay || !toDay || fromDay.dayIndex === toDay.dayIndex) continue;
    const fromBlocks = blocksByDay.get(fromDay.dayIndex)!;
    const toBlocks = blocksByDay.get(toDay.dayIndex)!;
    const host = fromBlocks.find((block) => block.stops.some((stop) => stop.osmRef === move.osmRef))!;
    const target = toBlocks.find((block) => block.id === host.id)
      ?? toBlocks.find((block) => block.kind !== "meal")
      ?? toBlocks[0];
    if (!target) continue;
    try {
      const moved = moveStop({
        fromBlocks,
        toBlocks,
        osmRef: move.osmRef,
        toBlockId: target.id,
        walk: dayWalkOfStored(leg.anchor, fromDay),
        toWalk: dayWalkOfStored(leg.anchor, toDay),
        mode: leg.mode,
      });
      blocksByDay.set(fromDay.dayIndex, moved.fromBlocks);
      blocksByDay.set(toDay.dayIndex, moved.toBlocks);
      changed.add(fromDay.dayIndex).add(toDay.dayIndex);
    } catch (err) {
      if (err instanceof MoveError) continue;
      throw err;
    }
  }
  if (changed.size === 0) return;
  await saveMovedDays(plan.id, leg.days
    .filter((day) => changed.has(day.dayIndex))
    .map((day) => ({ day, blocks: blocksByDay.get(day.dayIndex)! })));
}

async function notesOf(leg: StoredLeg, now: Date = new Date()): Promise<{ notes: WeatherNote[]; degraded: boolean }> {
  const startDate = leg.startDate;
  if (startDate === null || leg.kind === "transit") return { notes: [], degraded: false };
  const zone = zoneAt(leg.anchor);
  const days = leg.days.filter((day) => day.detailed);
  const dates = days.map((day) => addDays(startDate, day.dayIndex));
  // The cache files hours by their UTC date, so a local day can reach
  // into the dates either side.
  const wanted = [...new Set(dates.flatMap((date) => [addDays(date, -1), date, addDays(date, 1)]))];
  const { byDay, degraded } = await forecastFor(leg.anchor, wanted, now);
  const hours = [...byDay.values()].flat();

  const today = localToday(zone, now);
  const weather = new Map<number, DayWeather>();
  const noteDays: NoteDay[] = [];
  for (const day of days) {
    const date = addDays(startDate, day.dayIndex);
    const offset = (zone ? offsetMinutes(zone, date) : null) ?? 0;
    const { from, to } = windowOf(day);
    const midnight = Date.parse(`${date}T00:00:00Z`) - offset * 60_000;
    const within = hours
      .map((hour) => ({ ...hour, minutes: Math.round((Date.parse(hour.time) - midnight) / 60_000) }))
      .filter((hour) => Number.isFinite(hour.minutes) && hour.minutes + 60 > from && hour.minutes < to)
      .sort((a, b) => a.minutes - b.minutes);
    const summary = dayWeatherOf(within);
    if (summary) weather.set(day.dayIndex, summary);
    noteDays.push({
      dayIndex: day.dayIndex,
      past: date < today,
      walk: dayWalkOfStored(leg.anchor, day),
      stops: day.blocks.flatMap((block) => block.stops).map((stop) => {
        const bound = day.fixpoints.find((fix) => fix.spotRef === stop.osmRef);
        // A fixed time is a fixpoint with this spot (ideas plan): the
        // stop's own `pinned` only says a person put it there, which on
        // a trip of ideas every stop is.
        const staysBecause = bound ? `${bound.label} ${clock(bound.startMinutes)}` : undefined;
        return {
          osmRef: stop.osmRef,
          name: stop.title ?? stop.name ?? "Spot",
          category: stop.category,
          kind: stop.kind ?? null,
          movable: stop.status === "planned" && !bound,
          staysBecause: stop.status === "planned" ? staysBecause : undefined,
        };
      }),
    });
  }
  return { notes: weatherNotes(noteDays, weather), degraded };
}

/** The day's window; a day of ideas has one, an older day its blocks. */
function windowOf(day: StoredDay): { from: number; to: number } {
  if (day.window) return { from: day.window.startMinutes, to: day.window.endMinutes };
  const timed = day.blocks.filter((block) => block.startMinutes !== null);
  if (timed.length === 0) return { from: 9 * 60, to: 19 * 60 };
  return {
    from: Math.min(...timed.map((block) => block.startMinutes!)),
    to: Math.max(...timed.map((block) => block.startMinutes! + block.budgetMinutes)),
  };
}

export function localToday(zone: string | null, now: Date): string {
  if (!zone) return now.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** "Do 26.11.", or "Tag 3" for a stay without a date. */
export function dayLabel(leg: StoredLeg, dayIndex: number): string {
  if (!leg.startDate) return `Tag ${dayIndex + 1}`;
  const date = addDays(leg.startDate, dayIndex);
  const at = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()}.${at.getUTCMonth() + 1}.`;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function legOf(plan: StoredPlan, legIndex: number): StoredLeg {
  const leg = plan.legs.find((candidate) => candidate.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  return leg;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
