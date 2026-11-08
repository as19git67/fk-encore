/**
 * How much an idea matters (ideas plan, stage 3): Muss, Will, Wenn Zeit.
 *
 * Said by the travellers, never guessed. It moves the idea's score
 * within the band of what people brought (`MANUAL_SCORE`), so a "Muss"
 * sorts above a "Will" and a "Wenn Zeit" below it, and it says which
 * ideas go first when a day is too full (stage 4).
 */

export type IdeaPriority = "must" | "want" | "maybe";

export const DEFAULT_PRIORITY: IdeaPriority = "want";

/** What the priority adds to the score. Less than a heart wish, more than any search. */
export const PRIORITY_POINTS: Readonly<Record<IdeaPriority, number>> = {
  must: 2,
  want: 0,
  maybe: -2,
};

export const PRIORITY_LABEL: Readonly<Record<IdeaPriority, string>> = {
  must: "Muss",
  want: "Will",
  maybe: "Wenn Zeit",
};

export function isPriority(value: unknown): value is IdeaPriority {
  return value === "must" || value === "want" || value === "maybe";
}

/** A stored value, read back; anything unknown is the default. */
export function priorityOf(value: unknown): IdeaPriority {
  return isPriority(value) ? value : DEFAULT_PRIORITY;
}

/** The score after a change of priority: the old points out, the new ones in. */
export function rescored(score: number, from: IdeaPriority, to: IdeaPriority): number {
  return score - PRIORITY_POINTS[from] + PRIORITY_POINTS[to];
}
