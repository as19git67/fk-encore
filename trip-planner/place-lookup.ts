/**
 * Names to places, across the legs of a trip (§9.3, stage 4).
 *
 * The I/O half of `resolve-place.ts`: pick the region, ask geo for the
 * candidates, hand them to the pure resolver. Kept apart from it so the
 * judgement — unique, ambiguous, or nothing — can be tested
 * exhaustively without a database.
 *
 * Every leg is searched, not just the one on screen. An article about
 * Lisbon read while standing in Porto has to resolve in the Lisbon leg,
 * which is the same rule §9.2 states for where a find belongs; here it
 * falls out of searching them all and letting the name decide. A name
 * that matches in two legs is ambiguous, and the traveller is asked,
 * because picking the nearer one would silently plan the wrong week.
 */

import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resolvePlace, type PlaceCandidate, type PlaceResolution } from "./resolve-place";

/**
 * How far around a leg's anchor to look for a name.
 *
 * Wider than the planning radius on purpose: an article about a city
 * names places across the whole of it and the odd castle an hour out,
 * while the planning radius is about what fits in a day on foot. Geo
 * caps a radius search at 50 km, and this stays inside that.
 */
export const RESOLUTION_RADIUS_M = 30_000;

/** Enough to see that a name is ambiguous without paging a whole city. */
const CANDIDATES_PER_LEG = 40;

export interface LookupLeg {
  position: number;
  regionDb: string;
  anchor: { lat: number; lon: number };
}

/** A candidate, plus which leg it turned up in. */
export interface LocatedCandidate extends PlaceCandidate {
  legIndex: number;
}

export interface PlaceLookup extends PlaceResolution {
  match: LocatedCandidate | null;
  options: LocatedCandidate[];
  /** The leg the match sits in. Null unless the verdict is "unique". */
  legIndex: number | null;
  /**
   * True when geo could not be asked at all. The verdict is then "none"
   * for want of candidates, and that is a different thing from "this
   * place is not in OpenStreetMap" — the caller says so rather than
   * telling the traveller their café does not exist.
   */
  searchFailed: boolean;
}

/**
 * Resolve one name against every leg of a trip.
 */
export async function lookupPlace(
  name: string,
  legs: readonly LookupLeg[],
): Promise<PlaceLookup> {
  const candidates: LocatedCandidate[] = [];
  let anySearchRan = false;

  // Legs sharing a region are searched once: a five-day trip within one
  // city is several legs over the same database, and asking it the same
  // question five times would answer it five times.
  const seenRegions = new Map<string, number>();
  for (const leg of legs) {
    const key = `${leg.regionDb}:${leg.anchor.lat.toFixed(3)}:${leg.anchor.lon.toFixed(3)}`;
    if (seenRegions.has(key)) continue;
    seenRegions.set(key, leg.position);

    let spots: GeoPoiSearchSpot[];
    try {
      const page = await getGeoClient().searchPois(leg.regionDb, {
        center: { ...leg.anchor, radiusM: RESOLUTION_RADIUS_M },
        name,
        limit: CANDIDATES_PER_LEG,
      });
      spots = page.spots;
      anySearchRan = true;
    } catch {
      // One region being unavailable must not lose the others.
      continue;
    }
    for (const spot of spots) {
      candidates.push({ ...toCandidate(spot), legIndex: leg.position });
    }
  }

  const resolution = resolvePlace(name, candidates);
  return {
    verdict: resolution.verdict,
    match: (resolution.match as LocatedCandidate | null) ?? null,
    options: resolution.options as LocatedCandidate[],
    legIndex: (resolution.match as LocatedCandidate | null)?.legIndex ?? null,
    searchFailed: !anySearchRan && legs.length > 0,
  };
}

function toCandidate(spot: GeoPoiSearchSpot): PlaceCandidate {
  return {
    osmRef: spot.osmRef,
    name: spot.name,
    nameDe: spot.nameDe,
    nameEn: spot.nameEn,
    lat: spot.lat,
    lon: spot.lon,
    distanceM: spot.distanceM,
    categories: spot.categories,
  };
}
