/**
 * Scoring a curated selection (§11.3).
 *
 * Unlike reading a sentence, curation has no single right answer — so
 * this does not pretend to grade taste. It counts four things that are
 * faults under anybody's taste, and reports coverage and spread
 * alongside them without folding everything into one number:
 *
 *   - **erfunden** — a ref that was not in the pool (§10.4). The one
 *     unforgivable one: a plan cannot visit a place that does not
 *     exist, and it is the failure mode a language model has and a
 *     weighted sum does not.
 *   - **Alltag** — things that exist rather than things you go and see.
 *   - **Einerlei** — more than `clusterBudget` from one interchangeable
 *     group. Six village churches is not a two-day trip.
 *   - **Kind** — entries marked as little for a seven-year-old, when
 *     the request says one is coming.
 *   - **überhört** — a theme the sentence asked for that got no pick at
 *     all. Not "too little of it", which would be grading taste — none
 *     of it, which is not having read the sentence.
 *
 * And two descriptive figures, deliberately not "scores": how many of
 * the plain landmarks were found, and how many categories the selection
 * spans. A selection can legitimately skip a landmark; it cannot
 * legitimately be six churches.
 */

import { CLUSTER_BUDGET, type LabelledSpot, type Theme } from "./curation-cases";

export interface CurationPick {
  osmRef: string;
  /** The one line of reasoning, where the track produced one. */
  why?: string;
}

export interface CurationScore {
  picked: number;
  /** Refs that were not in the pool at all. */
  invented: string[];
  everyday: string[];
  /** Groups where more than the budget was taken, with the count. */
  monotony: Array<{ cluster: string; taken: number; budget: number }>;
  poorForChildren: string[];
  /** Of the plain landmarks, how many made it in. */
  landmarksFound: number;
  landmarksTotal: number;
  /** Distinct categories in the selection. */
  categories: string[];
  /** Picks that came with a reason. §8.3 wants the "why" to be arguable. */
  withReason: number;
  /** Per theme the sentence asked for, how many picks serve it. */
  themeCoverage: Array<{ theme: Theme; picks: number }>;
  /**
   * Themes the sentence asked for that got **nothing**.
   *
   * The one taste-free fault in this area. "Too little history" is an
   * argument; "the sentence said history and the selection has none" is
   * an oversight, and it is what separated the two tracks in the first
   * run without any number noticing.
   */
  overheard: Theme[];
}

export function scoreCuration(
  pool: readonly LabelledSpot[],
  picks: readonly CurationPick[],
  wants: readonly Theme[] = [],
  clusterBudget: number = CLUSTER_BUDGET,
): CurationScore {
  const byRef = new Map(pool.map((entry) => [entry.spot.osmRef, entry]));
  const seen = new Set<string>();

  const invented: string[] = [];
  const everyday: string[] = [];
  const poorForChildren: string[] = [];
  const categories = new Set<string>();
  const perCluster = new Map<string, number>();
  const perTheme = new Map<Theme, number>();
  let withReason = 0;

  for (const pick of picks) {
    // A ref named twice is one pick, not two — otherwise a track could
    // pad its selection and look broader than it is.
    if (seen.has(pick.osmRef)) continue;
    seen.add(pick.osmRef);
    if (pick.why !== undefined && pick.why.trim() !== "") withReason += 1;

    const entry = byRef.get(pick.osmRef);
    if (!entry) {
      invented.push(pick.osmRef);
      continue;
    }
    if (entry.label.everyday) everyday.push(nameOf(entry));
    if (entry.label.poorForChildren) poorForChildren.push(nameOf(entry));
    const category = entry.spot.categories[0];
    if (category) categories.add(category);
    if (entry.label.cluster) {
      perCluster.set(entry.label.cluster, (perCluster.get(entry.label.cluster) ?? 0) + 1);
    }
    for (const theme of entry.label.themes ?? []) {
      perTheme.set(theme, (perTheme.get(theme) ?? 0) + 1);
    }
  }

  const monotony = [...perCluster.entries()]
    .filter(([, taken]) => taken > clusterBudget)
    .map(([cluster, taken]) => ({ cluster, taken, budget: clusterBudget }));

  const landmarks = pool.filter((entry) => entry.label.landmark);
  return {
    picked: seen.size,
    invented,
    everyday,
    monotony,
    poorForChildren,
    landmarksFound: landmarks.filter((entry) => seen.has(entry.spot.osmRef)).length,
    landmarksTotal: landmarks.length,
    categories: [...categories].sort(),
    withReason,
    themeCoverage: wants.map((theme) => ({ theme, picks: perTheme.get(theme) ?? 0 })),
    overheard: wants.filter((theme) => (perTheme.get(theme) ?? 0) === 0),
  };
}

/**
 * The faults, added up — for the one line at the bottom.
 *
 * Only the four faults go in here, and each counts once per offending
 * pick. Coverage and spread stay outside deliberately: they describe a
 * selection, they do not condemn it, and mixing the two would let a
 * track buy its way out of a mistake by finding one more landmark.
 */
export function faultsOf(score: CurationScore): number {
  return score.invented.length
    + score.everyday.length
    + score.poorForChildren.length
    + score.overheard.length
    + score.monotony.reduce((total, group) => total + (group.taken - group.budget), 0);
}

function nameOf(entry: LabelledSpot): string {
  return entry.spot.name ?? entry.spot.osmRef;
}
