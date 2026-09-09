/**
 * The collection speaking up, and what to do with several answers (§20.2).
 *
 * A collection that is only a list gets read until it is too long, and
 * then never again. What makes it worth keeping is that it **announces
 * itself** — and the machinery for that exists: §7.1 watches regions
 * around the next stops, §7.2 answers "what is nearby" out of the pool
 * first. This is the same grip with a different pool behind it.
 *
 * Two endpoints, and the difference between them is the whole point of
 * §20:
 *
 *   - `…/ideas/nearby` answers "is anything we collected near here?".
 *     One spot, one sentence: "der Biergarten, den Anna gemerkt hat,
 *     ist zehn Minuten von hier".
 *   - `…/ideas/outing` answers the question that turns a shopping list
 *     into a planner: **several** entries close together are not "do
 *     you want to go to this one?" but "shall I make an afternoon of
 *     it?" — and the answer to that is a day plan, which `solveDay`
 *     already computes. A pool plus an anchor plus a time budget *is*
 *     the planner's input; all that was missing was the occasion.
 *
 * The area may be measured or stated. Standing somewhere, the position
 * is the anchor; on a free Saturday, "something within 50 km" is the
 * same call with a stated centre — the trigger is the time rather than
 * the place.
 *
 * **Told once, not twice.** Suggesting the same beer garden on Tuesday
 * and again on Wednesday is nagging (§6.4), so a nearby answer stamps
 * what it returned and stays quiet about it for a week. Dismissing is
 * remembered rather than deleted, the way §7.1 remembers a "no": an
 * idea somebody waved away three times is not offered again, but it is
 * still in the collection, because taking it out was not what they said.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { toCandidates } from "./candidates";
import { solveDay, type Candidate } from "./solver";
import { haversineMeters, DEFAULT_MAX_WALK_MINUTES, type TransportMode } from "./travel";

/** How far "in der Nähe" reaches when nobody says (§20.2). */
const DEFAULT_NEARBY_RADIUS_M = 5_000;
const MAX_RADIUS_M = 100_000;
/** A free afternoon, in minutes, when no budget is given. */
const DEFAULT_BUDGET_MINUTES = 240;
const MAX_BUDGET_MINUTES = 16 * 60;
/** Quiet about the same idea for this long after suggesting it (§6.4). */
export const QUIET_DAYS = 7;
/** Waved away this often, and it stops being offered (§7.1's "no"). */
export const DISMISSALS_UNTIL_QUIET = 3;
const SEARCH_LIMIT = 150;
/** The longest single hop an outing by car or train may propose. */
const DRIVING_LEG_MINUTES = 90;

export interface IdeaNearbyRequest {
  /** Where you are standing, or the centre of the area you mean. */
  lat: number;
  lon: number;
  radiusM?: number;
  /** Whose collection. Your own by default. */
  ownerId?: number;
  /**
   * False to look without being counted as having been told — the
   * screen that lists ideas by distance rather than the one that says
   * "there is something here".
   */
  markSuggested?: boolean;
}

export interface NearIdea {
  id: number;
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  distanceM: number;
  category: string;
  dwellMinutes: number;
  note: string | null;
  /** Who put it there — "der Biergarten, den Anna gemerkt hat". */
  addedBy: string | null;
  validTo: string | null;
}

export interface IdeaNearbyResponse {
  ideas: NearIdea[];
  /**
   * Ideas inside the radius that were deliberately not offered: told
   * recently, or waved away often enough. Counted rather than listed —
   * the number is honest, and the list would be noise.
   */
  quiet: number;
}

export const ideasNearby = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/nearby", auth: true },
  async (req: IdeaNearbyRequest): Promise<IdeaNearbyResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const position = validatePosition(req);
    const radiusM = validateRadius(req.radiusM, DEFAULT_NEARBY_RADIUS_M);

    const rows = await loadIdeas(ownerId);
    const today = new Date();
    const inRange = rows
      .map((row) => ({ row, distanceM: Math.round(haversineMeters(position, row)) }))
      .filter((entry) => entry.distanceM <= radiusM)
      .filter((entry) => stillValid(entry.row, today));

    const offerable = inRange.filter((entry) => isOfferable(entry.row, today));
    const ideas = offerable
      .sort((a, b) => a.distanceM - b.distanceM)
      .map(({ row, distanceM }) => ({
        id: row.id,
        osmRef: row.osmRef,
        name: row.title ?? row.name,
        lat: row.lat,
        lon: row.lon,
        distanceM,
        category: row.category,
        dwellMinutes: row.dwellMinutes,
        note: row.note,
        addedBy: row.addedBy,
        validTo: row.validTo,
      }));

    // Being returned *is* being told, so the stamp goes on here rather
    // than waiting for a client to report back — a client that forgets
    // would make the whole rule silently useless.
    if (req.markSuggested !== false && ideas.length > 0) {
      await db
        .update(ideaPool)
        .set({ last_suggested_at: new Date().toISOString() })
        .where(inArray(ideaPool.id, ideas.map((idea) => idea.id)));
    }

    return { ideas, quiet: inRange.length - offerable.length };
  },
);

