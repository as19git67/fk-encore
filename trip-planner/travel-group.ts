/**
 * Who is actually coming, and what that does to a day (§3.5).
 *
 * "Wir" is not generic. Two children under ten make a different day
 * from two adults — shorter blocks, breaks, not three museums in a row
 * — and the planner has always been able to act on that: `blocks.ts`
 * shrinks every block's budget for `withChildren` and again for
 * `limitedMobility`, and the packing list reads the same two flags.
 * What was missing is where those flags come from. Until now they came
 * out of a sentence somebody typed, which means they were right on the
 * first trip and stale on the next one — a child who was eight when the
 * trip was described is eleven two years later, and nothing noticed.
 *
 * This module derives them from the people instead. The household is
 * already in the house as `user_subject_persons` (relationship and, for
 * most, a birth date), so the group is a list of real people and the
 * flags are a conclusion drawn from them, freshly, for the date the
 * trip actually starts.
 *
 * Two decisions worth stating, because they pull in opposite
 * directions:
 *
 *   - **Age is derived, and only for children.** How long a small child
 *     lasts before a break is a fact about small children, and reading
 *     it off a birth date is what dates are for.
 *   - **"Kürzere Wege" is never derived.** Not from an age, not from a
 *     relationship. That is a statement about a person, and it belongs
 *     to whoever it is about — a seventy-year-old who walks fifteen
 *     kilometres would rightly be insulted by an app that quietly
 *     halved their day. So the flag exists on the traveller and is set
 *     by hand, and §3.5's "Großeltern dabei" is a prompt to ask, not a
 *     licence to assume.
 *
 * Pure: people and a date in, flags and reasons out. Everything is
 * explained in words, because a day that got shorter without saying why
 * reads as a bug (§3.8).
 */

/** Under this many years, a traveller counts as a child (§3.5). */
export const CHILD_UNDER_YEARS = 10;

export interface Traveller {
  /** What the trip calls them. Never shown to anybody but the trip. */
  label: string;
  /** ISO birth date, when one is known. */
  birthDate?: string | null;
  /**
   * Set by a person, never inferred: this traveller needs shorter
   * distances and gentler ground.
   */
  shortWalks?: boolean;
}

export interface DerivedGroup {
  /** What `blocks.ts` and `packing.ts` read. */
  withChildren?: boolean;
  limitedMobility?: boolean;
}

export interface GroupReading {
  group: DerivedGroup;
  /** Why, in words somebody can argue with (§3.8). */
  reasons: string[];
  /** How many are coming, including the ones without a birth date. */
  count: number;
}

/**
 * The age somebody has on `date`, in whole years, or null when the
 * birth date is missing or unreadable.
 *
 * Date-only arithmetic on purpose: a birthday is a day, not an instant,
 * and putting a clock anywhere near it makes the answer depend on which
 * side of midnight the server stands.
 */
export function ageOn(birthDate: string | null | undefined, date: string): number | null {
  const born = parts(birthDate);
  const on = parts(date);
  if (!born || !on) return null;
  let years = on.y - born.y;
  if (on.m < born.m || (on.m === born.m && on.d < born.d)) years -= 1;
  return years < 0 || years > 130 ? null : years;
}

/**
 * The travel group as the planner should treat it on `date`.
 *
 * `date` is the trip's own start, not today: a trip planned in January
 * for August is a trip with a child who has had a birthday by then, and
 * planning it against today's age plans the wrong day.
 */
export function readGroup(
  travellers: readonly Traveller[],
  date: string | null,
): GroupReading {
  const reasons: string[] = [];
  const group: DerivedGroup = {};

  const children = date === null
    ? []
    : travellers.filter((t) => {
      const age = ageOn(t.birthDate, date);
      return age !== null && age < CHILD_UNDER_YEARS;
    });
  if (children.length > 0) {
    group.withChildren = true;
    const named = children.map((c) => c.label).join(", ");
    reasons.push(children.length === 1
      ? `${named} ist bei Reisebeginn unter ${CHILD_UNDER_YEARS} — kürzere Blöcke und Pausen.`
      : `${named} sind bei Reisebeginn unter ${CHILD_UNDER_YEARS} — kürzere Blöcke und Pausen.`);
  }

  const shorter = travellers.filter((t) => t.shortWalks === true);
  if (shorter.length > 0) {
    group.limitedMobility = true;
    reasons.push(`Für ${shorter.map((t) => t.label).join(", ")} ist „kürzere Wege" `
      + "eingetragen — Gehstrecke und Steigung zählen als harte Grenze, nicht als Hinweis.");
  }

  // Said out loud rather than left blank: a trip with people on it and
  // no birth dates looks exactly like a trip nobody filled in, and only
  // one of the two is worth doing something about.
  if (date !== null && travellers.length > 0 && children.length === 0 && shorter.length === 0) {
    const unknown = travellers.filter((t) => ageOn(t.birthDate, date) === null);
    reasons.push(unknown.length === travellers.length && unknown.length > 0
      ? "Von niemandem ist ein Geburtsdatum hinterlegt — die Tage werden geplant, als "
        + "wären alle erwachsen und gut zu Fuß."
      : "Aus dieser Reisegruppe ergibt sich nichts, was die Tage kürzer machen müsste.");
  }
  if (date === null && travellers.length > 0) {
    reasons.push("Ohne Reisedatum lässt sich kein Alter ausrechnen — trag ein Datum ein, "
      + "dann rechnet die Gruppe mit.");
  }

  return { group, reasons, count: travellers.length };
}

/**
 * The trip's constraints with the derived group written into them.
 *
 * Kept as a merge rather than a replacement because `constraints` is
 * the whole of what a trip was asked for — pace, interests, modes — and
 * the group is one key of it. An absent flag is removed rather than
 * written as `false`: `constraints.ts` treats only `true` as meaningful
 * (an absent field means "nothing was said"), and a stored `false`
 * would be a statement nobody made.
 */
export function withGroup(
  constraints: Record<string, unknown>,
  group: DerivedGroup,
): Record<string, unknown> {
  const next = { ...constraints };
  const flags: Record<string, boolean> = {};
  if (group.withChildren) flags.withChildren = true;
  if (group.limitedMobility) flags.limitedMobility = true;
  if (Object.keys(flags).length === 0) delete next.group;
  else next.group = flags;
  return next;
}

function parts(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
