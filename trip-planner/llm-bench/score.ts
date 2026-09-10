/**
 * Scoring one reading of a sentence against what the sentence said (§11.0).
 *
 * §11.0 asks for a measurement before the paid track is bought, and a
 * measurement needs a rule for what counts as right. This is that rule,
 * kept pure and separate from the runner so it can be argued with — and
 * tested — without a model in the loop.
 *
 * Three things are counted, and they are deliberately **not** added up
 * into one number:
 *
 *   - **richtig** — the sentence said it and the model read it.
 *   - **verpasst / falsch** — the sentence said it and the model did
 *     not, or read something else.
 *   - **erfunden** — the model produced a field the sentence never
 *     mentioned. §13's rule is "ein fehlendes Feld ist besser als ein
 *     erfundenes", so this is its own column: a track that reads more
 *     *and* invents more has not obviously won.
 *
 * `interests` and `title` are reported but not scored. Both are free
 * text — "barock" and "Barockarchitektur" are the same answer, and a
 * scorer that pretends otherwise measures spelling.
 */

import type { NlConstraints } from "../constraints";

/** The fields a case may state, minus the two free-text ones. */
export const SCORED_FIELDS = [
  "placeHint",
  "days",
  "radiusM",
  "pace",
  "maxWalkMinutes",
  "categories",
  "withChildren",
  "limitedMobility",
] as const;

export type ScoredField = (typeof SCORED_FIELDS)[number];

export type Verdict = "hit" | "missed" | "wrong" | "invented";

export interface FieldResult {
  field: ScoredField;
  verdict: Verdict;
  expected: unknown;
  got: unknown;
}

export interface CaseScore {
  fields: FieldResult[];
  hits: number;
  missed: number;
  wrong: number;
  invented: number;
  /** Categories the model added that the sentence did not ask for. */
  extraCategories: string[];
}

/**
 * What a sentence is expected to yield.
 *
 * Every scored field that is absent here is one the sentence does not
 * state — and producing it is `invented`. That is the whole point of
 * writing the cases this way: the interesting failure of a language
 * model is not the field it misses, it is the field it makes up.
 */
export interface ExpectedConstraints {
  placeHint?: string;
  days?: number;
  radiusM?: number;
  pace?: string;
  maxWalkMinutes?: number;
  /** Expected as a subset: extra categories are reported, not punished. */
  categories?: string[];
  withChildren?: boolean;
  limitedMobility?: boolean;
}

export function scoreCase(
  expected: ExpectedConstraints,
  got: NlConstraints,
): CaseScore {
  const fields: FieldResult[] = [];
  const extraCategories: string[] = [];

  for (const field of SCORED_FIELDS) {
    const want = expected[field];
    const have = valueOf(got, field);
    if (want === undefined) {
      // Not stated by the sentence. Silence is the right answer.
      if (have !== undefined) {
        fields.push({ field, verdict: "invented", expected: undefined, got: have });
      }
      continue;
    }
    if (have === undefined) {
      fields.push({ field, verdict: "missed", expected: want, got: undefined });
      continue;
    }
    if (field === "categories") {
      const wanted = new Set(want as string[]);
      const produced = new Set(have as string[]);
      for (const category of produced) {
        if (!wanted.has(category)) extraCategories.push(category);
      }
      const complete = [...wanted].every((category) => produced.has(category));
      fields.push({
        field,
        verdict: complete ? "hit" : "wrong",
        expected: want,
        got: have,
      });
      continue;
    }
    fields.push({
      field,
      verdict: same(want, have) ? "hit" : "wrong",
      expected: want,
      got: have,
    });
  }

  return {
    fields,
    hits: count(fields, "hit"),
    missed: count(fields, "missed"),
    wrong: count(fields, "wrong"),
    invented: count(fields, "invented"),
    extraCategories,
  };
}

/** The same numbers over a whole run, for the line at the bottom. */
export interface RunTotals {
  cases: number;
  hits: number;
  missed: number;
  wrong: number;
  invented: number;
  /** Of everything the sentences stated, the share that was read correctly. */
  accuracy: number;
  failures: number;
}

export function totalsOf(scores: readonly (CaseScore | null)[]): RunTotals {
  const scored = scores.filter((score): score is CaseScore => score !== null);
  const hits = sum(scored, (s) => s.hits);
  const missed = sum(scored, (s) => s.missed);
  const wrong = sum(scored, (s) => s.wrong);
  const stated = hits + missed + wrong;
  return {
    cases: scores.length,
    hits,
    missed,
    wrong,
    invented: sum(scored, (s) => s.invented),
    // A run where nothing was asked has no accuracy, and reporting 100 %
    // for it would be the most misleading number in the table.
    accuracy: stated === 0 ? 0 : hits / stated,
    failures: scores.length - scored.length,
  };
}

function valueOf(got: NlConstraints, field: ScoredField): unknown {
  switch (field) {
    case "withChildren": return got.group?.withChildren;
    case "limitedMobility": return got.group?.limitedMobility;
    default: return got[field];
  }
}

/**
 * Two values that mean the same thing.
 *
 * Place names are compared case- and space-insensitively: a model that
 * answers "münchen" has read the sentence. Numbers are compared exactly
 * — "vier Tage" is four days, and a scorer that accepts five is not
 * measuring anything.
 */
function same(want: unknown, have: unknown): boolean {
  if (typeof want === "string" && typeof have === "string") {
    return want.trim().toLowerCase() === have.trim().toLowerCase();
  }
  return want === have;
}

function count(fields: readonly FieldResult[], verdict: Verdict): number {
  return fields.filter((field) => field.verdict === verdict).length;
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