export interface IdeaDismissRequest {
  id: number;
  ownerId?: number;
}

/**
 * "Not now." Remembered rather than acted on: the entry stays in the
 * collection, and after enough of these it simply stops speaking up.
 */
export const dismissIdea = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/dismiss", auth: true },
  async (req: IdeaDismissRequest): Promise<{ dismissals: number }> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const [row] = await db
      .update(ideaPool)
      .set({
        dismissed_count: sql`${ideaPool.dismissed_count} + 1`,
        last_suggested_at: new Date().toISOString(),
      })
      .where(and(eq(ideaPool.id, req.id), eq(ideaPool.owner_id, ownerId)))
      .returning({ dismissals: ideaPool.dismissed_count });
    if (!row) throw APIError.notFound("diese Idee gibt es nicht");
    return { dismissals: row.dismissals };
  },
);

export interface OutingRequest {
  /** The anchor: where you are, or where the day should start. */
  lat: number;
  lon: number;
  /** How far to look for ideas. 25 km by default — a day-trip radius. */
  radiusM?: number;
  ownerId?: number;
  /** How long the outing may take, in minutes. Half a day by default. */
  budgetMinutes?: number;
  /** foot | bike | transit | car. By car for a day trip out of town. */
  mode?: TransportMode;
  /**
   * Fill up from the region search when the collection alone is thin
   * (§20.2). On by default; the result marks which is which.
   */
  fillFromRegion?: boolean;
  maxWalkMinutes?: number;
}

export interface OutingStop {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  /** Minutes of travel from the previous stop (the anchor, for the first). */
  travelMinutes: number;
  /** True for something the family collected, false for a fresh find. */
  fromIdeas: boolean;
  /** Who put it in the collection, where that is known. */
  addedBy: string | null;
}

export interface OutingResponse {
  /** True when there is anything worth proposing at all. */
  offered: boolean;
  /** Why not, when not: no-ideas | nothing-fits. */
  reason: "ok" | "no-ideas" | "nothing-fits";
  stops: OutingStop[];
  /** Minutes the proposal actually uses, travel included. */
  usedMinutes: number;
  budgetMinutes: number;
  /** Ideas considered but left out — the honest "was fällt weg". */
  leftOut: number;
}

export const proposeOuting = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/outing", auth: true },
  async (req: OutingRequest): Promise<OutingResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const anchor = validatePosition(req);
    const radiusM = validateRadius(req.radiusM, 25_000);
    const budgetMinutes = validateBudget(req.budgetMinutes);
    const mode: TransportMode = req.mode ?? "car";
    // The planner's leg cap is a *walking* budget (40 minutes), which is
    // the right refusal inside a city and the wrong one for a day trip:
    // half an hour in the car is how you get to the lake, not an
    // unreasonable detour. On foot and by bike the walking figure
    // stands.
    const maxWalkMinutes = req.maxWalkMinutes
      ?? (mode === "foot" || mode === "bike" ? DEFAULT_MAX_WALK_MINUTES : DRIVING_LEG_MINUTES);

    const today = new Date();
    const rows = (await loadIdeas(ownerId))
      .filter((row) => stillValid(row, today))
      .filter((row) => haversineMeters(anchor, row) <= radiusM);

    const addedBy = new Map(rows.map((row) => [row.osmRef, row.addedBy]));
    const collected: Candidate[] = rows.map((row) => ({
      osmRef: row.osmRef,
      name: row.title ?? row.name,
      lat: row.lat,
      lon: row.lon,
      category: row.category,
      dwellMinutes: row.dwellMinutes,
      kind: row.kind,
      // Ahead of anything the region search turns up: what the family
      // chose beats what the map offers (§7.2's ordering).
      score: 10,
    }));

    const candidates: Candidate[] = [...collected];
    if (req.fillFromRegion !== false) {
      candidates.push(...(await fillFromRegion(anchor, radiusM, new Set(rows.map((r) => r.osmRef)))));
    }

    if (candidates.length === 0) {
      return {
        offered: false,
        reason: "no-ideas",
        stops: [],
        usedMinutes: 0,
        budgetMinutes,
        leftOut: 0,
      };
    }

    // One block, because an outing *is* one block: a stretch of time
    // with an anchor at both ends. The four-part day belongs to a
    // holiday, not to a Saturday afternoon.
    const solved = solveDay({
      anchor,
      blocks: [{
        id: "outing",
        label: "Ausflug",
        kind: "spots",
        baseBudgetMinutes: budgetMinutes,
        budgetMinutes,
      }],
      candidates,
      maxWalkMinutes,
      mode,
    });

    const block = solved.blocks[0];
    const stops: OutingStop[] = block.stops.map((stop) => ({
      osmRef: stop.osmRef,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      category: stop.category,
      dwellMinutes: stop.dwellMinutes,
      travelMinutes: stop.travelFromPrevious.minutes,
      fromIdeas: addedBy.has(stop.osmRef),
      addedBy: addedBy.get(stop.osmRef) ?? null,
    }));

    return {
      offered: stops.length > 0,
      reason: stops.length > 0 ? "ok" : "nothing-fits",
      stops,
      usedMinutes: block.usedMinutes,
      budgetMinutes,
      leftOut: solved.unplaced.filter((candidate) => addedBy.has(candidate.osmRef)).length,
    };
  },
);

