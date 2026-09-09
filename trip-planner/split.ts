/**
 * Apart for an afternoon, planned together (§6.5).
 *
 * The case is commoner than it looks: one into the technical museum,
 * the others to the market; a parent stays at the hotel with the
 * sleeping child. §6.5 fixes its shape in one sentence — **a split is
 * an attribute of a block, not a second trip** — and this module holds
 * the two pieces of arithmetic that follow from it.
 *
 * The first is the budget. Every branch starts where the group
 * separates and ends at the meeting point, and the meeting point is a
 * real fixpoint with a clock time (§4.4). So a branch's budget is not
 * a share of anything: it is the time from the separation to the
 * meeting, minus the way there and a margin. Two branches that walk in
 * opposite directions get different budgets from the same block, which
 * is exactly right and is the whole reason the solver can simply run
 * once per branch.
 *
 * The second is the proposal. §6.5 asks the planner to *offer* a split
 * when the votes pull apart, because the usual compromise — both
 * halved, or one of them dropped — is worse than separating: **a split
 * is conflict resolution rather than compromise**, the cheapest way to
 * give everybody what they wanted. Whether it happens is decided by
 * hand; this only finds the pair of spots that divides the group and
 * says who would go where.
 *
 * Pure: votes and minutes in, a suggestion and budgets out.
 */

import { DEFAULT_BUFFER_MINUTES, MIN_BUFFER_MINUTES } from "./fixpoints";

/** Below this a branch is an errand, not a branch worth planning. */
export const MIN_BRANCH_MINUTES = 30;

export interface BranchBudgetInput {
  /** When the group separates, in minutes past midnight. */
  startMinutes: number;
  /** When everybody is back together (§4.4's kind of time). */
  meetingMinutes: number;
  /** The way from this branch's last stop to the meeting point. */
  travelMinutes?: number;
  /** Margin in front of the meeting. Never zero, like a fixpoint's. */
  bufferMinutes?: number;
}

/**
 * What one branch has to spend, counted backwards from the meeting.
 *
 * The same rule §4.4 uses for a departure, and for the same reason:
 * being late for the group costs more than a skipped spot, so the
 * margin is negotiable but never nothing.
 */
export function branchBudget(input: BranchBudgetInput): number {
  const buffer = Math.max(input.bufferMinutes ?? DEFAULT_BUFFER_MINUTES, MIN_BUFFER_MINUTES);
  const travel = Math.max(input.travelMinutes ?? 0, 0);
  return Math.max(0, input.meetingMinutes - input.startMinutes - travel - buffer);
}

/** A branch is worth planning only if something fits in it. */
export function isViableBranch(budgetMinutes: number): boolean {
  return budgetMinutes >= MIN_BRANCH_MINUTES;
}

/** One person's answer, as the ballot has it (§6.1). */
export interface SplitVote {
  voter: string;
  voterName?: string;
  osmRef: string;
  value: "want" | "meh" | "rather-not";
  heart?: boolean;
}

export interface SplitSide {
  osmRef: string;
  name: string | null;
  /** The people who asked for this one. */
  voters: string[];
  voterNames: string[];
}

export interface SplitSuggestion {
  a: SplitSide;
  b: SplitSide;
  /** The sentence §6.5 asks for, ready to show. */
  sentence: string;
}

export interface SplitCandidate {
  osmRef: string;
  name: string | null;
}

/**
 * Do the votes pull the group apart, and around which two spots?
 *
 * Looks for the pair whose supporters are **disjoint** — nobody wants
 * both — and takes the pair that divides the most people. Disjoint
 * rather than merely different, because a split is only worth
 * proposing when nobody has to give something up by going either way;
 * where the sets overlap, the ordinary ranking already has an answer
 * and separating would be machinery for its own sake.
 *
 * Returns null when the group agrees, which is most of the time, and
 * saying nothing then is the whole difference between a suggestion and
 * a nag (§6.4's rule about speaking up).
 */
export function suggestSplit(
  votes: readonly SplitVote[],
  candidates: readonly SplitCandidate[],
  meetingLabel?: string | null,
): SplitSuggestion | null {
  const wants = new Map<string, SplitVote[]>();
  for (const vote of votes) {
    if (vote.value !== "want" && !vote.heart) continue;
    const list = wants.get(vote.osmRef) ?? [];
    list.push(vote);
    wants.set(vote.osmRef, list);
  }
  if (wants.size < 2) return null;

  const nameOf = new Map(candidates.map((c) => [c.osmRef, c.name]));
  let best: { a: SplitSide; b: SplitSide; divided: number } | null = null;

  const refs = [...wants.keys()];
  for (let i = 0; i < refs.length; i += 1) {
    for (let j = i + 1; j < refs.length; j += 1) {
      const left = wants.get(refs[i])!;
      const right = wants.get(refs[j])!;
      const leftVoters = new Set(left.map((v) => v.voter));
      if (right.some((v) => leftVoters.has(v.voter))) continue;

      const divided = left.length + right.length;
      if (best !== null && divided <= best.divided) continue;
      best = {
        divided,
        a: side(refs[i], left, nameOf),
        b: side(refs[j], right, nameOf),
      };
    }
  }
  if (best === null) return null;

  const where = meetingLabel?.trim() ? ` am ${meetingLabel.trim()}` : "";
  return {
    a: best.a,
    b: best.b,
    sentence: `${label(best.a)} und ${label(best.b)} spalten die Gruppe. Ihr könntet euch `
      + `trennen und euch später${where} wieder treffen — dann bekommt jede Seite ihren `
      + "Wunsch, statt beides halb zu machen.",
  };
}

function side(
  osmRef: string,
  votes: readonly SplitVote[],
  nameOf: ReadonlyMap<string, string | null>,
): SplitSide {
  return {
    osmRef,
    name: nameOf.get(osmRef) ?? null,
    voters: votes.map((v) => v.voter),
    voterNames: votes.map((v) => v.voterName ?? "jemand"),
  };
}

function label(sideOf: SplitSide): string {
  const who = sideOf.voterNames.join(" und ");
  return `„${sideOf.name ?? sideOf.osmRef}" (${who})`;
}
