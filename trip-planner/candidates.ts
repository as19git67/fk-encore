/**
 * Turning geo search results into scored planner candidates.
 *
 * The scoring here is deliberately thin and explainable. The concept
 * lists the full set of ranking signals — group votes, own photo
 * history, weather, light, opening hours (§12) — but those arrive with
 * later steps and most of them need data this step does not have yet.
 * What is available today is prominence and a stated interest, so that
 * is all this scores, and every contribution is visible in `reasons`
 * rather than hidden in a number.
 */

import { readableName } from "./readable-name";
import { wikipediaUrl } from "./spot-links";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import type { Candidate } from "./solver";
import { matchedInterests } from "./interests";
import { lightWindows } from "./sun";
import type { Coordinate } from "./travel";
import { spotLight } from "./light";

/**
 * How long people typically stay, per category, in minutes. Rough by
 * design — the block budget is coarse too — and overridable per
 * request so a caller can say "we do museums quickly".
 */
export const DEFAULT_DWELL_MINUTES: Readonly<Record<string, number>> = {
  museum: 90,
  sight: 30,
  viewpoint: 20,
  worship: 25,
  theatre: 60,
  // A meal is a block of its own (§10.3); these durations apply when a
  // caller deliberately searches for one, not when the planner fills a
  // block — it never picks a venue.
  food: 60,
  cafe: 30,
  // Needed rather than admired: a stop, not a visit (§10.5).
  essentials: 10,
  outdoors: 45,
  // A zoo is not a stop on the way past, and a bath is not twenty
  // minutes: both take a block on their own. Getting these wrong is how
  // an afternoon acquires three things it cannot fit.
  zoo: 180,
  bath: 120,
  market: 40,
  producers: 60,
};

const FALLBACK_DWELL_MINUTES = 30;

export interface ScoredCandidate extends Candidate {
  /** Human-readable contributions to `score`, for "why here?" (§8.3). */
  reasons: string[];
}

export interface ScoringOptions {
  /**
   * Drop candidates with no sign of being worth a visit.
   *
   * Set when building the pool a day is planned out of. Left off for a
   * lookup — "what is near me" legitimately answers with the ordinary.
   */
  requireProminence?: boolean;
  /** Category ids the travellers said they care about. */
  interests?: readonly string[];
  /** Per-category overrides for the dwell defaults. */
  dwellMinutes?: Readonly<Record<string, number>>;
}

export interface LightScoringOptions {
  /** The day being planned, as YYYY-MM-DD. */
  date: string;
  utcOffsetMinutes?: number;
  /**
   * Where the day happens. The windows are computed once from here
   * rather than per candidate: within a city the difference is
   * seconds, and a solar day is 1441 samples — one per spot per day
   * would be thousands of them for a difference nobody can perceive.
   */
  at?: Coordinate;
}

/**
 * The light's say in the plan — at the spots that asked for it (§7.3).
 *
 * **The route is planned by distance.** That is the rule, and this is
 * its single exception: a spot somebody marked as a *Fotostopp* may
 * be preferred for standing in good light. Nothing else is: an
 * unmarked spot scores exactly what it scored before, however
 * photogenic the sun happens to be that evening.
 *
 * Why per spot rather than per trip: a bonus that applies to
 * everything applies to nothing — it lifts the whole field and
 * changes only the arithmetic. A mark on one place is a statement
 * somebody actually made, and the plan can act on it without
 * pretending to know which buildings anybody came to photograph.
 *
 * Two further narrowings, both kept from the blanket version:
 *
 *   - It needs a **known orientation** — a facade azimuth from the
 *     import. Without one there is nothing to say about how the sun
 *     meets the building, and a bonus would be a guess wearing a
 *     sentence.
 *   - It rewards only a **golden** window that stands square to the
 *     facade or grazes it.
 *
 * And it still does not promise a minute: the in-block ordering and
 * the evening-block suggestion stay back until the horizon profile
 * exists, because a valley is in shadow long before the sun sets. A
 * ranking preference survives that caveat; a time on the plan would
 * not.
 */
