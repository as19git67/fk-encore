/**
 * A name and a rough area to one place — or to an honest "which one?".
 *
 * §9.3 stage 4 needs this for every name a language model pulls out of
 * an article, and §10.6 needs the same thing for a merchant name on a
 * receipt. The concept says outright that the two should share a
 * building block, so this is it: *name plus area → POI*, with three
 * outcomes and no fourth.
 *
 *   - **unique** — one place is clearly the one meant.
 *   - **ambiguous** — several are, and the traveller is asked. Three
 *     branches of the same café in one city is the ordinary case, not
 *     an error.
 *   - **none** — nothing matched. It stays a note with its link and its
 *     quote until someone resolves it by hand. Nothing is invented
 *     (§10.4).
 *
 * Deciding here rather than in SQL is deliberate. The database narrows
 * to a substring inside an area, which is cheap and index-shaped;
 * whether "Stadtmuseum" in an article means the row called "Stadtmuseum
 * Beispielstadt" is a judgement, and judgements belong where they can
 * be read and tested.
 *
 * **What this does not do** is use the place hint an article gives
 * ("in der Altstadt", "near the harbour"). There is no gazetteer of
 * districts behind it, so any use of the hint would be a coincidence
 * dressed up as a rule — the honest thing is to carry it along as
 * provenance and let the area do the narrowing. The hint is part of the
 * find's note, not part of this decision.
 */

import { foldName } from "./name-fold";

export interface PlaceCandidate {
  osmRef: string;
  name: string | null;
  nameDe: string | null;
  nameEn: string | null;
  lat: number;
  lon: number;
  distanceM: number | null;
  categories: string[];
}

export type PlaceVerdict = "unique" | "ambiguous" | "none";

export interface PlaceResolution {
  verdict: PlaceVerdict;
  /** Set only for "unique". */
  match: PlaceCandidate | null;
  /**
   * For "ambiguous", the places to choose between, nearest first and
   * capped. For "unique" and "none", empty.
   */
  options: PlaceCandidate[];
}

/**
 * How many places to offer when the name is ambiguous.
 *
 * A list to pick from stops being a question and becomes a search
 * result somewhere around here; past that, asking again with a better
 * name is the faster way out.
 */
export const MAX_AMBIGUOUS_OPTIONS = 5;

/**
 * Resolve one name against the candidates an area search returned.
 *
 * Two rounds, and the first that produces anything wins. An **exact**
 * match on any of the three name tags settles it: where a row is called
 * precisely what the article called it, a row that merely contains the
 * word is not a rival. Only when nothing matches exactly do the partial
 * matches get their turn — that is what saves "Stadtmuseum" for
 * "Stadtmuseum Beispielstadt" without letting "Museum" claim it.
 */
export function resolvePlace(
  wantedName: string,
  candidates: readonly PlaceCandidate[],
): PlaceResolution {
  const wanted = foldName(wantedName);
  if (wanted.length === 0) return { verdict: "none", match: null, options: [] };

  const exact = candidates.filter((c) => namesOf(c).some((n) => n === wanted));
  const round = exact.length > 0
    ? exact
    : candidates.filter((c) => namesOf(c).some((n) => n.includes(wanted)));

  if (round.length === 0) return { verdict: "none", match: null, options: [] };
  if (round.length === 1) return { verdict: "unique", match: round[0], options: [] };

  return {
    verdict: "ambiguous",
    match: null,
    options: byDistance(round).slice(0, MAX_AMBIGUOUS_OPTIONS),
  };
}

/**
 * Every name a candidate goes by, folded.
 *
 * All three are equal here on purpose: an English-language blog names
 * the place the way `name:en` does, and preferring the local `name`
 * would turn a clean match into a miss.
 */
function namesOf(candidate: PlaceCandidate): string[] {
  return [candidate.name, candidate.nameDe, candidate.nameEn]
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map(foldName);
}

/**
 * Nearest first, with the distance-less candidates behind them rather
 * than in front: an unknown distance is not a short one.
 */
function byDistance(candidates: readonly PlaceCandidate[]): PlaceCandidate[] {
  return [...candidates].sort((a, b) => {
    const da = a.distanceM ?? Number.POSITIVE_INFINITY;
    const db = b.distanceM ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    // A stable tie-break so the same question is asked the same way
    // twice — an option list that reshuffles between two identical
    // requests is a bug report waiting to happen.
    return a.osmRef.localeCompare(b.osmRef);
  });
}
