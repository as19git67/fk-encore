/**
 * What the travellers are here for (§4, §8.1).
 *
 * Interests have been part of the constraints since the beginning and
 * have never worked. The scoring asked `interests.has(category)`, and a
 * category is one of nine ids — `sight`, `museum`, `viewpoint`,
 * `worship`, `theatre`, `food`, `cafe`, `essentials`, `outdoors`. The
 * interpreter, meanwhile, is told to extract *themes*: "barock",
 * "Industriegeschichte", "Burgen". A theme never equals a category id,
 * so the +2 was awarded to nobody and the setting was decoration.
 *
 * Two ways to fix that, and only one of them is honest today.
 *
 * The tempting one is free text matched against Wikipedia or Wikidata:
 * it would answer "barock" properly. But the candidate carries a
 * Wikidata id and an article *link*, not the article, and fetching a
 * hundred and fifty articles per planning run to grep them for a word
 * is a different feature with a different failure mode.
 *
 * So: **a small vocabulary of things OSM actually distinguishes.** Each
 * interest is a set of OSM tags — the same tags the region search
 * already uses to build categories — and matching is exact. What the
 * data cannot tell apart is not offered: there is no "Barock" here,
 * because OSM does not know which church is baroque, and an interest
 * that silently matches nothing is worse than one that does not exist.
 *
 * The list is deliberately short. Nine choices somebody reads in ten
 * seconds beat forty that need study, and every entry earns its place
 * by being a decision that changes which spots a day gets.
 */

export interface Interest {
  id: string;
  /** What the app shows. German, like the rest of the planner's UI. */
  label: string;
  /**
   * OSM `key=value` tags this interest counts as a hit. Matched against
   * the candidate's own tag, which is what the import kept.
   */
  kinds: readonly string[];
  /**
   * Category ids that count as a hit as well. Some interests *are* a
   * category — museums are the clear case — and stored interests from
   * before this vocabulary existed are category ids, so they keep
   * working rather than quietly meaning nothing.
   */
  categories: readonly string[];
}

export const INTERESTS: readonly Interest[] = [
  {
    id: "museum",
    label: "Museen und Galerien",
    kinds: ["tourism=museum", "tourism=gallery"],
    categories: ["museum"],
  },
  {
    id: "castles",
    label: "Burgen und Schlösser",
    kinds: [
      "historic=castle", "historic=palace", "historic=manor", "historic=fort",
      "historic=city_gate", "historic=tower", "building=castle", "building=palace",
    ],
    categories: [],
  },
  {
    id: "churches",
    label: "Kirchen und Klöster",
    kinds: [
      "amenity=place_of_worship", "building=church", "building=cathedral",
      "building=monastery", "historic=church", "historic=monastery",
    ],
    categories: ["worship"],
  },
  {
    id: "ruins",
    label: "Ruinen und Ausgrabungen",
    kinds: ["historic=ruins", "historic=archaeological_site", "historic=aqueduct"],
    categories: [],
  },
  {
    id: "technology",
    label: "Technik und Industriegeschichte",
    kinds: [
      "historic=mine", "historic=locomotive", "historic=aircraft", "historic=ship",
      "man_made=bridge", "man_made=lighthouse", "man_made=tower",
    ],
    categories: [],
  },
  {
    id: "art",
    label: "Kunst im Freien",
    kinds: ["tourism=artwork", "historic=monument", "historic=memorial", "man_made=obelisk"],
    categories: [],
  },
  {
    id: "views",
    label: "Aussicht",
    kinds: ["tourism=viewpoint"],
    categories: ["viewpoint"],
  },
  {
    id: "nature",
    label: "Natur und Parks",
    kinds: ["leisure=park", "leisure=playground"],
    categories: ["outdoors"],
  },
  {
    id: "stage",
    label: "Theater und Oper",
    kinds: ["amenity=theatre"],
    categories: ["theatre"],
  },
];

const BY_ID = new Map(INTERESTS.map((i) => [i.id, i]));

export function interestById(id: string): Interest | undefined {
  return BY_ID.get(id);
}

/**
 * Does this spot answer one of the chosen interests?
 *
 * Unknown ids answer no rather than throwing: a trip planned before an
 * interest was renamed keeps working, it simply stops matching — and a
 * planning run is the wrong place to discover a typo from months ago.
 */
export function matchesInterest(
  spot: { kind?: string | null; category: string },
  chosen: Iterable<string>,
): boolean {
  for (const id of chosen) {
    const interest = BY_ID.get(id);
    if (!interest) {
      // Stored free text from the interpreter ("barock"), or a category
      // id from before this vocabulary: the category id still counts,
      // the free text cannot and never did.
      if (id === spot.category) return true;
      continue;
    }
    if (interest.categories.includes(spot.category)) return true;
    if (spot.kind && interest.kinds.includes(spot.kind)) return true;
  }
  return false;
}

/** The label for a reason line, or the raw id when it is not one of ours. */
export function interestLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Which of the chosen interests this spot answers, for "why here?". */
export function matchedInterests(
  spot: { kind?: string | null; category: string },
  chosen: Iterable<string>,
): string[] {
  const hits: string[] = [];
  for (const id of chosen) {
    if (matchesInterest(spot, [id])) hits.push(interestLabel(id));
  }
  return hits;
}