export function scoreForLight(
  candidates: readonly ScoredCandidate[],
  options: LightScoringOptions,
): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  const marked = candidates.filter((candidate) => candidate.photoStop === true);
  // Nobody asked the sun anything: the whole calculation is skipped,
  // including the 1441 samples of a solar day.
  if (marked.length === 0) return [...candidates];

  const windows = lightWindows(
    options.at ?? marked[0],
    options.date,
    options.utcOffsetMinutes ?? 0,
  );
  if (windows.length === 0) return [...candidates];

  return candidates.map((candidate) => {
    if (candidate.photoStop !== true) return candidate;
    if (candidate.facadeAzimuth === null || candidate.facadeAzimuth === undefined) return candidate;
    const best = spotLight(candidate, windows, candidate.facadeAzimuth)[0];
    if (!best || best.window.kind !== "golden") return candidate;
    const bonus = best.facade === "frontal" ? 0.75 : best.facade === "raking" ? 0.4 : 0;
    if (bonus === 0) return candidate;
    return {
      ...candidate,
      score: candidate.score + bonus,
      reasons: [
        ...candidate.reasons,
        best.facade === "frontal"
          ? "Fotostopp: steht am Reisetag im goldenen Licht"
          : "Fotostopp: bekommt am Reisetag streifendes goldenes Licht",
      ],
    };
  });
}

export function toCandidates(
  spots: readonly GeoPoiSearchSpot[],
  opts: ScoringOptions = {},
): ScoredCandidate[] {
  const interests = new Set(opts.interests ?? []);
  const candidates: ScoredCandidate[] = [];

  for (const spot of spots) {
    // A spot with no category cannot be reasoned about — dwell time,
    // diversity and interest all key off it. Skip rather than invent one.
    const category = spot.categories[0];
    if (!category) continue;

    const reasons: string[] = [];
    let score = 1;
    // Signals that this is somewhere people go *to*, rather than
    // somewhere that merely exists. A name is not one of them: every
    // savings bank has a name, and counting it as prominence is how an
    // ordinary parish church came to score exactly what a Sparkasse
    // did, and both ended up in a morning.
    let prominence = 0;

    if (spot.wikidataQid) {
      score += 1;
      prominence += 1;
      reasons.push("in Wikidata verzeichnet");
    }
    if (spot.wikipedia) {
      score += 1;
      prominence += 1;
      reasons.push("hat einen Wikipedia-Artikel");
    }
    // Somebody tagged it as a thing to see, which is a judgement a
    // mapper made on the ground.
    if (spot.kind === "tourism=attraction" || spot.kind === "tourism=museum"
        || spot.kind === "tourism=gallery" || spot.kind === "tourism=viewpoint") {
      score += 0.5;
      prominence += 1;
      reasons.push("als Sehenswürdigkeit erfasst");
    }
    if (!spot.name) {
      reasons.push("unbenannt in OpenStreetMap");
    }
    // Against the interest vocabulary rather than the category id: a
    // category is one of nine, an interest is a theme, and comparing
    // the two awarded this to nobody (see interests.ts).
    const hits = matchedInterests({ kind: spot.kind, category }, interests);
    if (hits.length > 0) {
      score += 2;
      // Named, not "passt zu euren Interessen": which of them it
      // answers is the part that makes the suggestion arguable (§8.3).
      reasons.push(`ihr wolltet: ${hits.join(", ")}`);
    }

    // Nothing says this is worth a block. Keep it out of the pool a day
    // is planned from rather than let it pad a morning: a shorter
    // Vormittag is a better answer than a filled one nobody wanted
    // (§15.3 in spirit — do not present what you do not know).
    if (opts.requireProminence && prominence === 0) continue;

    // The name the traveller can read, which in Tokyo or Jerusalem is
    // not the local one (§10.4). Choosing it here rather than in the
    // app keeps the pool, the day and the search saying the same thing
    // about the same place — and the local name comes along, because
    // it is the one written on the building.
    const names = readableName(spot);

    candidates.push({
      osmRef: spot.osmRef,
      name: names.display,
      localName: names.local,
      wikipediaUrl: wikipediaUrl(spot.wikipedia),
      // Which way it faces, for the light hint (§7.3). Computed once
      // at import time; here it is only carried along.
      facadeAzimuth: spot.facadeAzimuth,
      kind: spot.kind,
      lat: spot.lat,
      lon: spot.lon,
      category,
      dwellMinutes: dwellFor(category, opts.dwellMinutes),
      score,
      reasons,
    });
  }

  return candidates;
}

function dwellFor(
  category: string,
  overrides: Readonly<Record<string, number>> | undefined,
): number {
  const override = overrides?.[category];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }
  return DEFAULT_DWELL_MINUTES[category] ?? FALLBACK_DWELL_MINUTES;
}
