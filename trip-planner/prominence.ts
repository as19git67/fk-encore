/**
 * How well known a place is, from open data (candidate ranking plan,
 * stage 1).
 *
 * The pool used to be ordered by three signals that are a database
 * state rather than a judgement: a Wikidata item, a Wikipedia article
 * and a `tourism=*` tag, worth one point, one point and half a point.
 * In a city almost everything worth a block has all three, so most of
 * a pool tied (§11.0 measured 18 of 34 places at 3.0), and the order
 * the region database answered in decided which made the cut.
 *
 * This replaces the two Wikimedia half of that sum with numbers that
 * actually differ between a cathedral and a side chapel, every one of
 * them open, keyless and cacheable:
 *
 *   - **Page views** — how many people read the article in a month;
 *   - **Language editions** — in how many Wikipedias it has an article;
 *   - **Wikivoyage** — whether the travel guide names it as a sight;
 *   - **Commons pictures** — how many photographs people bothered to
 *     upload.
 *
 * The mapped `tourism=*` tag stays as it was: a judgement a mapper made
 * on the ground.
 *
 * Pure: raw numbers in, points and sentences out. Fetching lives in
 * `fame-client.ts`, caching in `spot-fame.ts`.
 */

/** What open data says about one place. Null where a source has no answer. */
export interface SpotFame {
  /** Monthly average over the last twelve months, of the article tagged on the map. */
  pageviews: number | null;
  /** Wikipedia language editions with an article on it (Wikidata sitelinks). */
  languages: number | null;
  /** Files in its Commons category (P373). */
  commonsFiles: number | null;
  /**
   * The one-line description Wikivoyage's sights give it when it is
   * listed — an empty string for a listing without one. Null: not listed.
   */
  wikivoyage: string | null;
}

export interface Prominence {
  /** 0–3: the pool's lowest quarter to its highest. */
  tier: number;
  /** Added to the base score of 1, in place of the old Wikimedia points. */
  points: number;
  /** The strongest facts, for "Warum hier?" (§8.3). */
  reasons: string[];
}

/**
 * Points per tier. The range matches the two points a Wikidata item and
 * a Wikipedia article gave, so a pool where some places are not yet
 * looked up orders the rest the way it did and does not throw the
 * unknown ones to the bottom. Well below `MANUAL_SCORE`: a place
 * somebody added stays above everything the region search offers.
 */
export const TIER_POINTS: readonly number[] = [0.5, 1.2, 1.8, 2.5];

/**
 * One number to rank by. Logarithms, because fame is multiplicative:
 * 20,000 views a month against 2,000 is the same step as 2,000 against
 * 200, and a sum of raw counts would be decided by page views alone.
 *
 * Page views carry the most weight because they measure people today;
 * language editions measure fame across countries and decades; Commons
 * counts measure how photogenic a place is as much as how known; a
 * Wikivoyage listing is a travel writer's judgement, worth roughly a
 * tenfold of readers.
 */
export function fameValue(fame: SpotFame): number | null {
  if (fame.pageviews === null && fame.languages === null
      && fame.commonsFiles === null && fame.wikivoyage === null) return null;
  return Math.log10((fame.pageviews ?? 0) + 1)
    + 0.6 * Math.log10((fame.languages ?? 0) + 1)
    + 0.3 * Math.log10((fame.commonsFiles ?? 0) + 1)
    + (fame.wikivoyage !== null ? 1 : 0);
}

/**
 * The tier of every place, **relative within the pool**.
 *
 * Fixed thresholds would not work: 2,000 views a month is a lot in a
 * village and nothing in a capital. So the pool's own quartiles decide:
 * the top quarter of this pool is tier 3, wherever the pool is. A pool
 * of one has nothing to be compared with and gets the middle.
 */
export function prominenceOf(fames: ReadonlyMap<string, SpotFame>): Map<string, Prominence> {
  const values = [...fames.entries()]
    .map(([ref, fame]) => [ref, fameValue(fame)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null);
  const sorted = values.map(([, value]) => value).sort((a, b) => a - b);
  const out = new Map<string, Prominence>();
  for (const [ref, value] of values) {
    const tier = sorted.length < 2 ? 2 : tierOf(value, sorted);
    out.set(ref, {
      tier,
      points: TIER_POINTS[tier],
      reasons: reasonsFor(fames.get(ref) as SpotFame, tier),
    });
  }
  return out;
}

/** The quartile a value falls into; ties share the higher tier. */
function tierOf(value: number, sorted: readonly number[]): number {
  // How many values lie strictly below this one, as a share of the rest.
  let below = 0;
  while (below < sorted.length && sorted[below] < value) below += 1;
  const share = below / (sorted.length - 1);
  if (share >= 0.75) return 3;
  if (share >= 0.5) return 2;
  if (share >= 0.25) return 1;
  return 0;
}

/**
 * The facts worth saying. A tier is not a reason — "Bekanntheit: 3"
 * cannot be argued with — so the card says the numbers behind it, and
 * only the ones that set the place apart: twelve views a month is a
 * fact too, and not one that recommends anything.
 */
function reasonsFor(fame: SpotFame, tier: number): string[] {
  const reasons: string[] = [];
  if (fame.wikivoyage !== null) reasons.push("in Wikivoyage genannt");
  if (fame.pageviews !== null && fame.pageviews >= 500 && tier >= 1) {
    reasons.push(`${germanCount(roundForReading(fame.pageviews))} Aufrufe im Monat`);
  }
  if (fame.languages !== null && fame.languages >= 10) {
    reasons.push(`Artikel in ${fame.languages} Sprachen`);
  }
  if (fame.commonsFiles !== null && fame.commonsFiles >= 100) {
    reasons.push(`über ${germanCount(floorForReading(fame.commonsFiles))} Bilder auf Commons`);
  }
  return reasons;
}

/** 12,345 → 12,000: the card is not an audit. */
function roundForReading(n: number): number {
  if (n < 1_000) return Math.round(n / 10) * 10;
  if (n < 10_000) return Math.round(n / 100) * 100;
  return Math.round(n / 1_000) * 1_000;
}

/** 237 → 200, for "über …": the number said must not exceed the real one. */
function floorForReading(n: number): number {
  const step = n < 1_000 ? 100 : n < 10_000 ? 1_000 : 10_000;
  return Math.floor(n / step) * step;
}

/** "12.000" — the German thousands separator, whatever the server's locale. */
export function germanCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** The monthly average out of a pageviews answer's items. */
export function monthlyAverage(views: readonly number[]): number | null {
  if (views.length === 0) return null;
  return Math.round(views.reduce((sum, v) => sum + v, 0) / views.length);
}
