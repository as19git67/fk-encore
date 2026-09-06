/**
 * "Ich hab da was gefunden" — a find into the pool (§9.2).
 *
 * One gesture, and it competes with everything else. The five rules the
 * concept sets out to stop the pool going to seed are each visible in
 * the code below:
 *
 *   1. It lands in the **right leg**, by location. A café in Osaka goes
 *      into the Osaka leg even while you are standing in Tokyo; in none
 *      of them, the endpoint asks rather than guessing.
 *   2. It is a **suggestion, not an appointment** — it goes in the pool
 *      and competes. Nothing here plans it into a day.
 *   3. **Duplicates are merged.** Note, source and contributor move to
 *      the entry that is already there; no second row appears.
 *   4. **Provenance survives.** Why it was saved and where from, plus
 *      who saved it.
 *   5. **Missing data is named, not guessed.** With no OSM entry behind
 *      it there are no opening hours and no category, and the response
 *      says so instead of the planner reckoning with invented values.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan } from "./plan-store";
import { addPoolEntry, mergeIntoPoolEntry, type StoredPoolEntry } from "./find-store";
import { DEFAULT_DWELL_MINUTES } from "./candidates";
import { chooseLeg, findDuplicate, manualRef } from "./finds";

/** How far around a find to look for the OSM entry it might be. */
const MATCH_RADIUS_M = 80;
const MAX_NOTE_LENGTH = 1_000;

export interface AddFindRequest {
  planId: number;
  lat: number;
  lon: number;
  /** What the traveller calls it. */
  name?: string;
  /** Why it is worth going — the thing that matters when planning. */
  note?: string;
  /** Where it came from: the article, the map link. */
  sourceUrl?: string;
  /**
   * Override the automatic choice. Use it when the endpoint asked
   * because the find sits outside every leg.
   */
  legIndex?: number;
  /**
   * How long to allow for it. Required when no OSM entry matches —
   * that is the one question §9.2 has the planner ask.
   */
  dwellMinutes?: number;
}

export interface AddFindResponse {
  /** The pool entry, new or the one it was merged into. */
  entry: StoredPoolEntry;
  legIndex: number;
  /** True when this folded into an entry that was already there. */
  merged: boolean;
  /** The OSM entry it was matched to, if any. */
  matchedOsmRef: string | null;
  /**
   * What is not known about it, in plain words. Empty for a find with
   * an OSM entry behind it; otherwise it names what the planner will be
   * missing rather than filling it in (§9.2, §15.3).
   */
  unknown: string[];
}

export const addFind = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/finds", auth: true },
  async (req: AddFindRequest): Promise<AddFindResponse> => {
    const userId = requireUser();
    const position = validatePosition(req);
    const note = validateNote(req.note);

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    // 1. The right leg, by location.
    const legIndex = req.legIndex ?? chooseLegFor(position, plan);
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    // 5. Try for an OSM entry, and be explicit when there is none.
    const match = await matchOsmEntry(position, req.name);

    // 3. Already there? Merge rather than add.
    const existing = [
      ...leg.pool.map((c) => ({ osmRef: c.osmRef, name: c.name, lat: c.lat, lon: c.lon })),
      ...leg.days.flatMap((d) =>
        d.blocks.flatMap((b) =>
          b.stops.map((s) => ({ osmRef: s.osmRef, name: s.name, lat: s.lat, lon: s.lon })),
        ),
      ),
    ];
    const duplicate = findDuplicate(
      { osmRef: match?.osmRef, name: req.name ?? match?.name, ...position },
      existing,
    );

    if (duplicate) {
      const entry = await mergeIntoPoolEntry({
        legId: leg.id,
        osmRef: duplicate.osmRef,
        note,
        sourceUrl: req.sourceUrl ?? null,
        addedBy: userId,
      });
      if (!entry) {
        // It is already planned into a day rather than sitting in the
        // pool. Saying so is the useful answer — adding a second copy
        // would have it compete with itself.
        throw APIError.alreadyExists(
          `„${duplicate.name ?? duplicate.osmRef}" ist schon für diese Etappe eingeplant`,
        );
      }
      return {
        entry,
        legIndex: leg.position,
        merged: true,
        matchedOsmRef: match?.osmRef ?? null,
        unknown: [],
      };
    }

    const category = match ? match.categories[0] ?? null : null;
    const dwellMinutes = resolveDwell(req.dwellMinutes, category);
    if (dwellMinutes === null) {
      // The one question §9.2 has the planner ask. Asking beats
      // inventing a duration and planning a day around it.
      throw APIError.invalidArgument(
        "kein OpenStreetMap-Eintrag an dieser Stelle — bitte eine geschätzte Dauer "
          + "(dwellMinutes) mitgeben",
      );
    }

    const entry = await addPoolEntry({
      legId: leg.id,
      osmRef: match?.osmRef ?? manualRef(`${Date.now()}-${Math.round(position.lat * 1e5)}`),
      name: req.name ?? match?.name ?? null,
      lat: position.lat,
      lon: position.lon,
      // 5. "unknown" is stored rather than a plausible-looking guess: it
      // is what we know, and the solver can see it is not a real one.
      category: category ?? "unknown",
      dwellMinutes,
      // 2. A suggestion, not an appointment. It enters at the score a
      // plain candidate would get, and earns its place from there.
      score: 1,
      reasons: reasonsFor(note, req.sourceUrl),
      origin: "manual",
      note,
      sourceUrl: req.sourceUrl ?? null,
      addedBy: userId,
      unmatched: match === null,
    });

    return {
      entry,
      legIndex: leg.position,
      merged: false,
      matchedOsmRef: match?.osmRef ?? null,
      unknown: match ? [] : ["Öffnungszeiten", "Kategorie"],
    };
  },
);

