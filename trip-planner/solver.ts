/**
 * Filling blocks with spots — the planner's arithmetic.
 *
 * The concept is explicit that this is not a job for a language model
 * (§12): it is a knapsack per block plus a short tour over the two to
 * four stops that fit. Both are small enough to solve exactly or
 * near-exactly in milliseconds, which matters because redistribution
 * has to react instantly and may have to run offline (§5).
 *
 * The whole module is pure: same input, same output, no clock, no
 * network, no database. That is what makes a plan reproducible in tests
 * and reviewable by a human afterwards.
 *
 * Selection is greedy by value per minute, which is the standard
 * approximation for this shape of problem; ordering is then solved
 * exactly by permutation while the stop count stays small, and falls
 * back to keeping the greedy order beyond that. Ties break on `osmRef`
 * so two runs never disagree.
 */

import type { PlannedBlockShape } from "./blocks";
import { walkingLeg, type Coordinate, type TravelLeg } from "./travel";

/** Above this many stops, exhaustive ordering stops being free. */
const EXACT_ORDER_LIMIT = 7;

export interface Candidate extends Coordinate {
  osmRef: string;
  name: string | null;
  /** Category id from the geo search, e.g. "museum". */
  category: string;
  /** How long one typically stays, in minutes. */
  dwellMinutes: number;
  /** Higher is better. See `scoreCandidate` in candidates.ts. */
  score: number;
}

export interface PlannedStop {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  /** The walk from the previous position (the block's start for the first). */
  travelFromPrevious: TravelLeg;
}

export interface PlannedBlock {
  id: string;
  label: string;
  kind: PlannedBlockShape["kind"];
  budgetMinutes: number;
  /** Travel plus dwell actually used. Never exceeds the budget. */
  usedMinutes: number;
  stops: PlannedStop[];
}

export interface SolveOptions {
  /** Where the day starts, and where its last block returns to. */
  anchor: Coordinate;
  blocks: readonly PlannedBlockShape[];
  candidates: readonly Candidate[];
  /** Legs longer than this are never proposed. */
  maxWalkMinutes: number;
  /**
   * Repeat of a category already in the same block multiplies its score
   * by this — "no three churches in a row" (§12), expressed as a
   * preference rather than a ban.
   */
  diversityDecay?: number;
}

export interface SolvedDay {
  blocks: PlannedBlock[];
  /** Candidates that did not fit anywhere, best first. */
  unplaced: Candidate[];
}

const DEFAULT_DIVERSITY_DECAY = 0.6;

export function solveDay(opts: SolveOptions): SolvedDay {
  const decay = opts.diversityDecay ?? DEFAULT_DIVERSITY_DECAY;
  const remaining = new Map(opts.candidates.map((c) => [c.osmRef, c]));
  const blocks: PlannedBlock[] = [];

  // Each block picks up where the previous one left off; only the last
  // one pays for the walk back to the anchor, because that is the walk
  // you actually make.
  let position = opts.anchor;
  const lastSpotsBlockIndex = lastIndexOfSpotsBlock(opts.blocks);

  opts.blocks.forEach((shape, index) => {
    if (shape.kind !== "spots") {
      // A meal block holds time and a rough area, not a venue (§10.3).
      blocks.push({ ...shapeToBlock(shape), usedMinutes: 0, stops: [] });
      return;
    }

    const returnToAnchor = index === lastSpotsBlockIndex;
    const filled = fillBlock({
      shape,
      start: position,
      candidates: [...remaining.values()],
      maxWalkMinutes: opts.maxWalkMinutes,
      diversityDecay: decay,
      returnTo: returnToAnchor ? opts.anchor : null,
    });

    for (const stop of filled.stops) remaining.delete(stop.osmRef);
    blocks.push(filled);
    if (filled.stops.length > 0) {
      const last = filled.stops[filled.stops.length - 1];
      position = { lat: last.lat, lon: last.lon };
    }
  });

  const unplaced = [...remaining.values()].sort(byScoreThenRef);
  return { blocks, unplaced };
}

function lastIndexOfSpotsBlock(blocks: readonly PlannedBlockShape[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === "spots") return i;
  }
  return -1;
}

function shapeToBlock(shape: PlannedBlockShape): Omit<PlannedBlock, "usedMinutes" | "stops"> {
  return { id: shape.id, label: shape.label, kind: shape.kind, budgetMinutes: shape.budgetMinutes };
}

