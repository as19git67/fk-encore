/**
 * Dragging a spot to another block, or another day (§8.4).
 *
 * "Budgets rechnen sich sofort neu, ein überfüllter Block wird rot" is
 * the whole feature, and both halves are arithmetic: after a move the
 * walks either side of the gap and either side of the insertion have
 * changed, so every affected block's used minutes have too.
 *
 * The recomputation walks a whole day rather than patching two blocks,
 * because a block does not start at the anchor — it picks up where the
 * previous block left off, exactly as the solver builds it. Moving the
 * last spot out of the morning therefore changes where the afternoon
 * begins, and a patch of "just the two blocks" would leave the rest of
 * the day describing a walk nobody takes.
 *
 * Two things this deliberately does **not** do:
 *
 *   - **It does not refuse an overfull block.** The concept treats that
 *     as a thing to show, not to prevent: the traveller dragged it
 *     there on purpose, and turning the block red says more than a
 *     rejected gesture (§8.4). The result reports which blocks are over
 *     so the caller can colour them.
 *   - **It does not move anything by itself.** No reflow, no automatic
 *     eviction to make room. That is redistribution's job, asked for
 *     explicitly (§5).
 *
 * Pure: coordinates and minutes in, blocks out. No clock, no database.
 */

import type { CurrentBlock, CurrentStop } from "./redistribute";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

export class MoveError extends Error {}

export interface MoveStopRequest {
  /** The day the stop is leaving, as it stands. */
  fromBlocks: readonly CurrentBlock[];
  /**
   * The day it is joining. The same array as `fromBlocks` for a move
   * within one day — the caller does not have to special-case it.
   */
  toBlocks: readonly CurrentBlock[];
  /**
   * The stop being dragged, by its OSM reference. That rather than a
   * database id keeps this module free of storage concepts, and it is
   * unique within a leg because the solver never plans the same spot
   * twice there.
   */
  osmRef: string;
  /** Template id of the block it is dropped into. */
  toBlockId: string;
  /**
   * Where in that block, counted from zero. Past the end, or omitted,
   * means last.
   */
  toPosition?: number;
  /** Where the day starts and the last block returns to. */
  anchor: Coordinate;
  mode?: TransportMode;
}

export interface MoveStopResult {
  /** The day the stop left, recomputed. */
  fromBlocks: CurrentBlock[];
  /**
   * The day it joined, recomputed. The same array as `fromBlocks` when
   * the move stayed within one day, so a caller that saves both writes
   * the same rows twice rather than losing half the change.
   */
  toBlocks: CurrentBlock[];
  /** Template ids of blocks now over their budget — the red ones (§8.4). */
  overfullBlockIds: string[];
}

export function moveStop(req: MoveStopRequest): MoveStopResult {
  const sameDay = req.fromBlocks === req.toBlocks;
  const mode = req.mode ?? "foot";

  const from = req.fromBlocks.map(cloneBlock);
  const to = sameDay ? from : req.toBlocks.map(cloneBlock);

  const source = from.find((b) => b.stops.some((s) => s.osmRef === req.osmRef));
  if (!source) throw new MoveError(`'${req.osmRef}' is not in this day`);

  const target = to.find((b) => b.id === req.toBlockId);
  if (!target) throw new MoveError(`no block '${req.toBlockId}' in the target day`);
  if (target.kind !== "spots") {
    // A meal block holds time and a rough area, never a venue (§10.3).
    // Dropping a museum into it would quietly make it something it is
    // not, and the day would stop adding up.
    throw new MoveError(`'${req.toBlockId}' holds time, not places — nothing can be dropped in it`);
  }

  const index = source.stops.findIndex((s) => s.osmRef === req.osmRef);
  const [stop] = source.stops.splice(index, 1);

  const at = clampPosition(req.toPosition, target.stops.length);
  target.stops.splice(at, 0, stop);

  recomputeDay(from, req.anchor, mode);
  if (!sameDay) recomputeDay(to, req.anchor, mode);

  const overfull = [...new Set([...from, ...to])]
    .filter((b) => b.usedMinutes > b.budgetMinutes)
    .map((b) => b.id);

  return { fromBlocks: from, toBlocks: to, overfullBlockIds: overfull };
}

