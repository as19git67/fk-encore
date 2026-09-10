/**
 * The pool is shared, the rating is personal (§6.1).
 *
 * This is the chapter's most important sentence and the whole reason
 * this module is not three lines: **the mean is the wrong
 * aggregation.** An average picks what everybody finds mediocre and
 * deletes what one person cares a great deal about and the others do
 * not care about at all. The result is a trip nobody loved.
 *
 * So the tally has three parts, and each answers a different failure:
 *
 *   - **A sum, not an average.** Two "will ich" beat one, and a spot
 *     nobody wants does not float up because nobody objected either.
 *   - **Heart wishes with a quota.** A small fixed number of settings
 *     per person per leg. A spot marked that way goes into the plan as
 *     long as it is physically possible, whatever the majority thinks —
 *     that is exactly the preference an average grinds down.
 *   - **A fairness account.** For everything else the sum decides, but
 *     when it is level the person who last had to give way wins. A
 *     counter, not a procedure, and it can be said out loud: "heute ist
 *     mal wieder X dran."
 *
 * A "lieber nicht" is a strong minus and **not a veto**. A real
 * exclusion ("keine Höhenwege") is not a vote at all; it is that
 * person's constraint and works on the solver, not on the ranking
 * (§3.5, §6.1).
 *
 * Pure: votes and candidates in, adjusted candidates and sentences out.
 * No database, no clock, no user ids — a voter is a string key, which
 * is what lets a small child's proxy voice (§6.1) count exactly like an
 * account without this module knowing the difference.
 */

export type VoteValue = "want" | "meh" | "rather-not";

/**
 * What each answer is worth.
 *
 * "Lieber nicht" outweighs a "will ich" on purpose: on a shared day,
 * somebody's reluctance costs more than somebody else's mild
 * enthusiasm. It still does not veto — three people who want it carry
 * it past one who does not.
 */
export const VOTE_WEIGHT: Readonly<Record<VoteValue, number>> = {
  want: 2,
  meh: 0,
  "rather-not": -3,
};

/**
 * What a heart wish is worth. Large enough that it outranks any
 * plausible sum of ordinary votes, finite so the solver still has to
 * fit it into a real day: §6.1 says "solange er physisch möglich ist",
 * not "always".
 */
export const HEART_WEIGHT = 25;

/**
 * The nudge the fairness account gives. Deliberately small — it decides
 * ties and nothing else. Made bigger it would stop being a tie-break
 * and start being a second opinion.
 */
export const FAIRNESS_NUDGE = 0.5;

/** "Etwa zwei je drei Tage" (§6.1), and never fewer than one. */
export function heartQuota(days: number): number {
  if (days <= 0) return 0;
  return Math.max(1, Math.round((days * 2) / 3));
}

export interface Vote {
  /** Whose voice this is. An account or a proxy — see the file header. */
  voter: string;
  /** What they are called, for the sentence that explains a ranking. */
  voterName?: string;
  osmRef: string;
  value: VoteValue;
  /** One of this voter's settings for the leg (§6.1). */
  heart?: boolean;
}

export interface VoteAdjustment {
  /** Added to the candidate's score. */
  delta: number;
  /** Why, in words, for "warum hier?" (§3.8, §8.3). */
  reasons: string[];
  /** True when somebody spent one of their settings on it. */
  hearted: boolean;
}

/**
 * How much each voter has had their way so far.
 *
 * `granted` counts the wishes that made it onto a day, `deferred` the
 * ones still waiting in the pool. The difference is the whole account:
 * whoever is furthest behind gets the tie-break next time.
 *
 * Derived from the plan rather than kept as a second table on purpose —
 * a stored counter and a stored plan are two copies of one fact, and
 * the copy that drifts is always the one nobody looks at.
 */
export interface FairnessRow {
  voter: string;
  voterName?: string;
  granted: number;
  deferred: number;
}

/** Positive means this person has been giving way. */
export function behindness(row: FairnessRow): number {
  return row.deferred - row.granted;
}

export interface Tally {
  /** Adjustment per OSM reference. */
  byRef: Map<string, VoteAdjustment>;
}

