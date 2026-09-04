/**
 * Turning what the model said into constraints the planner may act on.
 *
 * Step 5 of docs/ios-urlaubsplanung.md §13. The division of labour the
 * concept insists on (§11.6) is "the model understands and phrases, the
 * algorithm plans" — so the language model's only job here is to read a
 * sentence and propose values. It never reaches the solver directly.
 *
 * This module is the gate in between, and it is deliberately
 * suspicious: an LLM will cheerfully invent a category that does not
 * exist, ask for a 400 km radius, or plan 90 days. Every field is
 * checked against the same bounds the typed endpoints enforce, unknown
 * values are dropped rather than passed on, and what was dropped is
 * reported instead of silently swallowed — a plan that quietly ignored
 * half the sentence is worse than one that says what it could not use.
 *
 * Pure on purpose: no clock, no network, no database. The category
 * vocabulary is passed in (it lives in geo/src/poi-categories.ts) so it
 * stays single-sourced rather than duplicated here.
 */

import type { GroupProfile, Pace } from "./blocks";

/** Bounds mirror the typed endpoints in plan.ts / plans.ts. */
export const MAX_DAYS = 14;
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 20_000;
export const MAX_WALK_MINUTES_LIMIT = 180;
/** More interests than this is the model padding, not the traveller. */
export const MAX_INTERESTS = 12;

const PACES: readonly Pace[] = ["relaxed", "normal", "packed"];

export interface NlConstraints {
  /** A name for the plan, if the sentence suggested one. */
  title?: string;
  /**
   * The place the sentence named ("Augsburg"). Not coordinates — this
   * service has no forward geocoder, so the caller supplies the anchor
   * and this is only an echo for the UI to confirm against.
   */
  placeHint?: string;
  days?: number;
  radiusM?: number;
  categories?: string[];
  interests?: string[];
  pace?: Pace;
  group?: GroupProfile;
  maxWalkMinutes?: number;
}

export interface NormalizedConstraints {
  constraints: NlConstraints;
  /**
   * What the model proposed that could not be used, in plain words.
   * Shown to the traveller so a misread sentence is visible rather than
   * silently reducing the plan.
   */
  rejected: string[];
}

/**
 * Validate and clamp a raw object from the language model.
 *
 * `knownCategories` is the vocabulary geo accepts; anything outside it
 * is rejected, because passing it on would only produce a 400 from the
 * area search later, with a worse error message.
 */
export function normalizeConstraints(
  raw: unknown,
  knownCategories: readonly string[],
): NormalizedConstraints {
  const rejected: string[] = [];
  const constraints: NlConstraints = {};

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { constraints, rejected: ["the model did not return an object"] };
  }
  const r = raw as Record<string, unknown>;

  const title = trimmedString(r.title);
  if (title) constraints.title = title.slice(0, 200);

  const place = trimmedString(r.placeHint ?? r.place);
  if (place) constraints.placeHint = place.slice(0, 200);

  const days = wholeNumber(r.days);
  if (days !== undefined) {
    if (days < 1) {
      rejected.push(`days: ${days} is not a number of days`);
    } else if (days > MAX_DAYS) {
      constraints.days = MAX_DAYS;
      rejected.push(`days: ${days} exceeds the ${MAX_DAYS}-day limit, using ${MAX_DAYS}`);
    } else {
      constraints.days = days;
    }
  }

  const radius = finiteNumber(r.radiusM);
  if (radius !== undefined) {
    if (radius < MIN_RADIUS_M) {
      rejected.push(`radiusM: ${radius} m is too small to hold a day`);
    } else if (radius > MAX_RADIUS_M) {
      constraints.radiusM = MAX_RADIUS_M;
      rejected.push(
        `radiusM: ${radius} m exceeds the ${MAX_RADIUS_M} m limit, using ${MAX_RADIUS_M}`,
      );
    } else {
      constraints.radiusM = Math.round(radius);
    }
  }

  const walk = finiteNumber(r.maxWalkMinutes);
  if (walk !== undefined) {
    if (walk <= 0) {
      rejected.push(`maxWalkMinutes: ${walk} leaves no walking at all`);
    } else if (walk > MAX_WALK_MINUTES_LIMIT) {
      constraints.maxWalkMinutes = MAX_WALK_MINUTES_LIMIT;
      rejected.push(
        `maxWalkMinutes: ${walk} exceeds ${MAX_WALK_MINUTES_LIMIT}, using ${MAX_WALK_MINUTES_LIMIT}`,
      );
    } else {
      constraints.maxWalkMinutes = Math.round(walk);
    }
  }

  const pace = trimmedString(r.pace)?.toLowerCase();
  if (pace !== undefined) {
    if ((PACES as readonly string[]).includes(pace)) {
      constraints.pace = pace as Pace;
    } else {
      rejected.push(`pace: '${pace}' is not one of ${PACES.join(", ")}`);
    }
  }

  const known = new Set(knownCategories);
  const categories = stringArray(r.categories);
  if (categories !== undefined) {
    const kept = categories.filter((c) => known.has(c));
    const unknown = categories.filter((c) => !known.has(c));
    for (const c of unknown) rejected.push(`category: '${c}' does not exist`);
    if (kept.length > 0) constraints.categories = dedupe(kept);
  }

  const interests = stringArray(r.interests);
  if (interests !== undefined) {
    const kept = dedupe(interests).slice(0, MAX_INTERESTS);
    if (interests.length > MAX_INTERESTS) {
      rejected.push(`interests: kept the first ${MAX_INTERESTS} of ${interests.length}`);
    }
    if (kept.length > 0) constraints.interests = kept;
  }

  const group = normalizeGroup(r.group, rejected);
  if (group) constraints.group = group;

  return { constraints, rejected };
}

function normalizeGroup(raw: unknown, rejected: string[]): GroupProfile | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    rejected.push("group: not an object");
    return undefined;
  }
  const g = raw as Record<string, unknown>;
  const group: GroupProfile = {};
  // Only true is meaningful: `withChildren: false` and an absent field
  // shape the day identically (blocks.ts), so there is nothing to store.
  if (g.withChildren === true) group.withChildren = true;
  if (g.limitedMobility === true) group.limitedMobility = true;
  return group.withChildren || group.limitedMobility ? group : undefined;
}

function trimmedString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function finiteNumber(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

function wholeNumber(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n === undefined) return undefined;
  return Math.round(n);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const entry of v) {
    const s = trimmedString(entry);
    if (s) out.push(s.toLowerCase());
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
