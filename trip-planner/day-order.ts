/**
 * "Reihenfolge vorschlagen" (ideas plan, stage 4): the best order of
 * the ideas somebody put on a day.
 *
 * The app orders, it does not choose. Every stop on the day stays on
 * it; what comes back is their order, and — when the window does not
 * hold them — by how much it overruns and which "Wenn Zeit" ideas, then
 * "Will" ideas, would make it fit if the travellers took them off.
 * "Muss" ideas and booked visits are never among those.
 *
 * What counts, in this order:
 *
 *   1. **Hard times.** A booked visit must not be missed, a museum must
 *      be open for the whole visit. An order that breaks fewer of them
 *      wins, then the one that breaks them by fewer minutes.
 *   2. **The window.** Less overrun past the day's end.
 *   3. **The way.** Fewer minutes travelled.
 *
 * Ties break on the sequence of refs, so two runs never disagree.
 * Exact up to `EXACT_ORDER_LIMIT` stops by a depth-first search that
 * abandons an order as soon as it is already worse than the best one
 * (every part of the cost only grows as the order goes on); above it,
 * a greedy order improved by swapping pairs.
 *
 * Breaks keep the place they were put: a break at position 2 is the
 * third thing done, whatever comes before it.
 *
 * Pure: no clock, no database.
 */

import type { IdeaPriority } from "./priority";
import { leaveFrom, type SpotExtent } from "./extent";
import { timeItem, timeLine, type BlockedSpan, type TimedItem, type TimedLine } from "./day-timing";
import { travelLeg, type Coordinate, type TransportMode, type TravelLeg } from "./travel";

/** Above this many stops the exhaustive search stops being instant. */
export const EXACT_ORDER_LIMIT = 9;

export interface OrderStop extends Coordinate {
  ref: string;
  extent?: SpotExtent;
  dwellMinutes: number;
  openingHours?: string | null;
  ticketMinutes?: number | null;
  priority?: IdeaPriority;
}

export interface OrderBreak {
  ref: string;
  minutes: number;
  /** Where in the line it stands, counting stops and breaks from zero. */
  position: number;
}

export interface OrderInput {
  /** Where the group sets off from. */
  start: Coordinate;
  startMinutes: number;
  /** When the window closes. */
  endMinutes: number;
  stops: readonly OrderStop[];
  breaks?: readonly OrderBreak[];
  mode: TransportMode;
  date?: string | null;
  blocked?: readonly BlockedSpan[];
  travel?: (from: Coordinate, to: Coordinate, mode: TransportMode) => TravelLeg;
}

export interface OrderResult {
  /** The stops' refs in the order to do them. */
  order: string[];
  /** The whole line, breaks included, on the clock. */
  line: TimedLine;
  overrunMinutes: number;
  /** What to take off for the day to fit, smallest set first; empty when it fits. */
  toDrop: string[];
}

type Cost = [violations: number, violationMinutes: number, overrun: number, travel: number];

export function orderDay(input: OrderInput): OrderResult {
  const travel = input.travel ?? travelLeg;
  const breaks = [...(input.breaks ?? [])].sort((a, b) => a.position - b.position || cmp(a.ref, b.ref));
  const stops = [...input.stops].sort((a, b) => cmp(a.ref, b.ref));
  const order = stops.length <= EXACT_ORDER_LIMIT
    ? exactOrder(input, stops, breaks, travel)
    : improvedOrder(input, stops, breaks, travel);
  const evaluated = evaluate(input, order, breaks, travel);
  const overrun = Math.max(0, evaluated.line.endMinutes - input.endMinutes);
  return {
    order: order.map((s) => s.ref),
    line: evaluated.line,
    overrunMinutes: overrun,
    toDrop: overrun > 0 ? dropsToFit(input, order, breaks, travel) : [],
  };
}

/** The line of these stops in this order, with breaks at their places. */
export function lineOf(
  input: OrderInput,
  order: readonly OrderStop[],
  breaks: readonly OrderBreak[] = input.breaks ?? [],
): TimedLine {
  return evaluate(input, order, breaks, input.travel ?? travelLeg).line;
}

type TravelFn = NonNullable<OrderInput["travel"]>;