export interface InsertStopRequest {
  /** The day it is joining, as it stands. */
  blocks: readonly CurrentBlock[];
  /** The candidate, straight out of the pool. */
  stop: CurrentStop;
  /** Template id of the block it is dropped into. */
  toBlockId: string;
  /** Where in that block, from zero. Past the end, or omitted, means last. */
  toPosition?: number;
  anchor: Coordinate;
  mode?: TransportMode;
}

export interface InsertStopResult {
  blocks: CurrentBlock[];
  overfullBlockIds: string[];
}

/**
 * Put a candidate from the pool into a block (§5, §8.4).
 *
 * The other half of `moveStop`, and separate from it on purpose rather
 * than folded in behind an optional `fromBlocks`: a move takes a stop
 * that is already somewhere and a placement takes one that is nowhere,
 * and the difference decides whether "not in this day" is an error or
 * the precondition. Everything after the splice is shared, because a
 * day that was walked one way by a move and another way by a placement
 * would be two different features wearing one name.
 *
 * It does not refuse an overfull block, for the same reason a move does
 * not: the traveller put it there deliberately, and a red block says
 * more than a rejected gesture.
 */
export function insertStop(req: InsertStopRequest): InsertStopResult {
  const mode = req.mode ?? "foot";
  const blocks = req.blocks.map(cloneBlock);

  if (blocks.some((b) => b.stops.some((s) => s.osmRef === req.stop.osmRef))) {
    // Twice in one day is never what anybody meant, and the second copy
    // would silently eat the budget of the first.
    throw new MoveError(`'${req.stop.osmRef}' is already planned on this day`);
  }

  const target = blocks.find((b) => b.id === req.toBlockId);
  if (!target) throw new MoveError(`no block '${req.toBlockId}' in this day`);
  if (target.kind !== "spots") {
    // A meal block holds time and a rough area, never a venue (§10.3).
    throw new MoveError(`'${req.toBlockId}' holds time, not places — nothing can be dropped in it`);
  }

  const at = clampPosition(req.toPosition, target.stops.length);
  target.stops.splice(at, 0, { ...req.stop });

  recomputeDay(blocks, req.anchor, mode);

  return {
    blocks,
    overfullBlockIds: blocks.filter((b) => b.usedMinutes > b.budgetMinutes).map((b) => b.id),
  };
}

/**
 * Rewalk a whole day: each block starts where the previous one left
 * off, and the last block with spots pays for the way back to the
 * anchor — the same shape the solver builds, so a moved day and a
 * freshly solved one describe the same walk.
 */
export function recomputeDay(
  blocks: CurrentBlock[],
  anchor: Coordinate,
  mode: TransportMode = "foot",
): void {
  let position: Coordinate = anchor;
  const lastWithStops = lastIndexWithStops(blocks);

  blocks.forEach((block, index) => {
    let used = 0;
    for (const stop of block.stops) {
      const leg = travelLeg(position, stop, mode);
      stop.travelFromPrevious = leg;
      // A done or skipped stop is past: it is still on the card and
      // still on the way, but it no longer spends the budget (§5).
      if (stop.status === "planned") used += stop.dwellMinutes + leg.minutes;
      position = { lat: stop.lat, lon: stop.lon };
    }
    if (index === lastWithStops) {
      used += travelLeg(position, anchor, mode).minutes;
    }
    block.usedMinutes = used;
  });
}

function lastIndexWithStops(blocks: readonly CurrentBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].stops.length > 0) return i;
  }
  return -1;
}

function clampPosition(position: number | undefined, length: number): number {
  if (position === undefined || !Number.isFinite(position)) return length;
  return Math.max(0, Math.min(Math.floor(position), length));
}

function cloneBlock(block: CurrentBlock): CurrentBlock {
  return { ...block, stops: block.stops.map((s) => ({ ...s })) };
}

export type { CurrentBlock, CurrentStop };
