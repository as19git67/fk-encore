/**
 * Browsing a region instead of naming a place (§9.2, case 4, widened).
 *
 * Case 4 was always "you know what it is called, you type it". That is
 * the way in that must work when everything else fails, and it answers
 * exactly one question: *is this place in there?* It cannot answer the
 * question people actually ask first — **what is here at all?**
 *
 * The data for that has been in the region databases since the first
 * import, and until now only the solver looked at it. A person could
 * reach it through a name filter and no other way, which is a strange
 * thing to say about a list of everything worth seeing.
 *
 * So the filter becomes optional and the *interest* becomes the query:
 * tap "Aussicht", get what is there, ordered by how much of a thing it
 * is rather than by how close it happens to be.
 *
 * Two decisions live here because both are pure and both are the sort
 * that goes quietly wrong:
 *
 *   - **Interests are matched here, not in the region search.** The
 *     geo query filters by category, and an interest is not a category:
 *     „Burgen und Schlösser" is a set of OSM tags with no category of
 *     its own, and „Kirchen und Klöster" has one that only some of its
 *     tags produce. Narrowing the query by the categories an interest
 *     mentions would silently drop the castle that carries no category
 *     at all — so the search asks broadly and the choice is applied to
 *     what comes back.
 *   - **An empty answer says which kind of empty it is.** „Nichts
 *     gefunden" covers three different situations, and only one of them
 *     is about this place having nothing in it. The other two are a
 *     region nobody imported and a filter that was too narrow, and both
 *     are fixable by the reader — if anybody tells them.
 */

import { matchesInterest } from "./interests";

/** What browsing needs to know about a candidate to order it. */
export interface BrowsableSpot {
  osmRef: string;
  name: string | null;
  kind?: string | null;
  category: string;
  score: number;
  distanceM: number;
}

/**
 * Does this spot answer any of the chosen interests?
 *
 * Nothing chosen means everything qualifies: an empty filter is "show
 * me what is here", not "show me nothing".
 */
export function keepsInterest(
  spot: { kind?: string | null; category: string },
  chosen: readonly string[],
): boolean {
  if (chosen.length === 0) return true;
  return matchesInterest(spot, chosen);
}

/**
 * Prominence first, distance second.
 *
 * The opposite of `nearby.ts`, and deliberately: that one answers "what
 * is within walking distance of where I stand", where the nearest is
 * the best answer almost by definition. This answers "what is this area
 * known for", where the nearest is an accident of which street the
 * search was centred on. The cathedral outranks the chapel across the
 * road even though the chapel is closer.
 *
 * Ties break on distance and then on the reference, so the same query
 * twice gives the same list — a browse that reshuffles itself on every
 * refresh looks broken even when both orders are defensible.
 */
export function orderForBrowsing<T extends BrowsableSpot>(spots: readonly T[]): T[] {
  return [...spots].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    return a.osmRef.localeCompare(b.osmRef);
  });
}

/**
 * Why the list is empty, in words somebody can act on — or null when
 * it is not empty and there is nothing to explain.
 *
 * The order of the tests is the order of the causes: a region that was
 * never imported has no opinion about interests, and a filter cannot be
 * blamed for an area the search could not reach.
 */
export function emptinessNote(state: {
  /** No imported region covers the point that was asked about. */
  regionMissing: boolean;
  /** How many spots the region search returned, before filtering. */
  found: number;
  /** How many survived the interest filter and the name. */
  kept: number;
  /** Whether an interest filter was applied at all. */
  filtered: boolean;
}): string | null {
  if (state.regionMissing) {
    return "Diese Gegend ist noch nicht importiert — bis dahin weiß der Planer hier nichts.";
  }
  if (state.kept > 0) return null;
  if (state.found > 0 && state.filtered) {
    return "Hier gibt es etwas, aber nichts davon passt zur Auswahl.";
  }
  return "In diesem Umkreis kennt OpenStreetMap nichts, was sich anzusehen lohnt.";
}