function itemsOf(
  input: OrderInput,
  order: readonly OrderStop[],
  breaks: readonly OrderBreak[],
  travel: TravelFn,
): { items: TimedItem[]; travelled: number } {
  const items: TimedItem[] = [];
  let from = input.start;
  let travelled = 0;
  let b = 0;
  const pushBreaks = () => {
    while (b < breaks.length && breaks[b].position <= items.length) {
      items.push({ ref: breaks[b].ref, travelMinutes: 0, dwellMinutes: breaks[b].minutes });
      b += 1;
    }
  };
  for (const stop of order) {
    pushBreaks();
    const leg = travel(from, stop, input.mode).minutes;
    travelled += leg;
    items.push(asItem(stop, leg));
    from = leaveFrom(stop);
  }
  while (b < breaks.length) {
    items.push({ ref: breaks[b].ref, travelMinutes: 0, dwellMinutes: breaks[b].minutes });
    b += 1;
  }
  return { items, travelled };
}

function asItem(stop: OrderStop, travelMinutes: number): TimedItem {
  return {
    ref: stop.ref,
    travelMinutes,
    dwellMinutes: stop.dwellMinutes,
    openingHours: stop.openingHours ?? null,
    ticketMinutes: stop.ticketMinutes ?? null,
  };
}

function evaluate(
  input: OrderInput,
  order: readonly OrderStop[],
  breaks: readonly OrderBreak[],
  travel: TravelFn,
): { line: TimedLine; cost: Cost } {
  const { items, travelled } = itemsOf(input, order, breaks, travel);
  const line = timeLine({ startMinutes: input.startMinutes, items, date: input.date, blocked: input.blocked });
  let violations = 0;
  let violationMinutes = 0;
  for (const entry of line.entries) {
    if (entry.lateMinutes > 0 || entry.outsideHours) {
      violations += 1;
      violationMinutes += entry.lateMinutes;
    }
  }
  return {
    line,
    cost: [violations, violationMinutes, Math.max(0, line.endMinutes - input.endMinutes), travelled],
  };
}

function exactOrder(
  input: OrderInput,
  stops: readonly OrderStop[],
  breaks: readonly OrderBreak[],
  travel: TravelFn,
): OrderStop[] {
  if (stops.length <= 1) return [...stops];
  // The ways between every pair, once: the search asks for them often.
  const fromStart = stops.map((s) => travel(input.start, s, input.mode).minutes);
  const between = stops.map((a) => stops.map((b) => travel(leaveFrom(a), b, input.mode).minutes));
  const items = stops.map((s) => asItem(s, 0));
  const blocked = [...(input.blocked ?? [])].sort((a, b) => a.from - b.from);
  const date = input.date ?? null;

  let best: { order: number[]; cost: Cost } | null = null;
  const used = new Array<boolean>(stops.length).fill(false);
  const order: number[] = [];

  const visit = (last: number, clock: number, placed: number, b: number, cost: Cost): void => {
    // Breaks due at this place in the line come first.
    while (b < breaks.length && breaks[b].position <= placed) {
      clock += Math.max(0, breaks[b].minutes);
      placed += 1;
      b += 1;
    }
    const partial: Cost = [cost[0], cost[1], Math.max(0, clock - input.endMinutes), cost[3]];
    if (best && compare(partial, best.cost) > 0) return;
    if (order.length === stops.length) {
      while (b < breaks.length) {
        clock += Math.max(0, breaks[b].minutes);
        b += 1;
      }
      const final: Cost = [cost[0], cost[1], Math.max(0, clock - input.endMinutes), cost[3]];
      if (!best || compare(final, best.cost) < 0 || (compare(final, best.cost) === 0 && keyOf(order, stops) < keyOf(best.order, stops))) {
        best = { order: [...order], cost: final };
      }
      return;
    }
    for (let i = 0; i < stops.length; i += 1) {
      if (used[i]) continue;
      const leg = last < 0 ? fromStart[i] : between[last][i];
      const entry = timeItem({ ...items[i], travelMinutes: leg }, clock, date, blocked);
      const broke = entry.lateMinutes > 0 || entry.outsideHours;
      used[i] = true;
      order.push(i);
      visit(i, entry.endMinutes, placed + 1, b, [
        cost[0] + (broke ? 1 : 0),
        cost[1] + (broke ? entry.lateMinutes : 0),
        0,
        cost[3] + leg,
      ]);
      order.pop();
      used[i] = false;
    }
  };
  visit(-1, input.startMinutes, 0, 0, [0, 0, 0, 0]);
  const found = best as { order: number[]; cost: Cost } | null;
  return found ? found.order.map((i) => stops[i]) : [...stops];
}

