/**
 * How the collection and a trip meet (§20.3).
 *
 * Not a second mechanism — one more source. All three directions go
 * through machinery that already exists, and that is the whole reason
 * this arrives late and cheap:
 *
 *   - **An accepted outing becomes a trip.** §20.5 says it plainly: what
 *     comes out of the proposal is "eine ganz normale eintägige Reise
 *     mit einer Etappe". So this creates one, puts the accepted ideas
 *     into its pool the way a find arrives (§9.2), and plans the day
 *     out of that pool.
 *   - **A new trip asks about what was collected.** "Ihr habt vier Ideen
 *     für Lissabon gesammelt" is a question, not an action: an idea
 *     from last year is not automatically this trip's wish, so nothing
 *     is taken over by itself.
 *   - **What a trip did not use may go back.** "Beim nächsten Mal" is
 *     the honest place for a spot that never made it into a day.
 *
 * In every direction the idea stays in the collection. §20.3 is explicit
 * that it is *"nicht verbraucht, nur benutzt"* — taking it into a trip
 * is not spending it.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, tripPlanPool, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { addFind } from "./add-find";
import { createTripPlan, detailTripDay } from "./plans";
import { loadPlan, type StoredLeg, type StoredPlan } from "./plan-store";
import { haversineMeters, type TransportMode } from "./travel";

/** How close to a leg's anchor an idea has to be to be worth offering. */
const NEAR_LEG_RADIUS_M = 30_000;
/**
 * What an idea taken into a trip is worth against the region's own
 * suggestions: enough to be planned first, in the ordering §7.2 sets
 * out — what the family collected before what the map offers.
 */
const COLLECTED_SCORE = 10;

export interface AcceptOutingRequest {
  /** Where the day starts and ends. */
  lat: number;
  lon: number;
  /** The ideas that were accepted, by id. */
  ideaIds: number[];
  ownerId?: number;
  /** The day it happens, YYYY-MM-DD. Required: a day without a date is not an outing. */
  date: string;
  title?: string;
  /** How long the outing may take. Four hours by default. */
  budgetMinutes?: number;
  mode?: TransportMode;
}

export interface AcceptOutingResponse {
  plan: StoredPlan;
  /** Ideas that ended up on the day, by id. */
  planned: number[];
  /**
   * Accepted, but not on the day — they are in the trip's pool. Said
   * rather than silently dropped: the outing that fits is shorter than
   * the outing somebody wanted (§5).
   */
  inPool: number[];
}

export const acceptOuting = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/outing/accept", auth: true },
  async (req: AcceptOutingRequest): Promise<AcceptOutingResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
      throw APIError.invalidArgument(`date must be YYYY-MM-DD, got '${req.date}'`);
    }
    if (req.ideaIds.length === 0) {
      throw APIError.invalidArgument("ohne Ideen gibt es keinen Ausflug");
    }
    const budgetMinutes = req.budgetMinutes ?? 240;

    const ideas = await db
      .select()
      .from(ideaPool)
      .where(and(eq(ideaPool.owner_id, ownerId), inArray(ideaPool.id, req.ideaIds)));
    if (ideas.length === 0) throw APIError.notFound("keine dieser Ideen gibt es");

    // One leg, one day, one block: an outing is a stretch of time with
    // an anchor at both ends (§20.5). The four-part day belongs to a
    // holiday. The day is left at trip resolution for now — it is
    // planned below, once the accepted ideas are in the pool, so that
    // they are what it is planned *from*.
    const { plan } = await createTripPlan({
      title: req.title ?? "Ausflug",
      legs: [{
        anchor: { lat: req.lat, lon: req.lon },
        days: 1,
        startDate: req.date,
        mode: req.mode,
      }],
      blocks: [{
        id: "outing",
        label: "Ausflug",
        kind: "spots",
        baseBudgetMinutes: budgetMinutes,
      }],
      detailDays: 0,
    });

    // The reference the pool entry ends up under is not the idea's own:
    // a place OpenStreetMap does not know gets a fresh `manual:` handle
    // when it arrives as a find. So the mapping is kept here rather
    // than reconstructed afterwards from something that changed.
    const taken: { id: number; osmRef: string }[] = [];
    for (const idea of ideas) {
      const osmRef = await takeIntoPlan(plan.id, idea);
      if (osmRef !== null) taken.push({ id: idea.id, osmRef });
    }

    const { plan: planned } = await detailTripDay({ planId: plan.id, dayIndex: 0 });
    const onDay = new Set(
      planned.legs[0].days[0].blocks.flatMap((block) => block.stops.map((s) => s.osmRef)),
    );

    return {
      plan: planned,
      planned: taken.filter((entry) => onDay.has(entry.osmRef)).map((entry) => entry.id),
      inPool: taken.filter((entry) => !onDay.has(entry.osmRef)).map((entry) => entry.id),
    };
  },
);

