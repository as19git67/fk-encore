/**
 * Applying §7.3's first way to a solved day.
 *
 * The bridge between the pure ordering rule (`light-order.ts`) and the
 * blocks the solver just produced: work out which stops actually want
 * an hour, ask for the best order, and — when it changed — recompute
 * the walks so the card still says what the day costs.
 *
 * Two limits are kept here rather than in the pure module, because they
 * are about *this* planner rather than about light:
 *
 *   - **Only a marked photo stop has a window.** §7.3 lets the sun
 *     speak for the spots somebody marked, and for nothing else. A day
 *     with none marked leaves here untouched, which is the ordinary
 *     case and costs one pass over the blocks.
 *   - **Only a dated trip.** Without a date there is no sun to compute,
 *     and inventing one would move the day by however far the guess was
 *     wrong.
 */

import type { Coordinate } from "./travel";
import { travelLeg, type TransportMode } from "./travel";
import { lightWindows } from "./sun";
import { spotLight } from "./light";
import type { PlannedBlock, PlannedStop } from "./solver";
import { orderForLight, type LightOrderStop } from "./light-order";

export interface LightOrderContext {
  /** The day being planned, as YYYY-MM-DD. */
  date: string;
  /** Where the day happens — one place is enough within a city (§7.3). */
  at: Coordinate;
  /**
   * The destination's offset from UTC. When the caller does not know
   * it, one is estimated from the longitude — see `offsetFor`.
   */
  utcOffsetMinutes?: number;
  mode?: TransportMode;
  /** When each block begins, by block id. Blocks without an hour are skipped. */
  startMinutesByBlock: ReadonlyMap<string, number | null>;
}

/**
 * The same blocks, with the stops of each in the order the light wants.
 *
 * Never changes which stops are in which block: §7.3 permits the
 * sequence and nothing else.
 */
export function orderBlocksForLight(
  blocks: readonly PlannedBlock[],
  context: LightOrderContext,
): PlannedBlock[] {
  const marked = blocks.some((block) => block.stops.some((stop) => stop.photoStop === true));
  if (!marked) return [...blocks];

  const windows = lightWindows(context.at, context.date, offsetFor(context));
  if (windows.length === 0) return [...blocks];

  return blocks.map((block) => {
    const startMinutes = context.startMinutesByBlock.get(block.id);
    // A block without an hour cannot be aligned to one: §8.3 keeps the
    // frame time optional, and guessing it would put the group
    // somewhere they were never planned to be.
    if (startMinutes === null || startMinutes === undefined) return block;
    if (block.stops.length < 2) return block;

    const byRef = new Map(block.stops.map((stop) => [stop.osmRef, stop]));
    const blockEnds = startMinutes + block.budgetMinutes;
    const forOrdering: LightOrderStop[] = block.stops.map((stop) => ({
      osmRef: stop.osmRef,
      dwellMinutes: stop.dwellMinutes,
      window: windowFor(stop, windows, context, startMinutes, blockEnds),
    }));

    const result = orderForLight(forOrdering, {
      startMinutes,
      budgetMinutes: block.budgetMinutes,
      travelMinutes: (from, to) => {
        const target = byRef.get(to)!;
        const start = from === null ? context.at : byRef.get(from)!;
        return travelLeg(start, target, context.mode ?? "foot").minutes;
      },
    });
    if (!result.reordered) return block;

    // The walks are part of what the card shows, so they are recomputed
    // rather than carried over from the order that no longer exists.
    let position: Coordinate = context.at;
    let used = 0;
    const stops: PlannedStop[] = result.stops.map((ordered) => {
      const stop = byRef.get(ordered.osmRef)!;
      const leg = travelLeg(position, stop, context.mode ?? "foot");
      position = { lat: stop.lat, lon: stop.lon };
      used += leg.minutes + stop.dwellMinutes;
      return { ...stop, travelFromPrevious: leg };
    });

    return { ...block, stops, usedMinutes: used };
  });
}

/**
 * The offset to compute the sun in, in minutes.
 *
 * This one matters more here than anywhere else the light is used. A
 * ranking bonus only asks *which* spot is golden, and an hour's error
 * changes little; an **order** compares the sun's clock with the
 * block's, and the block's clock is the destination's own (§4.4). Left
 * at UTC, a plan in Munich would put the evening viewpoint two hours
 * too early — an error in exactly the unpleasant direction §7.3 warns
 * about.
 *
 * So when the caller does not say, the longitude does: fifteen degrees
 * to the hour. It is wrong by up to half an hour at the edges of a zone
 * and knows nothing of summer time, which is the same order of accuracy
 * the planner already accepts for travel times (§14) — and it is right
 * about the thing that matters here, which is whether the golden hour
 * falls before or after the afternoon.
 */
export function offsetFor(context: Pick<LightOrderContext, "at" | "utcOffsetMinutes">): number {
  if (context.utcOffsetMinutes !== undefined) return context.utcOffsetMinutes;
  return Math.round(context.at.lon / 15) * 60;
}

/**
 * When this stop wants to be visited within *this block*, or null.
 *
 * Only for a spot somebody marked, and only golden or blue: the harsh
 * middle of the day is a caveat, and scheduling *towards* it would be
 * the planner reading its own note backwards.
 *
 * The window is chosen for the block rather than for the day. A
 * west-facing wall is lit at dawn as well as at dusk, and taking the
 * globally best window would drag an afternoon stop towards five in
 * the morning — a target the block cannot reach and therefore no
 * target at all. So the nearest reachable one wins, with golden ahead
 * of blue where both are equally near.
 */
function windowFor(
  stop: PlannedStop,
  windows: ReturnType<typeof lightWindows>,
  context: LightOrderContext,
  blockStarts: number,
  blockEnds: number,
): { fromMinutes: number; toMinutes: number } | null {
  if (stop.photoStop !== true) return null;

  let best: { fromMinutes: number; toMinutes: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const lit of spotLight(context.at, windows, stop.facadeAzimuth)) {
    const { kind, fromMinutes, toMinutes } = lit.window;
    if (kind !== "golden" && kind !== "blue") continue;
    // How far outside the block this window lies. Zero when they
    // overlap at all, which is the case worth aligning to.
    const distance = fromMinutes > blockEnds
      ? fromMinutes - blockEnds
      : toMinutes < blockStarts ? blockStarts - toMinutes : 0;
    if (distance < bestDistance) {
      best = { fromMinutes, toMinutes };
      bestDistance = distance;
    }
  }
  return best;
}
