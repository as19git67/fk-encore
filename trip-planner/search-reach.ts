/**
 * How far a leg looks for spots, and why two searches rather than one.
 *
 * ## The radius
 *
 * The old default was 2 500 m for every leg, which is a walking radius
 * around a European old town — the case it was written for. A trip to
 * San Francisco planned inside it finds the blocks around the hotel and
 * nothing else: the Golden Gate Bridge is 6 km away, the park 7, the
 * sea lions 3, Sausalito 10. All of them were simply not searched.
 *
 * So the reach follows the mode (§4.2), because the mode is what says
 * how far "a day out from here" reaches. On foot the old number is
 * right; in a car, half an hour of driving is the way to the coast, not
 * a detour.
 *
 * ## The two searches
 *
 * The area search returns a *page*, and with a centre it fills that
 * page nearest-first. The planner then keeps what looks worth a block.
 * Cut by distance, filtered by prominence: in a dense city the nearest
 * two hundred rows are two hundred ordinary ones and the bridge
 * everybody came for is row nine thousand — it never reaches the
 * filter, so no amount of scoring can rescue it.
 *
 * The fix is to ask twice over the same disc — once for what is near,
 * once for what the place is known for — and plan out of both. Neither
 * page alone is the answer: prominence alone would plan a day of
 * monuments across a county and miss the square round the corner.
 */

/** Reach per mode, in metres. */
const REACH_BY_MODE: Readonly<Record<string, number>> = {
  // A day on foot is a day in one quarter. This is the number the
  // planner has always used, and for walking it was never wrong.
  foot: 3_000,
  // A bike turns "the next quarter" into "the other side of town".
  bike: 8_000,
  // Far enough for the line that goes somewhere, short enough that the
  // pool is still about this city.
  transit: 18_000,
  // Half an hour of driving. Sausalito is ten kilometres from
  // Fisherman's Wharf, and a car makes that an afternoon.
  car: 25_000,
};

const FALLBACK_REACH_M = 3_000;

/** The cap, matching what the geo service will search at all. */
export const MAX_SEARCH_RADIUS_M = 50_000;

/**
 * What to search when nobody said.
 *
 * An explicit `radiusM` always wins: somebody who says "two kilometres,
 * we are staying in the quarter" has answered this question better than
 * any table can.
 */
export function searchRadiusFor(mode: string | undefined): number {
  if (mode === undefined) return FALLBACK_REACH_M;
  return REACH_BY_MODE[mode] ?? FALLBACK_REACH_M;
}

/**
 * One pool out of the near page and the prominent one.
 *
 * Order matters only for the tie-break further down the line, so the
 * near page leads: everything else being equal, the plan should prefer
 * the spot you can walk to. Duplicates — and there will be many, since
 * the two pages overlap wherever the famous thing is also close —
 * appear once.
 */
export function mergeByOsmRef<T extends { osmRef: string }>(
  ...pages: ReadonlyArray<readonly T[]>
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const spot of page) {
      if (seen.has(spot.osmRef)) continue;
      seen.add(spot.osmRef);
      merged.push(spot);
    }
  }
  return merged;
}
