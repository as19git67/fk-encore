/**
 * Hard clock times: the frame of a day, not its content (§4.4).
 *
 * The concept avoids clock times on purpose — a day is blocks, not a
 * timetable. But some times are unavoidable: the last train back, a
 * booked slot, check-in from 15:00, the ferry. The division of labour
 * is this module's whole idea:
 *
 *   - **Fixpoints are absolute.** They carry a real time and span the
 *     frame of the day.
 *   - **Blocks are relative.** They fill the space in between and keep
 *     their coarse nature.
 *
 * So this never places a spot and never touches an order. It does one
 * thing: work out how many minutes each block actually has left once
 * the fixpoints have taken theirs, and say plainly which block lost
 * them. The solver then fills the smaller budget exactly as it filled
 * the larger one, and the day gets tighter towards a hard edge without
 * anything else in the planner learning what a clock is.
 *
 * A fixpoint at the end of the day is computed **backwards**: from the
 * train go the way to the station and a safety buffer, and what remains
 * is the last block's budget. The buffer is negotiable but never zero —
 * missing a train costs more than a skipped spot.
 *
 * Everything here is pure: minutes since midnight in, minutes out. No
 * dates, no timezones, no clock. A day plan computed on the device in a
 * dead spot gets the same answer as the server.
 */

import type { PlannedBlockShape } from "./blocks";

/** 09:00 — when a day is assumed to start if nobody says otherwise. */
export const DEFAULT_DAY_START_MINUTES = 9 * 60;

/**
 * The buffer in front of a fixpoint when the caller names none.
 * Twenty minutes is enough to find the right platform without being so
 * generous that an afternoon disappears into it.
 */
export const DEFAULT_BUFFER_MINUTES = 20;

/**
 * Never zero, whatever the caller asks for. A traveller who sets the
 * buffer to nothing has not decided to run for the train; they have
 * decided not to think about it, and the plan should not help.
 */
export const MIN_BUFFER_MINUTES = 5;

/**
 * Below this a block is not a block any more — it is a gap between two
 * fixpoints that happens to have a name. Dropping it is more honest
 * than showing a "Nachmittag" with room for nothing.
 */
export const MIN_VIABLE_BLOCK_MINUTES = 20;

/**
 * The two shapes a hard time comes in, and the difference is the whole
 * reason this is not one type: after a booked tour you are back and the
 * day goes on, after the last train you are gone. Treating a departure
 * as something to attend plans an evening block behind a train that has
 * already left.
 */
export type FixpointKind = "appointment" | "departure";

export interface Fixpoint {
  /** Stable id, so a caller can match a result back to its own record. */
  id: string;
  label: string;
  /** Defaults to "appointment" — the kind you come back from. */
  kind?: FixpointKind;
  /** Minutes since midnight. 18:40 is 1120. */
  startMinutes: number;
  /**
   * How long the fixpoint itself occupies. Zero for a departure — the
   * train leaving is an instant; a booked museum slot is 90 minutes.
   */
  durationMinutes?: number;
  /**
   * Getting there from wherever the day has reached. The caller
   * estimates this with `travelLeg`; this module only subtracts it,
   * because it has no map.
   */
  travelMinutes?: number;
  /** Safety margin in front. Defaults to 20, floored at 5. */
  bufferMinutes?: number;
}

export interface ScheduledBlock extends PlannedBlockShape {
  /** Minutes since midnight where this block now begins. */
  startMinutes: number;
  /** Budget before the fixpoints took their share. */
  originalBudgetMinutes: number;
}

export interface DroppedBlock {
  id: string;
  label: string;
  /** Plain language, for the sentence shown to the traveller (§8.3). */
  reason: string;
}

export interface ScheduleDayOptions {
  blocks: readonly PlannedBlockShape[];
  /** Sorted or not; this module sorts them. */
  fixpoints?: readonly Fixpoint[];
  /** When the day actually begins. Defaults to 09:00. */
  dayStartMinutes?: number;
  /**
   * When the block list assumes the day begins. Defaults to 09:00, and
   * only matters when it differs from `dayStartMinutes` — which is what
   * an arrival day is: the shape still describes a whole day, but the
   * travellers only get there at four (§4.2).
   *
   * Where the two differ, the blocks the day has already passed are
   * dropped rather than shifted. A "Vormittag" starting at 16:00 would
   * be a lie the rest of the plan then reasons with.
   */
  nominalStartMinutes?: number;
}

export interface ScheduledDay {
  blocks: ScheduledBlock[];
  /** Blocks the fixpoints left no room for, in the order they were lost. */
  dropped: DroppedBlock[];
  /** The fixpoints as applied, sorted and with defaults resolved. */
  fixpoints: ResolvedFixpoint[];
}

export interface ResolvedFixpoint extends Fixpoint {
  kind: FixpointKind;
  durationMinutes: number;
  travelMinutes: number;
  bufferMinutes: number;
  /**
   * When the day has to stop doing anything else: the fixpoint's own
   * time less the way there and the buffer. This is the backward
   * calculation of §4.4, and it is what a block budget is cut against.
   */
  guardStartMinutes: number;
  /**
   * When the day is free again — the fixpoint's own end. For a
   * departure this is the end of the day itself: nothing comes after it.
   */
  endMinutes: number;
}

