/**
 * "We are here, it is now" — recomputing the rest of a day.
 *
 * The concept treats this as the normal case rather than an exception
 * (§2, §5): a plan is a pool with an order, not a script, and the
 * question it must answer at any moment is what still fits from where
 * the group actually stands.
 *
 * Four rules the implementation follows literally:
 *
 *   1. **Only the rest is recomputed.** Blocks before the current one
 *      are untouched, and stops already done or skipped stay exactly
 *      where they are — they are the beginning of the travel diary, not
 *      scheduling material.
 *   2. **Pinned stops never move.** They are fixed points (§4.4), so
 *      they keep their place and their time is spent before anything
 *      else competes for what is left.
 *   3. **Displaced stops go back to the pool, not the bin**, with a
 *      priority boost so they return first rather than competing from
 *      scratch.
 *   4. **What gets dropped is what scored lowest** — which, once votes
 *      exist, is what the group cared least about (§6.1).
 *
 * Pure, like the solver: state in, state out. No clock, no database, no
 * network — so this runs offline in a dead spot, which is exactly where
 * it is needed.
 */

import type { PlannedBlockShape } from "./blocks";
import { solveDay, type Candidate, type PlannedBlock, type PlannedStop } from "./solver";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

/**
 * How much a displaced stop is favoured when it competes again. Enough
 * to come back ahead of an equally-scored newcomer, not enough to
 * outrank something the travellers clearly wanted more.
 */
export const DISPLACEMENT_BOOST = 0.5;

export type StopStatus = "planned" | "done" | "skipped";

export interface CurrentStop extends PlannedStop {
  status: StopStatus;
  pinned: boolean;
  /**
   * Why it was saved and where from, carried over from the pool entry
   * when a find is planned (§9.2). Absent for the ordinary case: a spot
   * the region search proposed has no note, and its reasons are the
   * scoring ones.
   */
  note?: string | null;
  sourceUrl?: string | null;
}

export interface CurrentBlock extends Omit<PlannedBlock, "stops"> {
  stops: CurrentStop[];
}

export interface RedistributeRequest {
  /** The day as it stands. */
  blocks: readonly CurrentBlock[];
  /** Scored candidates available to fill gaps. */
  pool: readonly Candidate[];
  /** Where the group actually is. */
  position: Coordinate;
  /** Where the day ends — the leg's anchor. */
  anchor: Coordinate;
  /** Which block they are standing in; earlier blocks are untouched. */
  currentBlockId: string;
  /** Minutes left of that block's budget. */
  remainingMinutes: number;
  maxWalkMinutes: number;
  /** How the group gets around on this leg (§4.2). On foot by default. */
  mode?: TransportMode;
}

export interface RedistributeResult {
  blocks: CurrentBlock[];
  /** The pool afterwards: unused candidates plus what was displaced. */
  pool: Candidate[];
  /** Stops that lost their place, best first — what to tell the user. */
  displaced: Candidate[];
}

export function redistribute(req: RedistributeRequest): RedistributeResult {
  const currentIndex = req.blocks.findIndex((b) => b.id === req.currentBlockId);
  if (currentIndex < 0) throw new Error(`unknown block: ${req.currentBlockId}`);

  const untouched = req.blocks.slice(0, currentIndex);
  const rest = req.blocks.slice(currentIndex);

  // Settled or pinned stays; everything else returns to the running for
  // its place, together with the pool.
  const keptPerBlock: CurrentStop[][] = [];
  const freed: Candidate[] = [];

  for (const block of rest) {
    const kept: CurrentStop[] = [];
    for (const stop of block.stops) {
      if (stop.status !== "planned" || stop.pinned) {
        kept.push(stop);
        continue;
      }
      freed.push(stopToCandidate(stop));
    }
    keptPerBlock.push(kept);
  }

  const available = dedupeByRef([...freed, ...req.pool]);

  // Budgets: the current block has only what is left of it, later blocks
  // keep theirs. Time already committed to kept *planned* stops is
  // subtracted; time spent on stops already done is not, because
  // `remainingMinutes` accounts for it.
  const shapes: PlannedBlockShape[] = rest.map((block, offset) => {
    const budget = offset === 0 ? req.remainingMinutes : block.budgetMinutes;
    const committed = keptPerBlock[offset]
      .filter((s) => s.status === "planned")
      .reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0);
    return {
      id: block.id,
      label: block.label,
      kind: block.kind,
      baseBudgetMinutes: budget,
      budgetMinutes: Math.max(0, budget - committed),
    };
  });

  const solved = solveDay({
    anchor: req.anchor,
    // The whole point of "we are here": selection starts from the
    // group's real position, not from the anchor they left this morning.
    start: req.position,
    blocks: shapes,
    candidates: available,
    maxWalkMinutes: req.maxWalkMinutes,
    mode: req.mode,
  });

  const blocks = rebuildBlocks(rest, keptPerBlock, solved.blocks, req.position, req.mode ?? "foot");
  const placed = new Set(blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
  const freedRefs = new Set(freed.map((c) => c.osmRef));

  const displaced = freed.filter((c) => !placed.has(c.osmRef)).sort(byScoreThenRef);
  const pool = available
    .filter((c) => !placed.has(c.osmRef))
    .map((c) => (freedRefs.has(c.osmRef) ? { ...c, score: c.score + DISPLACEMENT_BOOST } : c))
    .sort(byScoreThenRef);

  return { blocks: [...untouched, ...blocks], pool, displaced };
}

function stopToCandidate(stop: CurrentStop): Candidate {
  return {
    osmRef: stop.osmRef,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    category: stop.category,
    dwellMinutes: stop.dwellMinutes,
    score: stop.score,
  };
}

function dedupeByRef(candidates: readonly Candidate[]): Candidate[] {
  const byRef = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byRef.get(candidate.osmRef);
    if (!existing || candidate.score > existing.score) byRef.set(candidate.osmRef, candidate);
  }
  return [...byRef.values()];
}

/**
 * Put the kept stops back in front of the newly solved ones and
 * recompute the legs, starting the current block at the group's actual
 * position.
 */
function rebuildBlocks(
  rest: readonly CurrentBlock[],
  keptPerBlock: readonly CurrentStop[][],
  solved: readonly PlannedBlock[],
  position: Coordinate,
  mode: TransportMode,
): CurrentBlock[] {
  const out: CurrentBlock[] = [];
  let from: Coordinate = position;

  rest.forEach((block, offset) => {
    const stops: CurrentStop[] = [];

    for (const stop of keptPerBlock[offset]) {
      stops.push(stop);
      // A done or skipped stop does not move the group on from here —
      // the reported position already accounts for it.
      if (stop.status === "planned") from = { lat: stop.lat, lon: stop.lon };
    }
    for (const stop of solved[offset]?.stops ?? []) {
      stops.push({
        ...stop,
        travelFromPrevious: travelLeg(from, stop, mode),
        status: "planned",
        pinned: false,
      });
      from = { lat: stop.lat, lon: stop.lon };
    }

    out.push({
      id: block.id,
      label: block.label,
      kind: block.kind,
      budgetMinutes: block.budgetMinutes,
      usedMinutes: stops
        .filter((s) => s.status === "planned")
        .reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0),
      stops,
    });
  });

  return out;
}

function byScoreThenRef(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.osmRef < b.osmRef ? -1 : a.osmRef > b.osmRef ? 1 : 0;
}
