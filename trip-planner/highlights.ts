/**
 * What a stay is known for, as a list to pick from (ideas plan, stage 2).
 *
 * A trip of ideas starts empty, and the first question is "what is
 * there?". This answers it the way a guidebook would: the places the
 * open data knows best around the stay — page views, languages,
 * Wikivoyage — with a picture and a line about each, ordered by the
 * local model where it has answered and by fame until then.
 *
 * Nothing is written to the trip. A hit goes in only when somebody taps
 * "Zur Reise", which is the same `POST …/finds` every other way in
 * uses. Places already taken are **marked, not hidden**, as in the
 * name search (`search.ts`).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { inArray } from "drizzle-orm";
import db from "../db/database";
import { tripSpotFame } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { toCandidates, type ScoredCandidate } from "./candidates";
import { MAX_CURATION_ENTRIES, signatureOf } from "./curation";
import { curationContextOf, SHAREABLE_REASON } from "./highlights-model";
import {
  requestHighlightsOrder,
  storedHighlights,
  type HighlightEntry,
  type HighlightsStatus,
} from "./highlights-job";
import { hiddenRefs, loadPlan, type StoredLeg } from "./plan-store";
import { spotsAround } from "./plans";
import { stayReach } from "./search-reach";
import { finishLookups, imagesFor, prominenceAround, type SpotImage } from "./spot-fame";
import { descriptionsFor, type SpotDescription } from "./spot-description";
import { summariesFor } from "./spot-summary";
import { haversineMeters } from "./travel";
import { parseSearchArea, type SearchArea } from "./search-area";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export interface HighlightsRequest {
  planId: number;
  legIndex: number;
  /** For "Mehr": where the next page starts. */
  offset?: number;
  limit?: number;
  /**
   * "In diesem Bereich suchen" on the map (stage 4): look around this
   * instead of the stay's reach. The list then comes by fame alone —
   * the model ordered the stay, not this corner of the map.
   */
  area?: SearchArea;
}

export interface Highlight {
  osmRef: string;
  name: string | null;
  localName: string | null;
  lat: number;
  lon: number;
  category: string;
  /** From the stay's lodging. */
  distanceM: number;
  dwellMinutes: number;
  /** Straight from OSM, for the day a place is open on (stage 4). */
  openingHours: string | null;
  /** One line under the name: the model's sentence, else the best open-data reason. */
  reason: string | null;
  picture: SpotImage | null;
  description: SpotDescription | null;
  /** One short German sentence about it, once the background made one. */
  summary: string | null;
  wikipediaUrl: string | null;
  /** Already one of this stay's ideas. */
  inPool: boolean;
  /** Already on a day of it. */
  planned: boolean;
}

export interface HighlightsResponse {
  results: Highlight[];
  hasMore: boolean;
  /** The model has not ordered this stay yet; the list is by fame until then. */
  sorting: boolean;
  /** The region search did not answer, which is not "nothing here". */
  unavailable: boolean;
  /**
   * Some places of this page are still being looked up (picture,
   * description): asking again in a few seconds shows them. Optional
   * for an app older than this.
   */
  picturesPending?: boolean;
}

export const tripHighlights = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/highlights", auth: true },
  async (req: HighlightsRequest): Promise<HighlightsResponse> => {
    const userId = requireUser();
    const offset = clampOffset(req.offset);
    const limit = clampLimit(req.limit);
    const area = parseSearchArea(req.area);
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);
    const empty = { results: [], hasMore: false, sorting: false };
    if (leg.kind !== "stay") return { ...empty, unavailable: false };
    if (!leg.regionDb) return { ...empty, unavailable: true };

    let ranked: ScoredCandidate[];
    try {
      ranked = await rankedAround(leg, plan.constraints, await hiddenRefs(plan.id), area);
    } catch (err) {
      if (err instanceof APIError) return { ...empty, unavailable: true };
      throw err;
    }

    let status: HighlightsStatus | null = null;
    let ordered: Array<{ candidate: ScoredCandidate; reason: string | null }>;
    if (area) {
      ordered = orderBy(ranked, null);
    } else {
      const top = ranked.slice(0, MAX_CURATION_ENTRIES);
      const stored = await storedHighlights(leg.id);
      status = await askForOrder(leg.id, top, stored);
      ordered = orderBy(ranked, stored?.status === "done" ? stored.picks : null);
    }

    const page = ordered.slice(offset, offset + limit);
    const refs = page.map((p) => p.candidate.osmRef);
    const [images, descriptions, summaries, picturesPending] = await Promise.all([
      imagesFor(refs), descriptionsFor(refs), summariesFor(refs), finishLookups(refs, leg.anchor),
    ]);
    const inPool = new Set(leg.pool.map((c) => c.osmRef));
    const planned = plannedRefs(leg);

    return {
      results: page.map(({ candidate, reason }) => ({
        osmRef: candidate.osmRef,
        name: candidate.name,
        localName: candidate.localName ?? null,
        lat: candidate.lat,
        lon: candidate.lon,
        category: candidate.category,
        distanceM: Math.round(haversineMeters(leg.anchor, candidate)),
        dwellMinutes: candidate.dwellMinutes,
        openingHours: candidate.openingHours ?? null,
        reason,
        picture: images.get(candidate.osmRef) ?? null,
        description: descriptions.get(candidate.osmRef) ?? null,
        summary: summaries.get(candidate.osmRef) ?? null,
        wikipediaUrl: candidate.wikipediaUrl ?? null,
        inPool: inPool.has(candidate.osmRef),
        planned: planned.has(candidate.osmRef),
      })),
      hasMore: ordered.length > offset + limit,
      sorting: status === "pending" || status === "running",
      unavailable: false,
      picturesPending,
    };
  },
);