export interface IdeasForPlanRequest {
  planId: number;
  ownerId?: number;
}

export interface IdeaForPlan {
  id: number;
  name: string | null;
  lat: number;
  lon: number;
  category: string;
  note: string | null;
  addedBy: string | null;
  /** Which leg it lies in, and how far from that leg's anchor. */
  legIndex: number;
  distanceM: number;
  /** True when this trip already has it — planned or in the pool. */
  alreadyInTrip: boolean;
}

export interface IdeasForPlanResponse {
  ideas: IdeaForPlan[];
}

/**
 * "Ihr habt vier Ideen für Lissabon gesammelt."
 *
 * A question rather than an action (§20.3): an idea from last year is
 * not automatically the wish of this trip, so nothing is taken over
 * here. What is already in the trip is marked rather than hidden —
 * seeing that it is there is the answer to the same question.
 */
export const ideasForPlan = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/ideas", auth: true },
  async (req: IdeasForPlanRequest): Promise<IdeasForPlanResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const inTrip = placesOf(plan.legs);
    const rows = await db
      .select({
        id: ideaPool.id,
        osmRef: ideaPool.osm_ref,
        name: ideaPool.name,
        title: ideaPool.title,
        lat: ideaPool.lat,
        lon: ideaPool.lon,
        category: ideaPool.category,
        note: ideaPool.note,
        validFrom: ideaPool.valid_from,
        validTo: ideaPool.valid_to,
        addedBy: users.name,
      })
      .from(ideaPool)
      .leftJoin(users, eq(users.id, ideaPool.created_by))
      .where(eq(ideaPool.owner_id, ownerId));

    const ideas: IdeaForPlan[] = [];
    for (const row of rows) {
      let best: { legIndex: number; distanceM: number } | null = null;
      for (const leg of plan.legs) {
        const distanceM = Math.round(haversineMeters(leg.anchor, row));
        if (distanceM > NEAR_LEG_RADIUS_M) continue;
        if (best === null || distanceM < best.distanceM) {
          best = { legIndex: leg.position, distanceM };
        }
      }
      if (best === null) continue;
      ideas.push({
        id: row.id,
        name: row.title ?? row.name,
        lat: row.lat,
        lon: row.lon,
        category: row.category,
        note: row.note,
        addedBy: row.addedBy,
        legIndex: best.legIndex,
        distanceM: best.distanceM,
        alreadyInTrip: isInTrip(row, inTrip),
      });
    }

    ideas.sort((a, b) => a.legIndex - b.legIndex || a.distanceM - b.distanceM);
    return { ideas };
  },
);

export interface TakeIdeaRequest {
  planId: number;
  id: number;
  ownerId?: number;
}

/** Take one collected idea into this trip — the find path (§9.2). */
export const takeIdeaIntoPlan = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/ideas/take", auth: true },
  async (req: TakeIdeaRequest): Promise<{ taken: boolean; osmRef: string | null }> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const [idea] = await db
      .select()
      .from(ideaPool)
      .where(and(eq(ideaPool.owner_id, ownerId), eq(ideaPool.id, req.id)))
      .limit(1);
    if (!idea) throw APIError.notFound("diese Idee gibt es nicht");

    const osmRef = await takeIntoPlan(req.planId, idea);
    return { taken: osmRef !== null, osmRef };
  },
);

export interface KeepForNextTimeRequest {
  planId: number;
  /** Pool entries of this trip, by OSM reference. */
  osmRefs: string[];
  ownerId?: number;
}

