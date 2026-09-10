/**
 * Putting the light in the right order (§7.3, first of the four ways).
 *
 * §7.3 is careful about how much the sun may decide, and the order
 * within a block is the mildest of the four: *"Der Aussichtspunkt
 * rutscht ans Ende des Nachmittags, die schattige Gasse in die
 * Mittagszeit. Kostet nichts, ändert die Auswahl nicht."* Both halves
 * of that sentence are rules here:
 *
 *   - **The selection is untouched.** The same spots stay in the block;
 *     only their sequence may change. Light is not allowed to decide
 *     what the day contains — that is what the ranking bonus does, once,
 *     in the pool.
 *   - **It costs nothing.** A reordering that adds walking is not free,
 *     and "free" is the entire justification for doing it at all. So a
 *     new order is accepted only when the extra walking stays inside a
 *     small tolerance, and never when it would push the block over its
 *     budget.
 *
 * The measure is deliberately blunt: how many minutes each photo stop
 * misses its window by. A stop that falls inside its window misses it
 * by nothing; one scheduled two hours early misses by two hours. Spots
 * nobody marked as a photo stop have no window and are carried along —
 * they are what makes the day, and the sun has no opinion about them.
 *
 * Pure: stops, a start time and a way to ask what a walk costs. No
 * clock, no coordinates of its own, no database.
 */

/** How much extra walking a better-lit order may cost. */
export const LIGHT_DETOUR_BUDGET_MINUTES = 8;

/**
 * Above this many stops the exact search is abandoned for neighbour
 * swaps. Six is the solver's own limit for permuting a block, and the
 * same reasoning applies: 720 orders is nothing, 40 320 is not.
 */
export const EXACT_ORDER_LIMIT = 6;

export interface LightWindowMinutes {
  fromMinutes: number;
  toMinutes: number;
}

export interface LightOrderStop {
  osmRef: string;
  dwellMinutes: number;
  /**
   * When this stop wants to be visited, in minutes past local midnight.
   * Null for everything nobody marked as a photo stop, which is most of
   * the day (§7.3: a hint, not a timetable).
   */
  window?: LightWindowMinutes | null;
}

export interface LightOrderOptions {
  /** When the block begins, in minutes past local midnight. */
  startMinutes: number;
  /** What the walk between two stops costs, by their references. */
  travelMinutes: (fromOsmRef: string | null, toOsmRef: string) => number;
  /** The block's own budget; an order that exceeds it is refused. */
  budgetMinutes: number;
  /** Extra walking a better-lit order may cost. */
  detourBudgetMinutes?: number;
}

export interface LightOrderResult {
  stops: LightOrderStop[];
  /** True when the order actually changed. */
  reordered: boolean;
  /** Minutes of missed light before and after, for the explanation. */
  missedBefore: number;
  missedAfter: number;
  /** What the reordering cost in extra walking. Zero or more. */
  extraTravelMinutes: number;
}

/**
 * How badly this order misses the light, in minutes.
 *
 * A stop is judged by the middle of its stay: arriving five minutes
 * before the golden hour ends is not "in the golden hour", and using
 * the arrival alone would say it was.
 */
export function missedLight(
  stops: readonly LightOrderStop[],
  options: Pick<LightOrderOptions, "startMinutes" | "travelMinutes">,
): number {
  let missed = 0;
  let at = options.startMinutes;
  let previous: string | null = null;
  for (const stop of stops) {
    at += options.travelMinutes(previous, stop.osmRef);
    const middle = at + stop.dwellMinutes / 2;
    if (stop.window) {
      if (middle < stop.window.fromMinutes) missed += stop.window.fromMinutes - middle;
      else if (middle > stop.window.toMinutes) missed += middle - stop.window.toMinutes;
    }
    at += stop.dwellMinutes;
    previous = stop.osmRef;
  }
  return Math.round(missed);
}

/** Travel plus dwell for one order, as the block would spend it. */
export function orderCost(
  stops: readonly LightOrderStop[],
  travelMinutes: LightOrderOptions["travelMinutes"],
): number {
  let total = 0;
  let previous: string | null = null;
  for (const stop of stops) {
    total += travelMinutes(previous, stop.osmRef) + stop.dwellMinutes;
    previous = stop.osmRef;
  }
  return total;
}

/**
 * The same stops, in the order that meets the light best.
 *
 * Returns the original order unchanged when nothing here wants a
 * particular hour — which is the ordinary case, and then this costs one
 * pass over the list.
 */
export function orderForLight(
  stops: readonly LightOrderStop[],
  options: LightOrderOptions,
): LightOrderResult {
  const unchanged = (): LightOrderResult => ({
    stops: [...stops],
    reordered: false,
    missedBefore: missedLight(stops, options),
    missedAfter: missedLight(stops, options),
    extraTravelMinutes: 0,
  });

  // Nothing to align, or nothing to swap: the sun has no opinion here.
  if (stops.length < 2) return unchanged();
  if (!stops.some((stop) => stop.window)) return unchanged();

  const budget = options.detourBudgetMinutes ?? LIGHT_DETOUR_BUDGET_MINUTES;
  const baseCost = orderCost(stops, options.travelMinutes);
  const baseMissed = missedLight(stops, options);

  let best = [...stops];
  let bestMissed = baseMissed;
  let bestCost = baseCost;

  const consider = (order: LightOrderStop[]) => {
    const cost = orderCost(order, options.travelMinutes);
    // Never at the price of the block itself: a day that no longer fits
    // is a worse answer than a badly lit photo (§4.1).
    if (cost > options.budgetMinutes) return;
    if (cost > baseCost + budget) return;
    const missed = missedLight(order, options);
    // A tie keeps the route the solver chose: it had reasons of its own,
    // and light is only allowed to break ties it actually improves.
    if (missed < bestMissed || (missed === bestMissed && cost < bestCost)) {
      best = order;
      bestMissed = missed;
      bestCost = cost;
    }
  };

  if (stops.length <= EXACT_ORDER_LIMIT) {
    for (const order of permutations([...stops])) consider(order);
  } else {
    // Adjacent swaps, repeated until nothing improves. Not exact, but a
    // block with seven stops is already past what §4.1 calls a block.
    let improving = true;
    while (improving) {
      improving = false;
      for (let i = 0; i + 1 < best.length; i += 1) {
        const swapped = [...best];
        [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
        const before = bestMissed;
        consider(swapped);
        if (bestMissed < before) improving = true;
      }
    }
  }

  const reordered = best.some((stop, i) => stop.osmRef !== stops[i].osmRef);
  return {
    stops: best,
    reordered,
    missedBefore: baseMissed,
    missedAfter: bestMissed,
    extraTravelMinutes: Math.max(0, Math.round(bestCost - baseCost)),
  };
}

/** Every order of these stops. Only called for short blocks. */
function* permutations(stops: LightOrderStop[]): Generator<LightOrderStop[]> {
  if (stops.length <= 1) {
    yield [...stops];
    return;
  }
  for (let i = 0; i < stops.length; i += 1) {
    const rest = [...stops.slice(0, i), ...stops.slice(i + 1)];
    for (const tail of permutations(rest)) yield [stops[i], ...tail];
  }
}