/** The places worth a block around the stay, best known first. */
async function rankedAround(
  leg: StoredLeg,
  constraints: Record<string, unknown>,
  hidden: ReadonlySet<string>,
  area: SearchArea | null,
): Promise<ScoredCandidate[]> {
  const spots = area
    ? await spotsAround(leg.regionDb, { lat: area.lat, lon: area.lon }, area.radiusM, undefined)
    : await spotsAround(leg.regionDb, leg.anchor, stayReach(leg), undefined);
  const interests = Array.isArray(constraints.interests)
    ? (constraints.interests as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  return toCandidates(spots, {
    interests,
    prominence: await prominenceAround(spots, leg.anchor),
    requireProminence: true,
  })
    .filter((c) => !hidden.has(c.osmRef))
    .sort((a, b) => b.score - a.score || a.osmRef.localeCompare(b.osmRef));
}

/** Hand the best of the list to the background, unless it already has them. */
async function askForOrder(
  legId: number,
  top: readonly ScoredCandidate[],
  stored: Awaited<ReturnType<typeof storedHighlights>>,
): Promise<HighlightsStatus | null> {
  const about = await curationContextOf(legId);
  if (!about) return null;
  const fame = top.length === 0 ? [] : await db
    .select({ osmRef: tripSpotFame.osm_ref, wikivoyage: tripSpotFame.wikivoyage, description: tripSpotFame.description })
    .from(tripSpotFame)
    .where(inArray(tripSpotFame.osm_ref, top.map((c) => c.osmRef)));
  const text = new Map(fame.map((f) => [
    f.osmRef,
    f.wikivoyage || ((f.description as { text?: string } | null)?.text ?? null),
  ]));
  const entries: HighlightEntry[] = top.map((c) => ({
    osmRef: c.osmRef,
    name: c.name,
    category: c.category,
    reasons: c.reasons.filter((r) => SHAREABLE_REASON.test(r)),
    text: text.get(c.osmRef) ?? null,
    manual: false,
    wikipediaUrl: c.wikipediaUrl ?? null,
  }));
  return requestHighlightsOrder(legId, {
    entries,
    context: about.context,
    signature: signatureOf(entries.map((e) => e.osmRef), about.interests),
  }, stored);
}

/**
 * The model's picks first, in its order and with its sentence; the rest
 * after them by fame. A place the model left out is not dropped: the
 * list is to pick from, and the model only orders it.
 */
export function orderBy(
  ranked: readonly ScoredCandidate[],
  picks: ReadonlyArray<{ osmRef: string; reason: string | null }> | null,
): Array<{ candidate: ScoredCandidate; reason: string | null }> {
  const byRef = new Map(ranked.map((c) => [c.osmRef, c]));
  const out: Array<{ candidate: ScoredCandidate; reason: string | null }> = [];
  const taken = new Set<string>();
  for (const pick of picks ?? []) {
    const candidate = byRef.get(pick.osmRef);
    if (!candidate || taken.has(pick.osmRef)) continue;
    taken.add(pick.osmRef);
    out.push({ candidate, reason: pick.reason ?? firstReason(candidate) });
  }
  for (const candidate of ranked) {
    if (taken.has(candidate.osmRef)) continue;
    out.push({ candidate, reason: firstReason(candidate) });
  }
  return out;
}

function firstReason(candidate: ScoredCandidate): string | null {
  return candidate.reasons.find((r) => SHAREABLE_REASON.test(r)) ?? null;
}

function plannedRefs(leg: StoredLeg): Set<string> {
  const refs = new Set<string>();
  for (const day of leg.days) for (const block of day.blocks) for (const stop of block.stops) refs.add(stop.osmRef);
  return refs;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) throw APIError.invalidArgument("limit must be a positive number");
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0) throw APIError.invalidArgument("offset must not be negative");
  return Math.floor(offset);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
