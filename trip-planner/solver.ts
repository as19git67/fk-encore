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
 * exactly (see `bestRoute`) while the stop count stays small, and falls
 * back to keeping the greedy order beyond that. Ties break on `osmRef`
 * so two runs never disagree.
 */

import type { PlannedBlockShape } from "./blocks";
import { leaveFrom, type SpotExtent } from "./extent";
import { isPassedByAny, passedBy } from "./on-the-way";
import { travelLeg, type Coordinate, type TransportMode, type TravelLeg } from "./travel";

/** Above this many stops, exhaustive ordering stops being free. */
const EXACT_ORDER_LIMIT = 7;

export interface Candidate extends Coordinate {
  osmRef: string;
  name: string | null;
  /**
   * The name on the sign, when `name` is not it (§10.4). Set only
   * where the two differ — in Tokyo or Jerusalem, not in Lisbon.
   */
  localName?: string | null;
  /** The Wikipedia article, where OpenStreetMap knows of one. */
  wikipediaUrl?: string | null;
  /**
   * Which way the building faces, in degrees clockwise from north in
   * [0, 180) (§7.3). Null for every POI mapped as a node.
   */
  facadeAzimuth?: number | null;
  /**
   * The OSM tag behind the category ("building=church"), for the
   * indoor/outdoor derivation (§7.2). Null for a find brought in by
   * hand, which has no OSM entry behind it.
   */
  kind?: string | null;
  /**
   * Somebody marked this one as a photo stop (§7.3): the light may
   * have a say here, and nowhere else. Absent for a candidate fresh
   * out of the region search — the flag is written by hand.
   */
  photoStop?: boolean;
  /**
   * "search" or "manual" (§9.2). Absent for a candidate straight out
   * of the region search, which is the same thing as "search".
   */
  origin?: string;
  /**
   * Why the scoring rates it (§8.3), in the traveller's words. Set by
   * `scoreCandidate` (see `ScoredCandidate`); carried here so it can
   * ride along into a stop and back into the pool.
   */
  reasons?: string[];
  /**
   * Where the spot finishes, when that is not where it starts (§4.7):
   * a route along a lake, a way up a hill. The next leg sets off from
   * its end. Absent for the ordinary point.
   *
   * Optional, never `| null`: Encore's schema parser intersects the
   * element types when an interface narrows an inherited array field
   * (`StoredBlock extends CurrentBlock { stops: StoredStop[] }`), and
   * `(SpotExtent | null) & (SpotExtent | null)` distributes into a
   * `SpotExtent & null` it cannot resolve. A plain optional interface
   * intersects with itself cleanly.
   */
  extent?: SpotExtent;
  /** Category id from the geo search, e.g. "museum". */
  category: string;
  /** How long one typically stays, in minutes. */
  dwellMinutes: number;
  /** Higher is better. See `scoreCandidate` in candidates.ts. */
  score: number;
  /** Somebody asked for it (votes.ts) — what earns a restaurant the meal block. */
  wanted?: boolean;
}

/** What a meal block may hold (move.ts says the same for a drop). */
const MEAL_CATEGORIES: ReadonlySet<string> = new Set(["food", "cafe"]);

export interface PlannedStop {
  osmRef: string;
  name: string | null;
  /** See `Candidate.localName`. */
  localName?: string | null;
  /** See `Candidate.wikipediaUrl`. */
  wikipediaUrl?: string | null;
  /** See `Candidate.facadeAzimuth`. */
  facadeAzimuth?: number | null;
  /** See `Candidate.kind`. */
  kind?: string | null;
  /** See `Candidate.photoStop`. */
  photoStop?: boolean;
  /** See `Candidate.origin`. */
  origin?: string;
  /**
   * See `Candidate.reasons`. On the stop because the pool row that
   * knew them is deleted when the spot lands on a day (§8.3).
   */
  /** See `Candidate.extent`. */
  extent?: SpotExtent;
  reasons?: string[];
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  /**
   * The score this stop was chosen on. Carried through so a later
   * redistribution can rank it honestly against the pool instead of
   * guessing (see redistribute.ts).
   */
  score: number;
  /** The walk from the previous position (the block's start for the first). */
  travelFromPrevious: TravelLeg;
  /**
   * Kept where it is by a redistribution (§8.4). Never set by the
   * solver, which places nothing it would not move again; set by the
   * frame for a stop the traveller accepted at an hour (`frame-spots.ts`).
   */
  pinned?: boolean;
  /**
   * What this stop walks past on its way (§4.7): spots that lie on a
   * route and are therefore seen without being planned. Only ever set
   * on a stop with an extent, and derived rather than stored — see
   * `withPassed` in plan-store.ts.
   */
  passes?: PassedSpot[];
}