/**
 * What the trip did not use goes back into the collection (§20.3).
 *
 * "Beim nächsten Mal" is the honest place for a spot nobody got to —
 * better than a pool that disappears with the trip it hung off.
 */
export const keepForNextTime = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/pool/to-ideas", auth: true },
  async (req: KeepForNextTimeRequest): Promise<{ kept: number; alreadyThere: number }> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const wanted = new Set(req.osmRefs);
    const candidates = plan.legs.flatMap((leg) => leg.pool).filter((c) => wanted.has(c.osmRef));
    if (candidates.length === 0) {
      throw APIError.notFound("keiner dieser Spots liegt im Vorrat dieser Reise");
    }

    let kept = 0;
    let alreadyThere = 0;
    for (const candidate of candidates) {
      const inserted = await db
        .insert(ideaPool)
        .values({
          owner_id: ownerId,
          created_by: userId,
          osm_ref: candidate.osmRef,
          name: candidate.name,
          local_name: candidate.localName ?? null,
          lat: candidate.lat,
          lon: candidate.lon,
          category: candidate.category,
          kind: candidate.kind ?? null,
          dwell_minutes: candidate.dwellMinutes,
          note: candidate.note ?? null,
          source_url: candidate.sourceUrl ?? null,
          wikipedia_url: candidate.wikipediaUrl ?? null,
          facade_azimuth: candidate.facadeAzimuth ?? null,
          unmatched: candidate.unmatched,
        })
        // Already collected is not an error: the trip found it worth
        // keeping and so did somebody earlier.
        .onConflictDoNothing()
        .returning({ id: ideaPool.id });
      if (inserted.length > 0) kept += 1;
      else alreadyThere += 1;
    }

    return { kept, alreadyThere };
  },
);

/**
 * One idea into one trip, through the find path.
 *
 * §20.3 asks for exactly this route rather than a private one: the leg
 * is chosen by location, duplicates merge, and the provenance survives.
 * What it adds is the score: a spot the family collected is planned
 * before what the region search offers (§7.2).
 *
 * Returns the OSM reference it landed under, or null when the trip
 * already had it planned — which the caller reports rather than treats
 * as a failure.
 */
async function takeIntoPlan(
  planId: number,
  idea: typeof ideaPool.$inferSelect,
): Promise<string | null> {
  try {
    const { entry } = await addFind({
      planId,
      lat: idea.lat,
      lon: idea.lon,
      name: idea.title ?? idea.name ?? undefined,
      note: idea.note ?? undefined,
      sourceUrl: idea.source_url ?? undefined,
      dwellMinutes: idea.dwell_minutes,
    });
    await db
      .update(tripPlanPool)
      .set({ score: sql`greatest(${tripPlanPool.score}, ${COLLECTED_SCORE})` })
      .where(eq(tripPlanPool.id, entry.id));
    return entry.osmRef;
  } catch (err) {
    // "Already planned for this leg" is an answer, not a fault: the
    // idea is in the trip, which is what was wanted.
    if (err instanceof APIError && err.code === "already_exists") return null;
    throw err;
  }
}

/** How close two entries have to be to be the same place (as `finds.ts`). */
const SAME_PLACE_M = 80;

interface TripPlace {
  osmRef: string;
  lat: number;
  lon: number;
}

function placesOf(legs: StoredLeg[]): TripPlace[] {
  const places: TripPlace[] = [];
  for (const leg of legs) {
    for (const candidate of leg.pool) places.push(candidate);
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) places.push(stop);
      }
    }
  }
  return places;
}

/**
 * Is this idea already in the trip?
 *
 * By reference where there is one, and otherwise by standing in the
 * same spot — a place the map does not know arrives as a find under a
 * fresh `manual:` handle, so its own reference is not what the trip
 * carries. The distance is the one `finds.ts` uses to call two entries
 * the same place, and using a different number here would let the same
 * beer garden be both "already in the trip" and a duplicate.
 */
function isInTrip(idea: { osmRef: string; lat: number; lon: number }, places: TripPlace[]): boolean {
  return places.some(
    (place) =>
      place.osmRef === idea.osmRef || haversineMeters(place, idea) <= SAME_PLACE_M,
  );
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

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