/**
 * Above the exact limit: take the next stop that breaks nothing and
 * finishes earliest, then swap pairs while that makes the day better.
 */
function improvedOrder(
  input: OrderInput,
  stops: readonly OrderStop[],
  breaks: readonly OrderBreak[],
  travel: TravelFn,
): OrderStop[] {
  const rest = [...stops];
  const order: OrderStop[] = [];
  let from = input.start;
  let clock = input.startMinutes;
  while (rest.length > 0) {
    let pick = 0;
    let pickKey: [number, number, number] | null = null;
    for (const [i, stop] of rest.entries()) {
      const leg = travel(from, stop, input.mode).minutes;
      const entry = timeItem(asItem(stop, leg), clock, input.date ?? null, input.blocked);
      const key: [number, number, number] = [entry.lateMinutes > 0 || entry.outsideHours ? 1 : 0, entry.endMinutes, leg];
      if (!pickKey || key[0] < pickKey[0] || (key[0] === pickKey[0] && (key[1] < pickKey[1] || (key[1] === pickKey[1] && key[2] < pickKey[2])))) {
        pick = i;
        pickKey = key;
      }
    }
    const [chosen] = rest.splice(pick, 1);
    const leg = travel(from, chosen, input.mode).minutes;
    clock = timeItem(asItem(chosen, leg), clock, input.date ?? null, input.blocked).endMinutes;
    order.push(chosen);
    from = leaveFrom(chosen);
  }

  let current = evaluate(input, order, breaks, travel).cost;
  for (let round = 0; round < 20; round += 1) {
    let improved = false;
    for (let i = 0; i < order.length - 1; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        [order[i], order[j]] = [order[j], order[i]];
        const cost = evaluate(input, order, breaks, travel).cost;
        if (compare(cost, current) < 0) {
          current = cost;
          improved = true;
        } else {
          [order[i], order[j]] = [order[j], order[i]];
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

/**
 * Which ideas to take off so the day fits, keeping the order: "Wenn Zeit"
 * first, then "Will"; never "Muss", never a booked visit. Within a tier
 * one idea that is enough on its own wins, the shortest such; otherwise
 * the one that saves most goes and the search goes on.
 */
function dropsToFit(
  input: OrderInput,
  order: readonly OrderStop[],
  breaks: readonly OrderBreak[],
  travel: TravelFn,
): string[] {
  let remaining = [...order];
  const dropped: string[] = [];
  const endOf = (stops: readonly OrderStop[]) => evaluate(input, stops, breaksAfterDrops(breaks, order, stops), travel).line.endMinutes;
  for (const tier of ["maybe", "want"] as const) {
    for (;;) {
      if (endOf(remaining) <= input.endMinutes) return dropped;
      const options = remaining.filter((s) => (s.priority ?? "want") === tier && typeof s.ticketMinutes !== "number");
      if (options.length === 0) break;
      const trials = options.map((s) => {
        const without = remaining.filter((r) => r !== s);
        return { stop: s, without, end: endOf(without) };
      });
      const enough = trials
        .filter((t) => t.end <= input.endMinutes)
        .sort((a, b) => a.stop.dwellMinutes - b.stop.dwellMinutes || cmp(a.stop.ref, b.stop.ref));
      const choice = enough[0] ?? [...trials].sort((a, b) => a.end - b.end || cmp(a.stop.ref, b.stop.ref))[0];
      dropped.push(choice.stop.ref);
      remaining = choice.without;
    }
  }
  return dropped;
}

/** Breaks keep their place relative to the stops that stay. */
function breaksAfterDrops(
  breaks: readonly OrderBreak[],
  full: readonly OrderStop[],
  kept: readonly OrderStop[],
): OrderBreak[] {
  if (kept.length === full.length) return [...breaks];
  const keptRefs = new Set(kept.map((s) => s.ref));
  return breaks.map((brk) => {
    // Stops before the break in the full line: its position less the
    // breaks before it.
    const before = breaks.filter((other) => other.position < brk.position).length;
    const stopsBefore = full.slice(0, Math.max(0, brk.position - before));
    const removed = stopsBefore.filter((s) => !keptRefs.has(s.ref)).length;
    return { ...brk, position: brk.position - removed };
  });
}

function compare(a: Cost, b: Cost): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function keyOf(order: readonly number[], stops: readonly OrderStop[]): string {
  return order.map((i) => stops[i].ref).join("|");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
