/**
 * A trip or an idea collection as a file, and back (format in
 * `exchange-format.ts`).
 *
 *   - `GET  /trip-planner/plans/:planId/export` — the whole trip: legs,
 *     days, blocks, stops, fixpoints, breaks, excursions, ideas (pool),
 *     notes, hand-entered travellers, hidden spots, chosen ways.
 *   - `POST /trip-planner/plans/import` — writes a **new** trip owned
 *     by the caller. Never merges into an existing one: two trips with
 *     the same name are two trips, and a merge that guessed which stop
 *     is which would rewrite somebody's plan without asking.
 *   - `GET  /trip-planner/ideas/export` — one idea collection.
 *   - `POST /trip-planner/ideas/import` — adds to a collection. A place
 *     the collection already has (same OSM reference) is left as it
 *     is and counted as skipped, so importing the same file twice adds
 *     nothing the second time.
 *
 * Anyone on a trip may export it; it is theirs to take along. The file
 * holds no row ids and no account ids, so an import cannot point at
 * somebody else's rows.
 */

import { api, APIError } from "encore.dev/api";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  ideaPool,
  tripHiddenSpots,
  tripPlanBlocks,
  tripPlanDays,
  tripPlanDayTripDismissals,
  tripPlanFixpoints,
  tripPlanLegs,
  tripPlanPool,
  tripPlans,
  tripPlanSegments,
  tripPlanStops,
  tripPlanTravellers,
  tripSpotNotes,
  type SpotExtentColumn,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { isOnTrip } from "./plan-access";
import { requireAccess } from "./ideas";
import { priorityOf } from "./priority";
import { placedByOf } from "./placed-by";
import { storedPinReason } from "./pin-reason";
import type { TransportMode } from "./travel";
import {
  EXCHANGE_VERSION,
  ExchangeFileError,
  IDEAS_FORMAT,
  readIdeasFile,
  readTripFile,
  TRIP_FORMAT,
  type ExchangeBlock,
  type ExchangeDay,
  type ExchangeExtent,
  type ExchangeIdea,
  type ExchangeLeg,
  type ExchangeTrip,
  type IdeasFile,
  type TripFile,
} from "./exchange-format";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function extentOf(v: SpotExtentColumn | null | undefined): ExchangeExtent | null {
  if (!v) return null;
  return { end: { lat: v.end.lat, lon: v.end.lon }, lengthM: v.lengthM ?? null, ascentM: v.ascentM ?? null };
}

function reasonsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Read one trip into the file shape. Null when the plan does not exist. */
export async function exportTrip(planId: number, now: Date = new Date()): Promise<TripFile | null> {
  const [plan] = await db.select().from(tripPlans).where(eq(tripPlans.id, planId)).limit(1);
  if (!plan) return null;

  const legs = await db.select().from(tripPlanLegs)
    .where(eq(tripPlanLegs.plan_id, planId)).orderBy(asc(tripPlanLegs.position));
  const legIds = legs.map((l) => l.id);
  const days = legIds.length === 0 ? [] : await db.select().from(tripPlanDays)
    .where(inArray(tripPlanDays.leg_id, legIds)).orderBy(asc(tripPlanDays.leg_id), asc(tripPlanDays.day_index));
  const dayIds = days.map((d) => d.id);
  const blocks = dayIds.length === 0 ? [] : await db.select().from(tripPlanBlocks)
    .where(inArray(tripPlanBlocks.day_id, dayIds)).orderBy(asc(tripPlanBlocks.day_id), asc(tripPlanBlocks.position));
  const blockIds = blocks.map((b) => b.id);
  const stops = blockIds.length === 0 ? [] : await db.select().from(tripPlanStops)
    .where(inArray(tripPlanStops.block_id, blockIds)).orderBy(asc(tripPlanStops.block_id), asc(tripPlanStops.position));
  const fixpoints = dayIds.length === 0 ? [] : await db.select().from(tripPlanFixpoints)
    .where(inArray(tripPlanFixpoints.day_id, dayIds))
    .orderBy(asc(tripPlanFixpoints.day_id), asc(tripPlanFixpoints.start_minutes), asc(tripPlanFixpoints.id));
  const pool = legIds.length === 0 ? [] : await db.select().from(tripPlanPool)
    .where(inArray(tripPlanPool.leg_id, legIds)).orderBy(asc(tripPlanPool.leg_id), asc(tripPlanPool.id));
  const notes = legIds.length === 0 ? [] : await db.select().from(tripSpotNotes)
    .where(inArray(tripSpotNotes.leg_id, legIds)).orderBy(asc(tripSpotNotes.id));
  const dismissals = legIds.length === 0 ? [] : await db.select().from(tripPlanDayTripDismissals)
    .where(inArray(tripPlanDayTripDismissals.leg_id, legIds)).orderBy(asc(tripPlanDayTripDismissals.id));
  // Somebody with an account comes with their account, not with the
  // file: the trip adds whoever plans it by itself.
  const travellers = (await db.select().from(tripPlanTravellers)
    .where(eq(tripPlanTravellers.plan_id, planId)).orderBy(asc(tripPlanTravellers.id)))
    .filter((t) => t.added_for_user_id === null);
  const hidden = await db.select().from(tripHiddenSpots)
    .where(eq(tripHiddenSpots.plan_id, planId)).orderBy(asc(tripHiddenSpots.id));
  const segments = await db.select().from(tripPlanSegments)
    .where(eq(tripPlanSegments.plan_id, planId)).orderBy(asc(tripPlanSegments.id));

  const daysByLeg = groupBy(days, (d) => d.leg_id);
  const blocksByDay = groupBy(blocks, (b) => b.day_id);
  const stopsByBlock = groupBy(stops, (s) => s.block_id);
  const fixpointsByDay = groupBy(fixpoints, (f) => f.day_id);
  const poolByLeg = groupBy(pool, (p) => p.leg_id);
  const notesByLeg = groupBy(notes, (n) => n.leg_id);
  const dismissalsByLeg = groupBy(dismissals, (d) => d.leg_id);

  const exportBlock = (b: typeof blocks[number]): ExchangeBlock => ({
    templateId: b.template_id,
    label: b.label,
    kind: b.kind,
    budgetMinutes: b.budget_minutes,
    startMinutes: b.start_minutes,
    stops: (stopsByBlock.get(b.id) ?? []).map((s) => ({
      osmRef: s.osm_ref,
      name: s.name,
      localName: s.local_name,
      lat: s.lat,
      lon: s.lon,
      category: s.category,
      kind: s.kind,
      dwellMinutes: s.dwell_minutes,
      note: s.note,
      sourceUrl: s.source_url,
      wikipediaUrl: s.wikipedia_url,
      facadeAzimuth: s.facade_azimuth,
      extent: extentOf(s.extent),
      origin: s.origin,
      priority: priorityOf(s.priority),
      openingHours: s.opening_hours,
      status: s.status === "done" || s.status === "skipped" ? s.status : "planned",
      pinned: s.pinned,
      doneAt: s.done_at === null ? null : new Date(s.done_at).toISOString(),
      placedBy: placedByOf(s.placed_by),
      travelMinutes: s.travel_minutes,
      travelDistanceM: s.travel_distance_m,
      reasons: reasonsOf(s.reasons),
    })),
  });

  const exportDay = (d: typeof days[number]): ExchangeDay => ({
    detailed: d.detailed,
    bufferReason: d.buffer_reason,
    anchor: d.anchor_lat === null || d.anchor_lon === null ? null : {
      lat: d.anchor_lat,
      lon: d.anchor_lon,
      label: d.anchor_label,
      radiusM: d.anchor_radius_m,
      departMinutes: d.anchor_depart_minutes,
      returnMinutes: d.anchor_return_minutes,
      waterDetourM: d.anchor_water_detour_m,
      waterAround: d.anchor_water_around,
    },
    breaks: d.breaks.map((b) => ({ ...b })),
    excursions: d.excursions.map((e) => ({ ...e })),
    fixpoints: (fixpointsByDay.get(d.id) ?? []).map((f) => ({
      kind: f.kind === "departure" ? "departure" : "appointment",
      label: f.label,
      startMinutes: f.start_minutes,
      durationMinutes: f.duration_minutes,
      travelMinutes: f.travel_minutes,
      bufferMinutes: f.buffer_minutes,
      lat: f.lat,
      lon: f.lon,
      blockId: f.block_id,
      spotRef: f.spot_ref,
      pinReason: storedPinReason(f.pin_reason),
    })),
    blocks: (blocksByDay.get(d.id) ?? []).map(exportBlock),
  });

  const exportLeg = (l: typeof legs[number]): ExchangeLeg => ({
    title: l.title,
    kind: l.kind === "transit" ? "transit" : "stay",
    anchor: { lat: l.anchor_lat, lon: l.anchor_lon, label: l.anchor_label, radiusM: l.anchor_radius_m },
    origin: l.origin_lat === null || l.origin_lon === null
      ? null
      : { lat: l.origin_lat, lon: l.origin_lon, label: l.origin_label },
    arriveMinutes: l.arrive_minutes,
    departMinutes: l.depart_minutes,
    endMinutes: l.end_minutes,
    mode: l.mode as TransportMode,
    regionDb: l.region_db,
    awaitingRegion: l.awaiting_region,
    quartersAboard: l.quarters_aboard,
    tenderPort: l.tender_port,
    departureNote: l.departure_note,
    arrivalNote: l.arrival_note,
    startDate: l.start_date,
    radiusM: l.radius_m,
    dayStartsAt: l.day_starts_at,
    days: (daysByLeg.get(l.id) ?? []).map(exportDay),
    pool: (poolByLeg.get(l.id) ?? []).map((p) => ({
      osmRef: p.osm_ref,
      name: p.name,
      localName: p.local_name,
      lat: p.lat,
      lon: p.lon,
      category: p.category,
      kind: p.kind,
      dwellMinutes: p.dwell_minutes,
      note: p.note,
      sourceUrl: p.source_url,
      wikipediaUrl: p.wikipedia_url,
      facadeAzimuth: p.facade_azimuth,
      extent: extentOf(p.extent),
      origin: p.origin,
      priority: priorityOf(p.priority),
      openingHours: p.opening_hours,
      score: p.score,
      priorityBoost: p.priority_boost,
      unmatched: p.unmatched,
      reasons: reasonsOf(p.reasons),
      searchScore: p.search_score,
    })),
    spotNotes: (notesByLeg.get(l.id) ?? []).map((n) => ({
      osmRef: n.osm_ref,
      title: n.title,
      note: n.note,
      url: n.url,
      dwellMinutes: n.dwell_minutes,
      photoStop: n.photo_stop,
    })),
    dismissedDayTrips: (dismissalsByLeg.get(l.id) ?? []).map((d) => ({ targetKey: d.target_key, name: d.name })),
  });

  const trip: ExchangeTrip = {
    title: plan.title,
    constraints: (plan.constraints ?? {}) as Record<string, unknown>,
    home: plan.home_lat === null || plan.home_lon === null
      ? null
      : { lat: plan.home_lat, lon: plan.home_lon, label: plan.home_label },
    travellers: travellers.map((t) => ({
      label: t.label,
      birthDate: t.birth_date,
      shortWalks: t.short_walks,
      getsAbout: t.gets_about === "wheelchair" || t.gets_about === "pram" ? t.gets_about : "foot",
    })),
    hiddenSpots: hidden.map((h) => ({ osmRef: h.osm_ref, name: h.name })),
    segments: segments.map((s) => ({
      fromRef: s.from_ref,
      toRef: s.to_ref,
      mode: s.mode,
      minutes: s.minutes,
      distanceM: s.distance_m,
    })),
    legs: legs.map(exportLeg),
  };

  return { format: TRIP_FORMAT, version: EXCHANGE_VERSION, exportedAt: now.toISOString(), trip };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Write a checked trip file as a new plan owned by `ownerId`. */
export async function importTrip(file: TripFile, ownerId: number, title?: string): Promise<number> {
  const trip = file.trip;
  return await db.transaction(async (tx) => {
    const [plan] = await tx.insert(tripPlans).values({
      owner_id: ownerId,
      title: title?.trim() || trip.title,
      constraints: trip.constraints,
      home_lat: trip.home?.lat ?? null,
      home_lon: trip.home?.lon ?? null,
      home_label: trip.home?.label ?? null,
    }).returning({ id: tripPlans.id });

    for (const [position, leg] of trip.legs.entries()) {
      await importLeg(tx, plan.id, position, leg);
    }

    if (trip.travellers.length > 0) {
      await tx.insert(tripPlanTravellers).values(trip.travellers.map((t) => ({
        plan_id: plan.id,
        label: t.label,
        birth_date: t.birthDate,
        short_walks: t.shortWalks,
        gets_about: t.getsAbout,
        added_by: ownerId,
      })));
    }
    const hidden = uniqueBy(trip.hiddenSpots, (h) => h.osmRef);
    if (hidden.length > 0) {
      await tx.insert(tripHiddenSpots).values(hidden.map((h) => ({
        plan_id: plan.id,
        osm_ref: h.osmRef,
        name: h.name,
        hidden_by: ownerId,
      })));
    }
    const segments = uniqueBy(trip.segments, (s) => `${s.fromRef}\u0000${s.toRef}`);
    if (segments.length > 0) {
      await tx.insert(tripPlanSegments).values(segments.map((s) => ({
        plan_id: plan.id,
        from_ref: s.fromRef,
        to_ref: s.toRef,
        mode: s.mode,
        minutes: s.minutes,
        distance_m: s.distanceM,
      })));
    }
    return plan.id;
  });
}

/** The first of each key; a unique index would refuse the rest. */
function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function importLeg(tx: Tx, planId: number, position: number, leg: ExchangeLeg): Promise<void> {
  const [row] = await tx.insert(tripPlanLegs).values({
    plan_id: planId,
    position,
    title: leg.title,
    kind: leg.kind,
    anchor_lat: leg.anchor.lat,
    anchor_lon: leg.anchor.lon,
    anchor_radius_m: leg.anchor.radiusM,
    anchor_label: leg.anchor.label,
    arrive_minutes: leg.arriveMinutes,
    origin_lat: leg.origin?.lat ?? null,
    origin_lon: leg.origin?.lon ?? null,
    origin_label: leg.origin?.label ?? null,
    depart_minutes: leg.departMinutes,
    end_minutes: leg.endMinutes,
    mode: leg.mode,
    region_db: leg.regionDb,
    awaiting_region: leg.awaitingRegion,
    quarters_aboard: leg.quartersAboard,
    tender_port: leg.tenderPort,
    departure_note: leg.departureNote,
    arrival_note: leg.arrivalNote,
    start_date: leg.startDate,
    radius_m: leg.radiusM,
    day_starts_at: leg.dayStartsAt,
  }).returning({ id: tripPlanLegs.id });

  for (const [dayIndex, day] of leg.days.entries()) {
    await importDay(tx, row.id, dayIndex, day);
  }

  if (leg.pool.length > 0) {
    await tx.insert(tripPlanPool).values(leg.pool.map((p) => ({
      leg_id: row.id,
      osm_ref: p.osmRef,
      name: p.name,
      local_name: p.localName,
      lat: p.lat,
      lon: p.lon,
      category: p.category,
      kind: p.kind,
      dwell_minutes: p.dwellMinutes,
      note: p.note,
      source_url: p.sourceUrl,
      wikipedia_url: p.wikipediaUrl,
      facade_azimuth: p.facadeAzimuth,
      extent: p.extent as SpotExtentColumn | null,
      origin: p.origin,
      priority: p.priority,
      opening_hours: p.openingHours,
      score: p.score,
      priority_boost: p.priorityBoost,
      unmatched: p.unmatched,
      reasons: p.reasons,
      search_score: p.searchScore,
    })));
  }
  const notes = uniqueBy(leg.spotNotes, (n) => n.osmRef);
  if (notes.length > 0) {
    await tx.insert(tripSpotNotes).values(notes.map((n) => ({
      leg_id: row.id,
      osm_ref: n.osmRef,
      title: n.title,
      note: n.note,
      url: n.url,
      dwell_minutes: n.dwellMinutes,
      photo_stop: n.photoStop,
    })));
  }
  const dismissed = uniqueBy(leg.dismissedDayTrips, (d) => d.targetKey);
  if (dismissed.length > 0) {
    await tx.insert(tripPlanDayTripDismissals).values(dismissed.map((d) => ({
      leg_id: row.id,
      target_key: d.targetKey,
      name: d.name,
    })));
  }
}

async function importDay(tx: Tx, legId: number, dayIndex: number, day: ExchangeDay): Promise<void> {
  const [row] = await tx.insert(tripPlanDays).values({
    leg_id: legId,
    day_index: dayIndex,
    detailed: day.detailed,
    buffer_reason: day.bufferReason,
    anchor_lat: day.anchor?.lat ?? null,
    anchor_lon: day.anchor?.lon ?? null,
    anchor_label: day.anchor?.label ?? null,
    anchor_radius_m: day.anchor?.radiusM ?? null,
    anchor_depart_minutes: day.anchor?.departMinutes ?? null,
    anchor_return_minutes: day.anchor?.returnMinutes ?? null,
    anchor_water_detour_m: day.anchor?.waterDetourM ?? null,
    anchor_water_around: day.anchor?.waterAround ?? null,
    breaks: day.breaks,
    excursions: day.excursions,
  }).returning({ id: tripPlanDays.id });

  if (day.fixpoints.length > 0) {
    await tx.insert(tripPlanFixpoints).values(day.fixpoints.map((f) => ({
      day_id: row.id,
      kind: f.kind,
      label: f.label,
      start_minutes: f.startMinutes,
      duration_minutes: f.durationMinutes,
      travel_minutes: f.travelMinutes,
      buffer_minutes: f.bufferMinutes,
      lat: f.lat,
      lon: f.lon,
      block_id: f.blockId,
      spot_ref: f.spotRef,
      pin_reason: f.pinReason,
    })));
  }

  for (const [position, block] of day.blocks.entries()) {
    const [b] = await tx.insert(tripPlanBlocks).values({
      day_id: row.id,
      position,
      template_id: block.templateId,
      label: block.label,
      kind: block.kind,
      budget_minutes: block.budgetMinutes,
      start_minutes: block.startMinutes,
    }).returning({ id: tripPlanBlocks.id });
    if (block.stops.length === 0) continue;
    await tx.insert(tripPlanStops).values(block.stops.map((s, stopPosition) => ({
      block_id: b.id,
      position: stopPosition,
      osm_ref: s.osmRef,
      name: s.name,
      local_name: s.localName,
      lat: s.lat,
      lon: s.lon,
      category: s.category,
      kind: s.kind,
      dwell_minutes: s.dwellMinutes,
      travel_minutes: s.travelMinutes,
      travel_distance_m: s.travelDistanceM,
      status: s.status,
      pinned: s.pinned,
      done_at: s.status === "done" ? s.doneAt : null,
      origin: s.origin,
      note: s.note,
      source_url: s.sourceUrl,
      priority: s.priority,
      opening_hours: s.openingHours,
      wikipedia_url: s.wikipediaUrl,
      facade_azimuth: s.facadeAzimuth,
      extent: s.extent as SpotExtentColumn | null,
      reasons: s.reasons,
      placed_by: s.placedBy,
    })));
  }
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export async function exportIdeas(ownerId: number, now: Date = new Date()): Promise<IdeasFile> {
  const rows = await db.select().from(ideaPool)
    .where(eq(ideaPool.owner_id, ownerId)).orderBy(asc(ideaPool.id));
  const ideas: ExchangeIdea[] = rows.map((i) => ({
    osmRef: i.osm_ref,
    name: i.name,
    title: i.title,
    localName: i.local_name,
    lat: i.lat,
    lon: i.lon,
    category: i.category,
    kind: i.kind,
    dwellMinutes: i.dwell_minutes,
    note: i.note,
    sourceUrl: i.source_url,
    wikipediaUrl: i.wikipedia_url,
    facadeAzimuth: i.facade_azimuth,
    extent: null,
    unmatched: i.unmatched,
    photoStop: i.photo_stop,
    validFrom: i.valid_from,
    validTo: i.valid_to,
  }));
  return { format: IDEAS_FORMAT, version: EXCHANGE_VERSION, exportedAt: now.toISOString(), ideas };
}

export interface IdeasImportResult {
  added: number;
  /** Places the collection already had, by OSM reference. Left as they were. */
  skipped: number;
}

export async function importIdeas(file: IdeasFile, ownerId: number, userId: number): Promise<IdeasImportResult> {
  const fresh = uniqueBy(file.ideas, (i) => i.osmRef);
  if (fresh.length === 0) return { added: 0, skipped: file.ideas.length };
  const existing = new Set((await db.select({ ref: ideaPool.osm_ref }).from(ideaPool)
    .where(and(eq(ideaPool.owner_id, ownerId), inArray(ideaPool.osm_ref, fresh.map((i) => i.osmRef)))))
    .map((r) => r.ref));
  const toAdd = fresh.filter((i) => !existing.has(i.osmRef));
  if (toAdd.length > 0) {
    // In chunks: ten thousand rows of eighteen columns is past what one
    // statement may bind.
    for (let i = 0; i < toAdd.length; i += 500) {
      await db.insert(ideaPool).values(toAdd.slice(i, i + 500).map((idea) => ({
        owner_id: ownerId,
        created_by: userId,
        osm_ref: idea.osmRef,
        name: idea.name,
        title: idea.title,
        local_name: idea.localName,
        lat: idea.lat,
        lon: idea.lon,
        category: idea.category,
        kind: idea.kind,
        dwell_minutes: idea.dwellMinutes,
        note: idea.note,
        source_url: idea.sourceUrl,
        wikipedia_url: idea.wikipediaUrl,
        facade_azimuth: idea.facadeAzimuth,
        unmatched: idea.unmatched,
        photo_stop: idea.photoStop,
        valid_from: idea.validFrom,
        valid_to: idea.validTo,
      }))).onConflictDoNothing();
    }
  }
  return { added: toAdd.length, skipped: file.ideas.length - toAdd.length };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** A file that does not fit, as one sentence naming where. */
function refuse(error: unknown): never {
  if (error instanceof ExchangeFileError) {
    throw APIError.invalidArgument(`Die Datei passt nicht: ${error.message}`)
      .withDetails({ problems: error.problems });
  }
  throw error;
}

export const exportTripPlan = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/export", auth: true },
  async ({ planId }: { planId: number }): Promise<TripFile> => {
    const userId = requireUser();
    if (!(await isOnTrip(planId, userId))) throw APIError.notFound("plan not found");
    const file = await exportTrip(planId);
    if (!file) throw APIError.notFound("plan not found");
    return file;
  },
);

export interface ImportTripRequest {
  /** The exported file, exactly as written by `GET …/export`. */
  data: Record<string, unknown>;
  /** A name for the new trip instead of the one in the file. */
  title?: string;
}

export interface ImportTripResponse {
  planId: number;
  title: string | null;
}

export const importTripPlan = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/import", auth: true },
  async (req: ImportTripRequest): Promise<ImportTripResponse> => {
    const userId = requireUser();
    let file: TripFile;
    try {
      file = readTripFile(req.data);
    } catch (error) {
      refuse(error);
    }
    const planId = await importTrip(file, userId, req.title);
    const [row] = await db.select({ title: tripPlans.title }).from(tripPlans).where(eq(tripPlans.id, planId));
    return { planId, title: row?.title ?? null };
  },
);

export interface ExportIdeasRequest {
  /** Whose collection. Your own by default; a shared one may be named. */
  ownerId?: number;
}

export const exportIdeaCollection = api(
  { expose: true, method: "GET", path: "/trip-planner/ideas/export", auth: true },
  async (req: ExportIdeasRequest): Promise<IdeasFile> => {
    const userId = requireUser();
    const ownerId = req.ownerId === undefined ? userId : await requireAccess(req.ownerId, userId);
    return await exportIdeas(ownerId);
  },
);

export interface ImportIdeasRequest {
  /** The exported file, exactly as written by `GET /trip-planner/ideas/export`. */
  data: Record<string, unknown>;
  /** Into whose collection. Your own by default. */
  ownerId?: number;
}

export const importIdeaCollection = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/import", auth: true },
  async (req: ImportIdeasRequest): Promise<IdeasImportResult> => {
    const userId = requireUser();
    const ownerId = req.ownerId === undefined ? userId : await requireAccess(req.ownerId, userId);
    let file: IdeasFile;
    try {
      file = readIdeasFile(req.data);
    } catch (error) {
      refuse(error);
    }
    return await importIdeas(file, ownerId, userId);
  },
);