/**
 * The nearest OSM entry, if one is close enough to be the same place.
 *
 * A search rather than a reverse lookup: reverse geocoding answers
 * "what address is this", and a find is a place. Failing to match is a
 * normal outcome, not an error — plenty of what people find is not in
 * OpenStreetMap at all.
 */
async function matchOsmEntry(
  position: { lat: number; lon: number },
  name: string | undefined,
): Promise<GeoPoiSearchSpot | null> {
  const region = await pickRegion(position.lat, position.lon);
  if (!region) return null;

  let page;
  try {
    page = await getGeoClient().searchPois(region.postgresDb, {
      center: { ...position, radiusM: MATCH_RADIUS_M },
      limit: 20,
    });
  } catch {
    // A geo outage must not stop a find reaching the pool. It arrives
    // unmatched, which is a state the caller already handles.
    return null;
  }
  if (page.spots.length === 0) return null;

  // Nearest first is what the search returns. Prefer a name match among
  // the close ones: standing between a café and a museum, the name is
  // what says which one was meant.
  const wanted = name?.trim().toLocaleLowerCase("de");
  if (wanted) {
    const named = page.spots.find((s) => s.name?.toLocaleLowerCase("de") === wanted);
    if (named) return named;
  }
  return page.spots[0];
}

function chooseLegFor(
  position: { lat: number; lon: number },
  plan: NonNullable<Awaited<ReturnType<typeof loadPlan>>>,
): number {
  const choice = chooseLeg(
    position,
    plan.legs.map((l) => ({ position: l.position, title: l.title, anchor: l.anchor })),
  );
  if (choice.position !== null) return choice.position;

  throw APIError.failedPrecondition(
    choice.reason === "no-legs"
      ? "dieser Plan hat noch keine Etappe, in die der Fund passt"
      : "der Fund liegt in keiner Etappe dieser Reise — bitte legIndex mitgeben",
  );
}

/**
 * A stated duration wins; a matched category supplies the default;
 * neither means the caller has to be asked.
 */
function resolveDwell(stated: number | undefined, category: string | null): number | null {
  if (stated !== undefined) {
    if (!Number.isFinite(stated) || stated <= 0) {
      throw APIError.invalidArgument("dwellMinutes must be a positive number");
    }
    return Math.round(stated);
  }
  if (category && DEFAULT_DWELL_MINUTES[category] !== undefined) {
    return DEFAULT_DWELL_MINUTES[category];
  }
  return null;
}

/**
 * "Warum hier?" for a find is what the person said, not what the data
 * says. Where it came from is part of the answer.
 */
function reasonsFor(note: string | null, _sourceUrl: string | undefined): string[] {
  const reasons = ["selbst hinzugefügt"];
  if (note) reasons.push(note);
  return reasons;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePosition(req: AddFindRequest): { lat: number; lon: number } {
  const { lat, lon } = req;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
  return { lat, lon };
}

function validateNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw APIError.invalidArgument(`note may be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed;
}