/** A spot a route walks past, named for the card that says so. */
export interface PassedSpot {
  osmRef: string;
  name: string | null;
}

export interface PlannedBlock {
  id: string;
  label: string;
  kind: PlannedBlockShape["kind"];
  budgetMinutes: number;
  /**
   * Travel plus dwell actually in it. The solver never exceeds the
   * budget; a stop a person placed may (§4.7, `spill.ts`).
   */
  usedMinutes: number;
  /**
   * Minutes of an earlier block's overrun that land in this one — how
   * much later it begins than the day's shape says (§4.7). Absent
   * where nothing overran, which is every ordinary day.
   */
  carriedInMinutes?: number;
  stops: PlannedStop[];
}

export interface SolveOptions {
  /** Where the last block returns to — the leg's anchor. */
  anchor: Coordinate;
  /**
   * Where the first block begins. Defaults to the anchor, which is the
   * normal case; redistribution passes the group's actual position, and
   * a day after a transfer would pass the station.
   */
  start?: Coordinate;
  /**
   * Where the last block has to finish. Defaults to the anchor, which
   * is the ordinary evening; a day that ends at a departure ends at the
   * platform instead (§4.4, `day-ends.ts`). After the last train the
   * walk back to the hotel is a walk nobody makes, and planning it
   * costs the evening a stop.
   */
  end?: Coordinate;
  blocks: readonly PlannedBlockShape[];
  candidates: readonly Candidate[];
  /** Legs longer than this are never proposed. */
  maxWalkMinutes: number;
  /** How the group gets around on this leg (§4.2). On foot by default. */
  mode?: TransportMode;
  /**
   * Repeat of a category already in the same block multiplies its score
   * by this — "no three churches in a row" (§12), expressed as a
   * preference rather than a ban.
   */
  diversityDecay?: number;
  /**
   * Where a leg's time comes from. The estimate (`travelLeg`) unless a
   * table from the router is handed in (`travel-table.ts`, §24) — the
   * solver itself stays pure either way: it reads, it never asks.
   */
  travel?: (from: Coordinate, to: Coordinate, mode: TransportMode) => TravelLeg;
}

export interface SolvedDay {
  blocks: PlannedBlock[];
  /** Candidates that did not fit anywhere, best first. */
  unplaced: Candidate[];
}

const DEFAULT_DIVERSITY_DECAY = 0.6;