/**
 * Lay the day's blocks on a notional clock and let the fixpoints take
 * what is theirs.
 *
 * Blocks run back to back from `dayStartMinutes`. Where a block's span
 * overlaps a fixpoint's guarded window, the block loses the overlap;
 * where a fixpoint ends after a block would have started, the block
 * starts later instead. A block left with less than
 * `MIN_VIABLE_BLOCK_MINUTES` is dropped and reported.
 */
export function scheduleDay(opts: ScheduleDayOptions): ScheduledDay {
  const fixpoints = resolveFixpoints(opts.fixpoints ?? []);
  const blocks: ScheduledBlock[] = [];
  const dropped: DroppedBlock[] = [];

  let cursor = opts.dayStartMinutes ?? DEFAULT_DAY_START_MINUTES;
  // Where the shape thinks each block sits. Only consulted until the
  // first block is actually placed: after that the day is relative
  // again and fixpoints push it about freely (§4.1).
  let nominal = opts.nominalStartMinutes ?? DEFAULT_DAY_START_MINUTES;
  let started = false;

  for (const shape of opts.blocks) {
    const nominalStart = nominal;
    const nominalEnd = nominal + shape.budgetMinutes;
    nominal = nominalEnd;

    // A late start does not move the morning, it removes it.
    if (!started && nominalEnd <= cursor) {
      dropped.push({
        id: shape.id,
        label: shape.label,
        reason: `der Tag beginnt erst um ${formatMinutes(cursor)}, „${shape.label}" ist vorbei`,
      });
      continue;
    }

    // A departure whose guard has passed ends the day. Everything from
    // here on is lost, and saying which departure took it is the point.
    const gone = fixpoints.find(
      (f) => f.kind === "departure" && f.guardStartMinutes <= cursor,
    );
    if (gone) {
      dropped.push({
        id: shape.id,
        label: shape.label,
        reason: `${gone.label} beendet den Tag vor „${shape.label}"`,
      });
      continue;
    }

    // An appointment already under way pushes the block back: nobody
    // leaves the booked tour early to start the afternoon on time.
    for (const fix of fixpoints) {
      if (fix.kind !== "appointment") continue;
      if (fix.guardStartMinutes <= cursor && fix.endMinutes > cursor) {
        cursor = fix.endMinutes;
      }
    }

    // The first block the day still catches is entered part-way
    // through: arriving at 16:00 leaves ninety minutes of an afternoon
    // that nominally ran to 17:30, not a fresh full one.
    let budget =
      !started && nominalStart < cursor
        ? Math.max(0, nominalEnd - cursor)
        : shape.budgetMinutes;
    let blame: ResolvedFixpoint | null = null;

    // Each fixpoint that starts inside this block's span cuts it short.
    // Taking the earliest such cut is what makes the last train bind
    // harder than the dinner reservation after it.
    for (const fix of fixpoints) {
      if (fix.guardStartMinutes <= cursor) continue;
      const available = fix.guardStartMinutes - cursor;
      if (available < budget) {
        budget = available;
        blame = fix;
      }
    }

    if (budget < MIN_VIABLE_BLOCK_MINUTES) {
      dropped.push({
        id: shape.id,
        label: shape.label,
        reason: blame
          ? `${blame.label} lässt für „${shape.label}" keine Zeit mehr`
          : `für „${shape.label}" bleibt an diesem Tag keine Zeit`,
      });
      // The block is gone, but the clock is not: an appointment that
      // squeezed it out still has to be attended before the next one.
      if (blame?.kind === "appointment") cursor = Math.max(cursor, blame.endMinutes);
      continue;
    }

    blocks.push({
      ...shape,
      budgetMinutes: budget,
      originalBudgetMinutes: shape.budgetMinutes,
      startMinutes: cursor,
    });
    cursor += budget;
    started = true;
  }

  return { blocks, dropped, fixpoints };
}

/** Defaults resolved, buffer floored, sorted by the time they bind. */
export function resolveFixpoints(fixpoints: readonly Fixpoint[]): ResolvedFixpoint[] {
  return fixpoints
    .map((fix) => {
      const durationMinutes = nonNegative(fix.durationMinutes);
      const travelMinutes = nonNegative(fix.travelMinutes);
      const bufferMinutes = Math.max(
        MIN_BUFFER_MINUTES,
        fix.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
      );
      return {
        ...fix,
        kind: fix.kind ?? "appointment",
        durationMinutes,
        travelMinutes,
        bufferMinutes,
        guardStartMinutes: fix.startMinutes - travelMinutes - bufferMinutes,
        endMinutes: fix.startMinutes + durationMinutes,
      };
    })
    .sort((a, b) => a.guardStartMinutes - b.guardStartMinutes);
}

function nonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/** "18:40" from 1120, for a label. Minutes past a day are wrapped. */
export function formatMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "18:40" to 1120. Returns null for anything that is not a time of day. */
export function parseMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}
