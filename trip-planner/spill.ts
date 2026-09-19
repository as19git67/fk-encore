/**
 * When a stop runs past the end of its block (§4.7).
 *
 * A four-hour walk fits in no Vormittag. The concept left the question
 * open and named the uncomfortable answer: should the planner merge two
 * blocks into one when a candidate does not fit either? That would make
 * a candidate rewrite the shape of the day — the one thing the day's
 * blocks are there to hold still.
 *
 * The answer here is the other one. **A block budget is not a wall, it
 * is where the block was meant to end.** A stop may run past it; what
 * follows then starts late, and the plan says so. Nothing about the
 * day's shape changes: the Vormittag is still the Vormittag, lunch is
 * still lunch — it just begins at half past one, and the afternoon has
 * less in it. That is what actually happens when you walk the Ponale,
 * and it is the sentence the traveller can check against the day.
 *
 * Who may do it matters:
 *
 *   - **The planner does not.** `solveDay` fills every block inside its
 *     budget, as it always has. The machine keeps to the frame it was
 *     given; a spot that fits nowhere stays in the pool.
 *   - **A person may.** Placing or moving a stop has never refused an
 *     overfull block (`move.ts`) — "the traveller put it there
 *     deliberately, and a red block says more than a rejected gesture".
 *     Until now those minutes then vanished: the afternoon was planned
 *     as though the morning had ended on time. Now they are carried.
 *
 * Pure arithmetic: minutes in, minutes out. No clock — a block knows
 * how long it is, not when it starts, and that is enough to say how far
 * the day has slipped.
 */

/** What the arithmetic needs of a block, and no more. */
export interface SpillBlock {
  /** Where the block was meant to end, in minutes. */
  budgetMinutes: number;
  /** Travel plus dwell actually in it, in minutes. */
  usedMinutes: number;
}

export interface BlockSpill {
  /**
   * Minutes of an earlier block's overrun that land in this one — how
   * much later it begins than the day's shape says.
   */
  carriedInMinutes: number;
  /** Minutes this block runs past its own end, carried to the next. */
  overrunMinutes: number;
}

export interface DaySpill {
  /** One entry per block, in the day's order. */
  blocks: BlockSpill[];
  /**
   * Minutes that run past the end of the last block: time the day does
   * not have. Zero for every day that adds up — which is every day
   * nobody deliberately overfilled.
   */
  beyondDayMinutes: number;
}

/**
 * How far each block slips, and whether the day still holds.
 *
 * A block that begins `c` minutes late and holds `u` minutes of
 * programme ends `c + u` minutes after its own start, so it runs over
 * by `c + u - budget` whenever that is positive. The next block
 * inherits exactly that.
 *
 * A block with nothing in it absorbs rather than passes on: an hour of
 * lunch swallows a forty-minute overrun and the afternoon starts on
 * time, which is the whole reason a day has a lunch block in it.
 */
export function spillOver(blocks: readonly SpillBlock[]): DaySpill {
  const spills: BlockSpill[] = [];
  let carried = 0;

  for (const block of blocks) {
    const overrun = Math.max(0, carried + block.usedMinutes - block.budgetMinutes);
    spills.push({ carriedInMinutes: carried, overrunMinutes: overrun });
    carried = overrun;
  }

  return { blocks: spills, beyondDayMinutes: carried };
}

/**
 * What is left of a block once an earlier overrun has eaten into it.
 *
 * Never negative: a block swallowed whole by the block before it has no
 * room, not negative room.
 */
export function roomInBlock(budgetMinutes: number, carriedInMinutes: number): number {
  return Math.max(0, budgetMinutes - carriedInMinutes);
}

/**
 * Is this stop longer than any single block of the day can hold?
 *
 * The question the pool needs answered about a route (§4.7): a
 * four-hour walk in a day of three-and-a-half-hour blocks will never be
 * chosen by the planner, and the honest thing is to say why rather than
 * let it sit there looking passed over. Only blocks that take spots are
 * asked — a meal block holds time, not places (§10.3).
 */
export function needsMoreThanOneBlock(
  stopMinutes: number,
  blocks: readonly { kind: string; budgetMinutes: number }[],
): boolean {
  const holders = blocks.filter((block) => block.kind === "spots");
  if (holders.length === 0) return false;
  return holders.every((block) => block.budgetMinutes < stopMinutes);
}