export function solveDay(opts: SolveOptions): SolvedDay {
  const decay = opts.diversityDecay ?? DEFAULT_DIVERSITY_DECAY;
  const mode = opts.mode ?? "foot";
  const travel = opts.travel ?? travelLeg;
  const remaining = new Map(opts.candidates.map((c) => [c.osmRef, c]));
  // Spots this day walks past (§4.7). Kept apart from `remaining`
  // rather than removed from it: they are passed, not turned down, and
  // they have to come back out in `unplaced` so the pool still holds
  // them — a day without that route offers them like any other.
  const passed = new Set<string>();
  const blocks: PlannedBlock[] = [];

  // Each block picks up where the previous one left off; only the last
  // one pays for the walk back, because that is the walk you actually
  // make — back to the anchor on an ordinary day, to the station on the
  // day the train leaves.
  let position = opts.start ?? opts.anchor;
  const lastSpotsBlockIndex = lastIndexOfSpotsBlock(opts.blocks);
  const hasMeal = opts.blocks.some((shape) => shape.kind === "meal");

  opts.blocks.forEach((shape, index) => {
    if (shape.kind !== "spots") {
      // A meal block holds time and a rough area, not a venue (§10.3):
      // the solver picks no restaurant. One the family asked for — a
      // heart, a "will ich" — is not the solver's pick, so the best
      // such place goes in, one per meal, when the way there fits.
      const meal = pickMeal(shape, position, [...remaining.values()], opts.maxWalkMinutes, mode, travel);
      if (meal) {
        remaining.delete(meal.stop.osmRef);
        position = leaveFrom(meal.candidate);
      }
      blocks.push({ ...shapeToBlock(shape), usedMinutes: meal?.stop ? meal.used : 0, stops: meal ? [meal.stop] : [] });
      return;
    }

    const returnToAnchor = index === lastSpotsBlockIndex;
    const filled = fillBlock({
      shape,
      start: position,
      // A restaurant is a meal, not a sight: on a day with a meal
      // block it goes there or nowhere. A café can still be the
      // afternoon's stop.
      candidates: [...remaining.values()]
        .filter((c) => !passed.has(c.osmRef))
        .filter((c) => !(hasMeal && c.category === "food")),
      maxWalkMinutes: opts.maxWalkMinutes,
      mode,
      diversityDecay: decay,
      returnTo: returnToAnchor ? opts.end ?? opts.anchor : null,
      travel,
    });

    for (const stop of filled.stops) remaining.delete(stop.osmRef);
    // A spot the day now walks past is not a spot the day still has to
    // plan (§4.7). Noted for the whole day rather than the block: you
    // pass it once, and an afternoon that plans what the morning walked
    // through is the same mistake one block later.
    for (const stop of filled.stops) {
      for (const seen of passedBy(stop, [...remaining.values()])) {
        passed.add(seen.osmRef);
      }
    }
    blocks.push(filled);
    if (filled.stops.length > 0) {
      const last = filled.stops[filled.stops.length - 1];
      position = leaveFrom(last);
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
  mode: TransportMode;
  diversityDecay: number;
  /** When set, the walk back here is charged to this block's budget. */
  returnTo: Coordinate | null;
  travel: TravelFn;
}

export type TravelFn = (from: Coordinate, to: Coordinate, mode: TransportMode) => TravelLeg;

/**
 * The place the family asked to eat at, for one meal block: the best
 * wanted restaurant or café that the walk there allows, with what it
 * costs the block. Null when nobody asked for one — then the block
 * stays what it always was, time and a rough area.
 */
function pickMeal(
  shape: PlannedBlockShape,
  start: Coordinate,
  candidates: readonly Candidate[],
  maxWalkMinutes: number,
  mode: TransportMode,
  travel: TravelFn,
): { candidate: Candidate; stop: PlannedStop; used: number } | null {
  const wanted = candidates
    .filter((c) => c.wanted === true && MEAL_CATEGORIES.has(c.category) && c.score > 0)
    .sort(byScoreThenRef);
  for (const candidate of wanted) {
    const leg = travel(start, candidate, mode);
    if (leg.minutes > maxWalkMinutes) continue;
    const used = leg.minutes + candidate.dwellMinutes;
    // Over budget is still placed: a wish for lunch at a place twenty
    // minutes away is a longer lunch, not no lunch — and the block
    // says it is over, as it does for a drop (§8.4).
    return {
      candidate,
      used,
      stop: {
        osmRef: candidate.osmRef,
        name: candidate.name,
        localName: candidate.localName ?? null,
        wikipediaUrl: candidate.wikipediaUrl ?? null,
        facadeAzimuth: candidate.facadeAzimuth ?? null,
        kind: candidate.kind ?? null,
        lat: candidate.lat,
        lon: candidate.lon,
        extent: candidate.extent,
        category: candidate.category,
        dwellMinutes: candidate.dwellMinutes,
        score: candidate.score,
        reasons: candidate.reasons ?? [],
        travelFromPrevious: leg,
      },
    };
  }
  return null;
}

function fillBlock(args: FillArgs): PlannedBlock {
  const chosen: Candidate[] = [];
  const pool = [...args.candidates].sort(byScoreThenRef);

  // Greedy: at every round take the candidate with the best value per
  // added minute that still fits. Recomputing the cost each round is
  // what accounts for the detour a new stop causes.
  for (;;) {
    let best: { candidate: Candidate; ratio: number; cost: number } | null = null;
    // What the stops chosen so far cost on their own. It only changes
    // when a stop is added, so it is measured once per round, not once
    // per candidate.
    const currentCost = chosen.length === 0
      ? 0
      : (bestRoute(args.start, chosen, args.returnTo, args.mode, args.travel)?.totalMinutes ?? 0);

    for (const candidate of pool) {
      if (chosen.includes(candidate)) continue;
      // Already on the way: a viewpoint along a route this block holds
      // is coming anyway, and spending budget on it buys nothing
      // (§4.7).
      if (isPassedByAny(chosen, candidate)) continue;
      const trial = [...chosen, candidate];
      const route = bestRoute(args.start, trial, args.returnTo, args.mode, args.travel);
      if (route === null) continue;
      if (route.longestLegMinutes > args.maxWalkMinutes) continue;
      if (route.totalMinutes > args.shape.budgetMinutes) continue;

      const cost = route.totalMinutes - currentCost;
      const value = candidate.score * args.diversityDecay ** countCategory(chosen, candidate.category);
      // Room in the day is not a reason to go somewhere nobody wants to
      // go. Every candidate the search produces starts positive
      // (candidates.ts), so this excludes exactly one thing: a spot the
      // group voted below zero (§6.1). It is still not a veto — enough
      // "will ich" lifts it back over the line and it is placed again.
      if (value <= 0) continue;
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

  const route = bestRoute(args.start, chosen, args.returnTo, args.mode, args.travel);
  const stops: PlannedStop[] = [];
  if (route) {
    let from = args.start;
    for (const candidate of route.order) {
      const leg = args.travel(from, candidate, args.mode);
      stops.push({
        osmRef: candidate.osmRef,
        name: candidate.name,
        localName: candidate.localName ?? null,
        wikipediaUrl: candidate.wikipediaUrl ?? null,
        facadeAzimuth: candidate.facadeAzimuth ?? null,
        kind: candidate.kind ?? null,
        lat: candidate.lat,
        lon: candidate.lon,
        extent: candidate.extent,
        category: candidate.category,
        dwellMinutes: candidate.dwellMinutes,
        score: candidate.score,
        reasons: candidate.reasons ?? [],
        travelFromPrevious: leg,
      });
      from = leaveFrom(candidate);
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

export interface Route {
  order: Candidate[];
  totalMinutes: number;
  longestLegMinutes: number;
}

/**
 * Shortest tour through `stops`, starting at `start` and optionally
 * returning to `returnTo`. Exact while the count is small and the
 * greedy order beyond `EXACT_ORDER_LIMIT`.
 *
 * Exact means: the tour with the fewest total minutes, and among tours
 * of equal length the one whose sequence of refs sorts first, so two
 * runs never disagree. It is found by a depth-first search over the
 * orders that abandons a partial tour as soon as it is already longer
 * than the best complete one — every leg and every dwell is at least
 * zero minutes, so a tour never gets shorter by going on, and the
 * answer is the same one trying every permutation gives. Trying every
 * permutation was the bottleneck: the greedy selection asks this for
 * every candidate in every round, and seven stops are 5 040 orders.
 *
 * Exported for the test that holds it to the exhaustive answer.
 */
export function bestRoute(
  start: Coordinate,
  stops: readonly Candidate[],
  returnTo: Coordinate | null,
  mode: TransportMode,
  travel: TravelFn = travelLeg,
): Route | null {
  if (stops.length === 0) return { order: [], totalMinutes: 0, longestLegMinutes: 0 };
  if (stops.length > EXACT_ORDER_LIMIT) return measureRoute(start, stops, returnTo, mode, travel);

  let best: Route | null = null;
  const used = new Array<boolean>(stops.length).fill(false);
  const order: Candidate[] = [];
  // Every stop still to come costs at least its dwell, whatever the
  // walk to it. Compared with a small allowance so a rounding difference
  // between this shortcut and the real leg-by-leg sum can never cut off
  // a tour that is in fact as short as the best.
  let dwellAhead = stops.reduce((sum, s) => sum + s.dwellMinutes, 0);
  const SLACK = 1e-6;

  // Sums are built leg by leg exactly as measureRoute builds them, so a
  // tour found here carries the same minutes to the last bit.
  const visit = (from: Coordinate, total: number, longest: number): void => {
    if (best !== null && total + dwellAhead > best.totalMinutes + SLACK) return;
    if (order.length === stops.length) {
      let finalTotal = total;
      let finalLongest = longest;
      if (returnTo) {
        const back = travel(from, returnTo, mode);
        finalTotal += back.minutes;
        finalLongest = Math.max(finalLongest, back.minutes);
      }
      if (
        best === null ||
        finalTotal < best.totalMinutes ||
        (finalTotal === best.totalMinutes && refKey(order) < refKey(best.order))
      ) {
        best = { order: [...order], totalMinutes: finalTotal, longestLegMinutes: finalLongest };
      }
      return;
    }
    for (let i = 0; i < stops.length; i += 1) {
      if (used[i]) continue;
      const stop = stops[i];
      const leg = travel(from, stop, mode);
      used[i] = true;
      order.push(stop);
      dwellAhead -= stop.dwellMinutes;
      // A route is left at its far end, and the way on is measured from
      // there (§4.7).
      visit(leaveFrom(stop), total + (leg.minutes + stop.dwellMinutes), Math.max(longest, leg.minutes));
      dwellAhead += stop.dwellMinutes;
      order.pop();
      used[i] = false;
    }
  };
  visit(start, 0, 0);
  return best;
}

function measureRoute(
  start: Coordinate,
  order: readonly Candidate[],
  returnTo: Coordinate | null,
  mode: TransportMode,
  travel: TravelFn = travelLeg,
): Route {
  let total = 0;
  let longest = 0;
  let from: Coordinate = start;
  for (const stop of order) {
    const leg = travel(from, stop, mode);
    total += leg.minutes + stop.dwellMinutes;
    longest = Math.max(longest, leg.minutes);
    // A route is left at its far end, and the way on is measured from
    // there (§4.7).
    from = leaveFrom(stop);
  }
  if (returnTo) {
    const back = travel(from, returnTo, mode);
    total += back.minutes;
    longest = Math.max(longest, back.minutes);
  }
  return { order: [...order], totalMinutes: total, longestLegMinutes: longest };
}

function refKey(order: readonly Candidate[]): string {
  return order.map((c) => c.osmRef).join("|");
}

function byScoreThenRef(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.osmRef < b.osmRef ? -1 : a.osmRef > b.osmRef ? 1 : 0;
}
