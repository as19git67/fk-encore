/**
 * The day as an ordered list of blocks.
 *
 * Per the concept's decision (§4.1, §15.2) the four-part day is a
 * *default*, not an enumeration: a block is a label plus a budget, and
 * a day holds an ordered list of them. Callers may pass their own list
 * — an arrival day with no morning, a day trip framed by two trains —
 * without the planner needing a new block type.
 */

export type Pace = "relaxed" | "normal" | "packed";

/** What a block is for. Meal blocks hold time, not spots (§10.3). */
export type BlockKind = "spots" | "meal";

export interface BlockTemplate {
  id: string;
  label: string;
  kind: BlockKind;
  /** Budget before pace and group scaling, in minutes. */
  baseBudgetMinutes: number;
}

export const DEFAULT_DAY: readonly BlockTemplate[] = [
  { id: "morning", label: "Vormittag", kind: "spots", baseBudgetMinutes: 210 },
  { id: "midday", label: "Mittag", kind: "meal", baseBudgetMinutes: 90 },
  { id: "afternoon", label: "Nachmittag", kind: "spots", baseBudgetMinutes: 210 },
  { id: "evening", label: "Abend", kind: "spots", baseBudgetMinutes: 120 },
] as const;

const PACE_FACTOR: Record<Pace, number> = {
  relaxed: 0.75,
  normal: 1,
  packed: 1.25,
};

/**
 * Who is coming along changes how much fits into a block — the concept
 * treats this as a hard constraint rather than a hint (§3.5).
 */
export interface GroupProfile {
  /** Small children: shorter stretches, more pauses. */
  withChildren?: boolean;
  /** Someone whose walking distance is limited. */
  limitedMobility?: boolean;
  /**
   * Somebody comes on wheels — a wheelchair, a rollator, a pram (§3.5).
   *
   * Unlike the two above this changes no budget. It is the one thing
   * about a group that a *route* has to respect rather than shorten:
   * a way that climbs is not a slower day out, it is not a day out
   * (§4.7).
   */
  onWheels?: boolean;
}

export function groupFactor(group: GroupProfile | undefined): number {
  let factor = 1;
  if (group?.withChildren) factor *= 0.8;
  if (group?.limitedMobility) factor *= 0.7;
  return factor;
}

/**
 * How much longer this group takes over the same ground (§4.7).
 *
 * The walkers' formula behind a route's duration assumes an adult
 * hiker — four kilometres an hour along, three hundred metres of climb
 * an hour up (`route-duration.ts`). A group with a small child in it,
 * or with somebody for whom "mehr Zeit einplanen" is set, does not walk
 * that, and a route timed as though it did is the one number in the day
 * that cannot be absorbed by a shorter block: the walk takes what it
 * takes, and the afternoon behind it is wrong.
 *
 * **Not a product, unlike `groupFactor`.** Two reasons to be slower do
 * not make a group slower still — the pace is the slowest walker's, and
 * they are only one person. The budget factor above compounds because
 * it is about how much programme a day carries, which two reasons
 * genuinely do reduce twice.
 */
export function groupPaceFactor(group: GroupProfile | undefined): number {
  return group?.withChildren || group?.limitedMobility ? SLOWER_WALKING : 1;
}

/**
 * Three kilometres an hour rather than four, which is what a group
 * walking with a five-year-old actually covers.
 */
const SLOWER_WALKING = 1.4;

export interface PlannedBlockShape extends BlockTemplate {
  /** Budget after pace and group scaling. */
  budgetMinutes: number;
}

export function shapeDay(
  templates: readonly BlockTemplate[] = DEFAULT_DAY,
  pace: Pace = "normal",
  group?: GroupProfile,
): PlannedBlockShape[] {
  const factor = PACE_FACTOR[pace] * groupFactor(group);
  return templates.map((t) => ({
    ...t,
    budgetMinutes: Math.max(0, Math.round(t.baseBudgetMinutes * factor)),
  }));
}