interface FillArgs {
  shape: PlannedBlockShape;
  start: Coordinate;
  candidates: Candidate[];
  maxWalkMinutes: number;
  diversityDecay: number;
  /** When set, the walk back here is charged to this block's budget. */
  returnTo: Coordinate | null;
}

function fillBlock(args: FillArgs): PlannedBlock {
  const chosen: Candidate[] = [];
  const pool = [...args.candidates].sort(byScoreThenRef);

  // Greedy: at every round take the candidate with the best value per
  // added minute that still fits. Recomputing the cost each round is
  // what accounts for the detour a new stop causes.
  for (;;) {
    let best: { candidate: Candidate; ratio: number; cost: number } | null = null;

    for (const candidate of pool) {
      if (chosen.includes(candidate)) continue;
      const trial = [...chosen, candidate];
      const route = bestRoute(args.start, trial, args.returnTo);
      if (route === null) continue;
      if (route.longestLegMinutes > args.maxWalkMinutes) continue;
      if (route.totalMinutes > args.shape.budgetMinutes) continue;

      const currentCost = chosen.length === 0
        ? 0
        : (bestRoute(args.start, chosen, args.returnTo)?.totalMinutes ?? 0);
      const cost = route.totalMinutes - currentCost;
      const value = candidate.score * args.diversityDecay ** countCategory(chosen, candidate.category);
      // A zero-cost stop cannot happen (dwell is positive), but guard
      // anyway rather than divide by zero.
      const ratio = cost > 0 ? value / cost : value;

      if (best === null || ratio > best.ratio + 1e-9) {
        best = { candidate, ratio, cost };
      }
    }

    if (best === null) break;
    chosen.push(best.candidate);
  }

  const route = bestRoute(args.start, chosen, args.returnTo);
  const stops: PlannedStop[] = [];
  if (route) {
    let from = args.start;
    for (const candidate of route.order) {
      const leg = walkingLeg(from, candidate);
      stops.push({
        osmRef: candidate.osmRef,
        name: candidate.name,
        lat: candidate.lat,
        lon: candidate.lon,
        category: candidate.category,
        dwellMinutes: candidate.dwellMinutes,
        travelFromPrevious: leg,
      });
      from = candidate;
    }
  }

  return {
    ...shapeToBlock(args.shape),
    usedMinutes: route?.totalMinutes ?? 0,
    stops,
  };
}

function countCategory(chosen: readonly Candidate[], category: string): number {
  return chosen.filter((c) => c.category === category).length;
}

interface Route {
  order: Candidate[];
  totalMinutes: number;
  longestLegMinutes: number;
}

/**
 * Shortest tour through `stops`, starting at `start` and optionally
 * returning to `returnTo`. Exhaustive while the count is small — with
 * two to four stops that is at most 24 permutations — and the greedy
 * order beyond `EXACT_ORDER_LIMIT`.
 */
function bestRoute(
  start: Coordinate,
  stops: readonly Candidate[],
  returnTo: Coordinate | null,
): Route | null {
  if (stops.length === 0) return { order: [], totalMinutes: 0, longestLegMinutes: 0 };
  if (stops.length > EXACT_ORDER_LIMIT) return measureRoute(start, stops, returnTo);

  let best: Route | null = null;
  for (const order of permutations([...stops])) {
    const route = measureRoute(start, order, returnTo);
    if (
      best === null ||
      route.totalMinutes < best.totalMinutes ||
      // Deterministic tie-break: prefer the lexicographically smaller
      // sequence of refs so equal-length tours do not flip between runs.
      (route.totalMinutes === best.totalMinutes && refKey(route.order) < refKey(best.order))
    ) {
      best = route;
    }
  }
  return best;
}

function measureRoute(
  start: Coordinate,
  order: readonly Candidate[],
  returnTo: Coordinate | null,
): Route {
  let total = 0;
  let longest = 0;
  let from: Coordinate = start;
  for (const stop of order) {
    const leg = walkingLeg(from, stop);
    total += leg.minutes + stop.dwellMinutes;
    longest = Math.max(longest, leg.minutes);
    from = stop;
  }
  if (returnTo) {
    const back = walkingLeg(from, returnTo);
    total += back.minutes;
    longest = Math.max(longest, back.minutes);
  }
  return { order: [...order], totalMinutes: total, longestLegMinutes: longest };
}

function refKey(order: readonly Candidate[]): string {
  return order.map((c) => c.osmRef).join("|");
}

function* permutations(items: Candidate[]): Generator<Candidate[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

function byScoreThenRef(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.osmRef < b.osmRef ? -1 : a.osmRef > b.osmRef ? 1 : 0;
}
