/**
 * What makes a way worth a day, as far as open data can tell (§4.7).
 *
 * A list of forty signposted ways ordered by distance says where they
 * are and nothing about which to take. OpenStreetMap does not rate —
 * there are no stars, no photos, no "people liked this" — but it does
 * know two things that stand in for them well enough:
 *
 *   - **What the way passes.** A summit, a viewpoint, a lake, a castle
 *     ruin within a stone's throw of the path. That is most of what a
 *     tour portal's "highlights" are, and it is already imported as
 *     POIs; the search only has to look along the line.
 *   - **How much the way matters to the people who signpost it.** A
 *     European long-distance trail or a national cycle route is
 *     maintained, waymarked and chosen; a local connector between two
 *     car parks is signposted too. A Wikipedia article is the same
 *     signal from outside the map.
 *
 * The score is a sort key, not a verdict, and the app never shows it
 * as a number: what it shows is the list of things along the way, so
 * the traveller can disagree with the order for their own reasons.
 */

/** What the app names, in the order a row lists them. */
export const HIGHLIGHT_CATEGORIES = [
  "peak",
  "viewpoint",
  "water",
  "castle",
  "historic",
  "nature",
  "tower",
  "sight",
  "food",
] as const;
export type HighlightCategory = (typeof HIGHLIGHT_CATEGORIES)[number];

/**
 * The POI kinds that count, and what each counts as.
 *
 * Chosen for "would somebody walk past it on purpose". `historic=*`
 * is imported whole and most of it is wayside crosses and boundary
 * stones, so only the kinds a walk is planned around are here.
 * Churches are left out for the same reason: every village has one,
 * and a way through five villages is not five times as good.
 */
export const HIGHLIGHT_KINDS: Readonly<Record<string, HighlightCategory>> = {
  "natural=peak": "peak",
  "tourism=viewpoint": "viewpoint",
  "natural=water": "water",
  "natural=beach": "water",
  "historic=castle": "castle",
  "building=castle": "castle",
  "building=palace": "castle",
  "historic=fort": "castle",
  "historic=ruins": "historic",
  "historic=archaeological_site": "historic",
  "historic=monastery": "historic",
  "building=monastery": "historic",
  "historic=city_gate": "historic",
  "historic=aqueduct": "historic",
  "leisure=nature_reserve": "nature",
  "man_made=tower": "tower",
  "man_made=lighthouse": "tower",
  "tourism=attraction": "sight",
  "amenity=restaurant": "food",
  "amenity=cafe": "food",
  "amenity=biergarten": "food",
};

/**
 * Kinds that count without a name.
 *
 * A viewpoint is often mapped as nothing more than a point with a
 * bench, and it is still the reason to take the path. Every other kind
 * needs a name: an unnamed tower is a phone mast as often as not.
 */
export const UNNAMED_HIGHLIGHT_KINDS: readonly string[] = ["tourism=viewpoint"];

/** How far from the line a thing may be and still count as passed. */
export const HIGHLIGHT_ALONG_M = 150;

export interface RouteHighlight {
  category: HighlightCategory;
  count: number;
  /** Up to three names, for the row to quote. */
  names: string[];
}

/** What the database hands back per kind. */
export interface KindCount {
  kind: string;
  count: number;
  names: string[] | null;
}

/**
 * Per category rather than per kind: a castle mapped as `building`
 * and one mapped as `historic` are the same thing to a walker.
 */
export function highlightsFrom(counts: readonly KindCount[] | null): RouteHighlight[] {
  const byCategory = new Map<HighlightCategory, RouteHighlight>();
  for (const row of counts ?? []) {
    const category = HIGHLIGHT_KINDS[row.kind];
    if (!category || row.count <= 0) continue;
    const entry = byCategory.get(category) ?? { category, count: 0, names: [] };
    entry.count += row.count;
    for (const name of row.names ?? []) {
      if (entry.names.length < 3 && !entry.names.includes(name)) entry.names.push(name);
    }
    byCategory.set(category, entry);
  }
  return HIGHLIGHT_CATEGORIES
    .map((category) => byCategory.get(category))
    .filter((entry): entry is RouteHighlight => entry !== undefined);
}

/**
 * Points per thing passed, and how many of each still add up.
 *
 * The caps matter more than the weights. Without them a cycle route
 * through a lakeside town wins on thirty cafés, and a way along a
 * chain of ponds beats one that climbs to a summit.
 */
const HIGHLIGHT_WEIGHTS: Readonly<Record<HighlightCategory, { each: number; cap: number }>> = {
  peak: { each: 2, cap: 2 },
  viewpoint: { each: 2, cap: 3 },
  water: { each: 1.5, cap: 2 },
  castle: { each: 2, cap: 2 },
  historic: { each: 1, cap: 3 },
  nature: { each: 1, cap: 1 },
  tower: { each: 1, cap: 2 },
  sight: { each: 1, cap: 2 },
  // Somewhere to stop is worth something, not much, and once.
  food: { each: 0.5, cap: 1 },
};

/**
 * The network, as how far people travel to walk it.
 *
 * `iwn`/`icn` is a European or international route, `nwn`/`ncn` a
 * national one, `rwn`/`rcn` regional, `lwn`/`lcn` local. Mountain-bike
 * routes are tagged with the cycling letters, so they need no case of
 * their own.
 */
export function networkRank(network: string | null | undefined): number {
  switch (network) {
    case "iwn":
    case "icn":
      return 3;
    case "nwn":
    case "ncn":
      return 2;
    case "rwn":
    case "rcn":
      return 1;
    default:
      return 0;
  }
}

export interface WorthInput {
  network: string | null;
  wikipedia: string | null;
  wikidata: string | null;
  highlights: readonly RouteHighlight[];
}

/** The sort key. Higher is better; the app never shows the number. */
export function routeWorth(input: WorthInput): number {
  let score = networkRank(input.network);
  if (input.wikipedia || input.wikidata) score += 2;
  for (const highlight of input.highlights) {
    const weight = HIGHLIGHT_WEIGHTS[highlight.category];
    score += weight.each * Math.min(highlight.count, weight.cap);
  }
  return Math.round(score * 10) / 10;
}
