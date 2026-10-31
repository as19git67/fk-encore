/**
 * The seeded random source of the demo generator
 * (documentation/plans/demodaten.md): everything the code decides — dates,
 * amounts, which grocery run happens on which day — comes from here, so the
 * same seed gives the same household.
 *
 * mulberry32: small, fast and good enough for picking demo data; not for
 * anything that needs to be unpredictable.
 */

export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** An amount in [min, max] in cents, rounded to whole cents. */
  cents(min: number, max: number): number;
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[int(0, items.length - 1)];
    },
    cents: (min, max) => int(Math.round(min * 100), Math.round(max * 100)),
  };
}
