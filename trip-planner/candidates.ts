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
    if (interests.has(category)) {
      score += 2;
      reasons.push("passt zu euren Interessen");
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