/** What the region has to offer, behind everything the family collected. */
async function fillFromRegion(
  anchor: { lat: number; lon: number },
  radiusM: number,
  known: ReadonlySet<string>,
): Promise<Candidate[]> {
  const region = await pickRegion(anchor.lat, anchor.lon);
  if (!region) return [];
  try {
    const page = await getGeoClient().searchPois(region.postgresDb, {
      center: { ...anchor, radiusM },
      limit: SEARCH_LIMIT,
    });
    return toCandidates(page.spots.filter((spot) => !known.has(spot.osmRef)));
  } catch {
    // A geo outage costs the top-up, not the proposal: what the family
    // collected is still there, and that is the part that matters.
    return [];
  }
}

interface IdeaRow {
  id: number;
  osmRef: string;
  name: string | null;
  title: string | null;
  lat: number;
  lon: number;
  category: string;
  kind: string | null;
  dwellMinutes: number;
  note: string | null;
  validFrom: string | null;
  validTo: string | null;
  lastSuggestedAt: string | null;
  dismissedCount: number;
  addedBy: string | null;
}

async function loadIdeas(ownerId: number): Promise<IdeaRow[]> {
  return await db
    .select({
      id: ideaPool.id,
      osmRef: ideaPool.osm_ref,
      name: ideaPool.name,
      title: ideaPool.title,
      lat: ideaPool.lat,
      lon: ideaPool.lon,
      category: ideaPool.category,
      kind: ideaPool.kind,
      dwellMinutes: ideaPool.dwell_minutes,
      note: ideaPool.note,
      validFrom: ideaPool.valid_from,
      validTo: ideaPool.valid_to,
      lastSuggestedAt: ideaPool.last_suggested_at,
      dismissedCount: ideaPool.dismissed_count,
      addedBy: users.name,
    })
    .from(ideaPool)
    .leftJoin(users, eq(users.id, ideaPool.created_by))
    .where(eq(ideaPool.owner_id, ownerId));
}

/**
 * Is this still a thing? An exhibition that closed on Sunday is not an
 * idea any more, and offering it is worse than saying nothing (§20.4).
 */
function stillValid(row: IdeaRow, today: Date): boolean {
  const day = today.toISOString().slice(0, 10);
  if (row.validFrom && row.validFrom > day) return false;
  if (row.validTo && row.validTo < day) return false;
  return true;
}

/** Told recently, or waved away often enough, means quiet (§6.4). */
function isOfferable(row: IdeaRow, now: Date): boolean {
  if (row.dismissedCount >= DISMISSALS_UNTIL_QUIET) return false;
  if (row.lastSuggestedAt === null) return true;
  const since = now.getTime() - Date.parse(row.lastSuggestedAt);
  return since >= QUIET_DAYS * 86_400_000;
}

async function requireAccess(ownerId: number, userId: number): Promise<number> {
  if (ownerId === userId) return ownerId;
  const [share] = await db
    .select({ id: ideaPoolShares.id })
    .from(ideaPoolShares)
    .where(and(eq(ideaPoolShares.owner_id, ownerId), eq(ideaPoolShares.user_id, userId)))
    .limit(1);
  if (!share) throw APIError.notFound("dieser Ideenvorrat existiert nicht");
  return ownerId;
}

function validatePosition(req: { lat: number; lon: number }): { lat: number; lon: number } {
  const { lat, lon } = req;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument("lat must be between -90 and 90");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument("lon must be between -180 and 180");
  }
  return { lat, lon };
}

function validateRadius(radiusM: number | undefined, fallback: number): number {
  if (radiusM === undefined) return fallback;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  return Math.min(Math.round(radiusM), MAX_RADIUS_M);
}

function validateBudget(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_BUDGET_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw APIError.invalidArgument("budgetMinutes must be a positive number");
  }
  return Math.min(Math.round(minutes), MAX_BUDGET_MINUTES);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