/**
 * Fold the votes into one adjustment per spot.
 *
 * Everything a caller needs to rank with, and nothing about *how* to
 * rank: the caller adds `delta` to whatever score the candidate already
 * had, so what the search found and what the family said stay
 * distinguishable in the reasons.
 */
export function tally(
  votes: readonly Vote[],
  fairness: readonly FairnessRow[] = [],
): Tally {
  const behind = new Map(fairness.map((row) => [row.voter, behindness(row)]));
  const mostBehind = Math.max(0, ...behind.values());

  const byRef = new Map<string, VoteAdjustment>();
  for (const vote of votes) {
    const entry = byRef.get(vote.osmRef) ?? { delta: 0, reasons: [], hearted: false };
    const who = vote.voterName ?? "jemand";

    if (vote.heart) {
      entry.delta += HEART_WEIGHT;
      entry.hearted = true;
      entry.reasons.push(`Herzenswunsch von ${who}`);
    } else {
      entry.delta += VOTE_WEIGHT[vote.value];
      if (vote.value === "want") entry.reasons.push(`${who}: will ich`);
      if (vote.value === "rather-not") entry.reasons.push(`${who}: lieber nicht`);
    }

    // The tie-break, and only for the person who is actually furthest
    // behind: a nudge everybody gets is not a nudge.
    if ((vote.value === "want" || vote.heart)
      && mostBehind > 0
      && (behind.get(vote.voter) ?? 0) === mostBehind) {
      entry.delta += FAIRNESS_NUDGE;
      entry.reasons.push(`heute ist mal wieder ${who} dran`);
    }

    byRef.set(vote.osmRef, entry);
  }
  return { byRef };
}

export interface RankableCandidate {
  osmRef: string;
  score: number;
  reasons: string[];
}

/**
 * The candidates as the family rated them.
 *
 * A spot nobody voted on is returned untouched — not demoted. Silence
 * is not rejection, and a pool where only the discussed spots survive
 * would shrink to whatever was talked about on the sofa.
 */
export function applyVotes<T extends RankableCandidate>(
  candidates: readonly T[],
  tallied: Tally,
): T[] {
  return candidates.map((candidate) => {
    const adjustment = tallied.byRef.get(candidate.osmRef);
    if (!adjustment) return candidate;
    return {
      ...candidate,
      score: candidate.score + adjustment.delta,
      reasons: [...candidate.reasons, ...adjustment.reasons],
    };
  });
}

/**
 * The fairness account from what was planned and what was not.
 *
 * `planned` is every OSM reference that ended up on a day. A wish that
 * is neither planned nor in the pool any more — a spot somebody hid, a
 * leg that was dropped — counts as neither: the account is about who
 * gave way, and a spot that left the trip did not make anybody give
 * way in the other's favour.
 */
export function fairnessFrom(
  votes: readonly Vote[],
  planned: ReadonlySet<string>,
  stillOffered: ReadonlySet<string>,
): FairnessRow[] {
  const rows = new Map<string, FairnessRow>();
  for (const vote of votes) {
    if (vote.value !== "want" && !vote.heart) continue;
    const row = rows.get(vote.voter)
      ?? { voter: vote.voter, voterName: vote.voterName, granted: 0, deferred: 0 };
    if (planned.has(vote.osmRef)) row.granted += 1;
    else if (stillOffered.has(vote.osmRef)) row.deferred += 1;
    rows.set(vote.voter, row);
  }
  return [...rows.values()].sort((a, b) => behindness(b) - behindness(a));
}

/**
 * The account in one sentence, or null when there is nothing to say.
 *
 * §6.1 wants this explainable, and a table of counters is not an
 * explanation. Nobody behind means nobody is owed anything, and saying
 * so beats showing zeroes.
 */
export function fairnessSentence(rows: readonly FairnessRow[]): string | null {
  if (rows.length === 0) return null;
  const behind = rows.filter((row) => behindness(row) > 0);
  if (behind.length === 0) {
    return "Bisher ist niemand zu kurz gekommen.";
  }
  const names = behind.map((row) => row.voterName ?? "jemand");
  return names.length === 1
    ? `${names[0]} musste bisher am ehesten zurückstecken — bei Gleichstand geht es vor.`
    : `${names.join(" und ")} mussten bisher am ehesten zurückstecken — bei Gleichstand `
      + "gehen sie vor.";
}
