/**
 * When a leg's own pool does not carry its days (§4.6).
 *
 * > Ich sage nur „vier Tage in San Gimignano" — und Florenz, Pisa und
 * > Lucca sollen trotzdem im Plan vorkommen.
 *
 * A town of seven thousand does not carry four days, and everybody you
 * ask says so. But the planner invents no appointments (§7.1), and
 * sixty kilometres are a decision about a day rather than a side
 * effect of a search — so before anything may be *suggested*, the case
 * has to be **measured**. This module is that measurement and nothing
 * else: it answers "do the days add up", never "where should we go".
 *
 * ## What is measured, and why it is this
 *
 * "Small town" is not a quantity this system has. What it does have,
 * once a leg is planned, is the arithmetic the solver just did:
 *
 *   - **Empty minutes** — block budget the planner could not fill. The
 *     solver fills every block inside its budget and stops when there
 *     is nothing left worth placing, so an unfilled budget is the
 *     pool's own statement about itself.
 *   - **What the pool still holds** — the dwell of every candidate not
 *     on a day. This is the guard that keeps the measure honest, and
 *     it is the whole difference between §4.6's suggestion and a
 *     nuisance: a leg with twenty spots left over has empty blocks for
 *     some *other* reason (too far, no time, a fixpoint in the way),
 *     and sending those travellers an hour down the road answers a
 *     question nobody asked.
 *
 * So the verdict is the comparison of the two: **even if everything
 * left in the pool were planned, a whole day of this leg would still
 * be empty.** That cannot be confused with a short afternoon — §4.6 is
 * explicit that "untervorrätig heißt, die Tage tragen nicht, nicht,
 * ein Block ist kurz" — and it needs no threshold anybody has to
 * defend, because both sides are minutes the plan already knows.
 *
 * ## Which days count
 *
 * A day that already goes somewhere else (§4.5) is not a day the base
 * has to carry, and a buffer day is empty on purpose (§7.2). Neither
 * is evidence of anything, so neither is counted — on either side of
 * the comparison.
 */

/** A day as this measure needs to see it. */
export interface ThinPoolDay {
  dayIndex: number;
  /** Set when the day already happens elsewhere (§4.5). */
  hasOwnAnchor: boolean;
  /** Why the day is empty on purpose (§7.2), or null for an ordinary day. */
  bufferReason?: string | null;
  blocks: readonly { budgetMinutes: number; usedMinutes: number }[];
}

export interface ThinPoolInput {
  days: readonly ThinPoolDay[];
  /** What the leg's pool still holds, by dwell time. */
  pool: readonly { dwellMinutes: number }[];
}

/** Why a leg is not undersupplied, when it is not. */
export type ThinPoolReason =
  | "thin"
  /** One day cannot be undersupplied: there is nothing to go instead of. */
  | "too-few-days"
  /** The blocks are full. Nothing to suggest anything for. */
  | "days-are-full"
  /** There are empty blocks, but the pool can still fill them. */
  | "pool-has-more";

export interface ThinPoolVerdict {
  thin: boolean;
  reason: ThinPoolReason;
  /** Block budget the planner could not fill, over the whole leg. */
  emptyMinutes: number;
  /** What the pool could still put into it. */
  poolMinutes: number;
  /** What would stay empty even then — the measure §4.6 turns on. */
  uncoveredMinutes: number;
  /** A day of this leg, in minutes: the mean budget of its own days. */
  dayMinutes: number;
  /**
   * The days that would carry a trip, emptiest first. A suggestion
   * takes the first of them; an empty list is never thin.
   */
  freeDays: number[];
}

/**
 * At least this many ordinary days, or the question does not arise.
 *
 * With one day there is nothing to go *instead of*: suggesting a trip
 * would not fill the leg, it would replace it, and that is the
 * traveller's own decision to make (§7.1).
 */
export const MIN_DAYS_FOR_A_TRIP = 2;

export function measureThinPool(input: ThinPoolInput): ThinPoolVerdict {
  // A day trip and a buffer day are not evidence: the first already
  // happens elsewhere, the second is empty because somebody said so.
  const ordinary = input.days.filter(
    (day) => !day.hasOwnAnchor && !day.bufferReason,
  );

  const emptyByDay = new Map<number, number>();
  let emptyMinutes = 0;
  let budgetMinutes = 0;
  for (const day of ordinary) {
    let empty = 0;
    for (const block of day.blocks) {
      budgetMinutes += Math.max(0, block.budgetMinutes);
      empty += Math.max(0, block.budgetMinutes - block.usedMinutes);
    }
    emptyByDay.set(day.dayIndex, empty);
    emptyMinutes += empty;
  }

  const poolMinutes = input.pool.reduce(
    (sum, candidate) => sum + Math.max(0, candidate.dwellMinutes),
    0,
  );
  const uncoveredMinutes = Math.max(0, emptyMinutes - poolMinutes);
  const dayMinutes = ordinary.length > 0 ? Math.round(budgetMinutes / ordinary.length) : 0;

  // Emptiest first: if one day of four is to become a trip, it is the
  // one the pool was least able to fill.
  const freeDays = [...emptyByDay.entries()]
    .filter(([, empty]) => empty > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([dayIndex]) => dayIndex);

  const verdict = {
    emptyMinutes,
    poolMinutes,
    uncoveredMinutes,
    dayMinutes,
    freeDays,
  };

  if (ordinary.length < MIN_DAYS_FOR_A_TRIP) {
    return { thin: false, reason: "too-few-days", ...verdict };
  }
  if (emptyMinutes === 0 || freeDays.length === 0) {
    return { thin: false, reason: "days-are-full", ...verdict };
  }
  // The heart of it: a day's worth would stay empty *after* the pool
  // had given everything it has.
  if (dayMinutes === 0 || uncoveredMinutes < dayMinutes) {
    return { thin: false, reason: "pool-has-more", ...verdict };
  }
  return { thin: true, reason: "thin", ...verdict };
}
