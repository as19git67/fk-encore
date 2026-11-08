/**
 * The itinerary: a trip as one chain of stays and journeys
 * (documentation/plans/reiseverlauf.md, stage 1).
 *
 * Five endpoints used to write the same four columns — `POST /legs`,
 * `PATCH /legs/:i`, `POST /transits`, `PATCH /transits/:i` (all four
 * gone since stage 4) and `PATCH /settings` — and only one of them
 * moved the neighbours along. A city whose length changed left its journey where
 * it was, and the two drifted apart. Here every fact has one owner:
 *
 *   - a **stay** owns its place, its lodging, its length in days and
 *     its mode on site; no date, no time;
 *   - a **journey** owns its departure time, its arrival time, its mode
 *     and the nights on the way; no date;
 *   - the **trip** owns one date, its first day.
 *
 * Every other date is derived, deterministically, by `deriveFrames`:
 * a stay runs from the cursor over its days, the journey after it
 * leaves on that last day and arrives `nights` days later, and the next
 * stay starts there. The arrival day is shared, as §22.7 has always had
 * it. What the chain is written back as is exactly what the rest of the
 * planner already understands — `startDate` and `days` on the leg, a
 * `departure` fixpoint on the last day, `arriveMinutes` on the first,
 * and a transit leg for a journey that knows both of its times.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { tripPlanOps, tripPlanPool } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { isJourneyDeparture, journeyDeparture } from "./aboard";
import { addDays, daysBetween, isCalendarDate } from "./leg-dates";
import { requireOrganiser } from "./plan-access";
import {
  insertLeg,
  loadPlan,
  removeLeg,
  replanPlan,
  setLegPositions,
  setLegsAwaitingRegion,
  updateLegFrames,
  updateLegPlace,
  updateTransitLeg,
  type CreateDayInput,
  type PlanHome,
  type StoredLeg,
  type StoredPlan,
} from "./plan-store";
import {
  legRequestFromStored,
  planLegForTrip,
  validateMode,
  type DroppedBlockReport,
  type FixpointRequest,
  type LegRequest,
  type PendingRegionReport,
  type PlanResponse,
} from "./plans";
import { minutesOf } from "./transit-leg";
import { carryStops } from "./carry-stops";
import { isIdeasTrip } from "./ideas-mode";
import type { TransportMode } from "./travel";

/** Mirrors `plans.ts`: counted in stays, the journeys are free. */
const MAX_STAYS = 20;
/** Mirrors `plans.ts`: a stay longer than this is two stays. */
const MAX_STAY_DAYS = 14;
/** A journey longer than this is a stay of its own. */
const MAX_JOURNEY_NIGHTS = 6;
/** How many days of a newly added stay are planned down to spots (§4.3). */
const DEFAULT_DETAIL_DAYS = 2;

/**
 * One link of the chain. `kind` says which fields are read: a stay has
 * a place and days, a journey has times and nights. One type for both
 * rather than a union, so the request schema stays a plain object.
 */
export interface ItineraryItem {
  kind: "stay" | "journey";
  /**
   * The leg this item already is, when it is one: a stay keeps its
   * days, pool and votes across a move by keeping its id; a journey
   * keeps its row. Absent for a new item.
   */
  legId?: number;
  /** What to call it — the city, or the journey's own name. */
  title?: string | null;

  // Stay
  /** Where every day starts and ends. With `anchorRadiusM`, its centroid. */
  anchor?: { lat: number; lon: number };
  /** What the base is called — the hotel, not the city (§4.2). */
  anchorLabel?: string | null;
  /** Set while nothing is booked and the base is only a zone (§4.2). */
  anchorRadiusM?: number | null;
  /** How the group gets around on site; for a journey, how it travels. */
  mode?: TransportMode;
  /** How long the stay lasts. The departure day counts: three nights are four days. */
  days?: number;
  /** Search radius around the anchor; absent for the planner default. */
  radiusM?: number | null;
  /** The quarters travel along (§21.3): a cruise, a houseboat. */
  quartersAboard?: boolean;
  tenderPort?: boolean;

  // Journey
  /** When it sets off, as "HH:MM"; null or absent while nobody knows. */
  departAt?: string | null;
  /**
   * When it arrives, as "HH:MM". On the first stay this is read too,
   * when no journey leads into it: how the group reached the first
   * city is not the plan's business, but when they get there is.
   */
  arriveAt?: string | null;
  /** Calendar days between setting off and arriving. Zero by default. */
  nights?: number;
}

/** An item as the trip reads it back: with the dates the chain gives it. */
export interface ItineraryItemView extends ItineraryItem {
  /** First and last calendar day, or null while the trip has no date. */
  startDate: string | null;
  endDate: string | null;
}

export interface ItineraryResponse {
  planId: number;
  /** The one date of the trip: the first item's first day, or null. */
  startDate: string | null;
  /** Where the trip sets off from and returns to, or null while nobody said. */
  home: PlanHome | null;
  items: ItineraryItemView[];
}

export interface GetItineraryRequest {
  planId: number;
}

export const getTripItinerary = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/itinerary", auth: true },
  async (req: GetItineraryRequest): Promise<ItineraryResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return itineraryResponse(plan);
  },
);

export interface PutItineraryRequest {
  planId: number;
  /** The trip's first day as YYYY-MM-DD, or null to take the dates off. */
  startDate: string | null;
  /** The whole chain, stays and journeys alternating. */
  items: ItineraryItem[];
}

/**
 * Write the whole chain.
 *
 * Nothing is written before everything is planned and every refusal
 * has had its chance: a chain that fails half-way would leave a trip
 * with one city moved and its journey where it was — the very drift
 * this replaces.
 */
export const putTripItinerary = api(
  { expose: true, method: "PUT", path: "/trip-planner/plans/:planId/itinerary", auth: true },
  async (req: PutItineraryRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Den Reiseverlauf");

    const before = itineraryOf(plan);
    const { planned, rebuilt } = await applyChain(plan, { startDate: req.startDate, items: req.items });
    // A change that rebuilt days somebody had planned can be taken back
    // (plan, "Decisions taken": shortening a stay is allowed, with an
    // undo). One that only moved dates rebuilt nothing worth keeping.
    const worthKeeping = rebuilt.filter(hasStops);
    if (worthKeeping.length > 0) {
      await journalItineraryChange(plan.id, userId, {
        startDate: before.startDate,
        items: before.items,
        days: Object.fromEntries(worthKeeping.map((leg) => [String(leg.id), leg.days.map(dayInputOf)])),
      }, changeSentence(plan, worthKeeping, req.items));
    }

    const updated = await loadPlan(req.planId, userId);
    if (!updated) throw APIError.internal("plan vanished while it was being written");
    return {
      plan: updated,
      droppedBlocks: planned.dropped,
      pendingRegions: planned.pending,
    };
  },
);

// MARK: - Taking a change back

/** The journal's name for a change of the itinerary (`trip_plan_ops.kind`). */
export const ITINERARY_OP = "itinerary";

/** The journal line an undo of an itinerary change leaves. */
export const ITINERARY_UNDO_OP = "itinerary-undo";

/**
 * What a change of the itinerary replaced, so it can be taken back:
 * the chain as it was, and the days of every stay the change rebuilt,
 * by the leg id those stays had then.
 */
export interface ItinerarySnapshot {
  startDate: string | null;
  items: ItineraryItem[];
  days: Record<string, CreateDayInput[]>;
}

/**
 * Put the itinerary back the way a snapshot says, days included.
 *
 * The chain is written as any other change is, and then every stay the
 * snapshot knows gets its old days back instead of freshly planned
 * ones: the stops, their order, the fixed times and day trips, so the
 * undo is the trip it was and not a similar one (§6.3). A stay that
 * the change deleted comes back as a new leg with its old days; its
 * votes and notes went with the old row and do not return, which the
 * journal says. A split block comes back together.
 */
export async function restoreItinerary(plan: StoredPlan, snapshot: ItinerarySnapshot): Promise<void> {
  const existing = new Set(plan.legs.map((leg) => leg.id));
  const restore = new Map<ItineraryItem, CreateDayInput[]>();
  const items = snapshot.items.map((item) => {
    const days = item.legId === undefined ? undefined : snapshot.days[String(item.legId)];
    // A leg that no longer exists is a new one now.
    const copy: ItineraryItem = item.legId !== undefined && !existing.has(item.legId)
      ? { ...item, legId: undefined }
      : { ...item };
    if (days && copy.kind === "stay") restore.set(copy, days);
    return copy;
  });
  await applyChain(plan, { startDate: snapshot.startDate, items }, restore);
}

/** Whether somebody has a planned stop on this leg. */
function hasStops(leg: StoredLeg): boolean {
  return leg.days.some((day) => day.blocks.some((block) => block.stops.length > 0));
}

/** A stored day, as the input that writes it again. */
export function dayInputOf(day: StoredLeg["days"][number]): CreateDayInput {
  return {
    detailed: day.detailed,
    bufferReason: day.bufferReason ?? null,
    anchor: day.anchor
      ? {
        lat: day.anchor.lat,
        lon: day.anchor.lon,
        label: day.anchor.label,
        radiusM: day.anchor.radiusM,
        departMinutes: day.anchor.departMinutes,
        returnMinutes: day.anchor.returnMinutes,
        waterDetourM: day.anchor.waterDetourM,
        waterAround: day.anchor.waterAround ?? null,
      }
      : null,
    fixpoints: day.fixpoints.map((fix) => ({
      id: fix.id,
      label: fix.label,
      kind: fix.kind,
      startMinutes: fix.startMinutes,
      durationMinutes: fix.durationMinutes,
      travelMinutes: fix.travelMinutes,
      bufferMinutes: fix.bufferMinutes,
      blockId: fix.blockId,
      spotRef: fix.spotRef,
      lat: fix.lat,
      lon: fix.lon,
    })),
    blocks: day.blocks.map((block) => ({
      id: block.id,
      label: block.label,
      kind: block.kind,
      budgetMinutes: block.budgetMinutes,
      usedMinutes: block.usedMinutes,
      carriedInMinutes: block.carriedInMinutes,
      startMinutes: block.startMinutes ?? undefined,
      stops: block.stops.map((stop) => ({
        osmRef: stop.osmRef,
        name: stop.name,
        localName: stop.localName ?? null,
        wikipediaUrl: stop.wikipediaUrl ?? null,
        facadeAzimuth: stop.facadeAzimuth ?? null,
        kind: stop.kind ?? null,
        origin: stop.origin,
        extent: stop.extent,
        reasons: stop.reasons ?? [],
        lat: stop.lat,
        lon: stop.lon,
        category: stop.category,
        dwellMinutes: stop.dwellMinutes,
        score: stop.score,
        travelFromPrevious: stop.travelFromPrevious,
        pinned: stop.pinned,
      })),
    })),
  };
}

/** The journal line: which stays lost or changed their planned days. */
function changeSentence(plan: StoredPlan, rebuilt: readonly StoredLeg[], items: readonly ItineraryItem[]): string {
  const names = rebuilt.map((leg) => leg.title ?? `Aufenthalt ${leg.position + 1}`);
  const shortened = rebuilt.filter((leg) => {
    const now = items.find((item) => item.legId === leg.id);
    return now === undefined || (now.days ?? leg.days.length) < leg.days.length;
  });
  const list = names.length === 1 ? `„${names[0]}"` : names.map((n) => `„${n}"`).join(", ");
  if (shortened.length > 0) return `Reiseverlauf geändert, ${list} neu geplant (kürzer oder entfernt)`;
  return `Reiseverlauf geändert, ${list} neu geplant`;
}

async function journalItineraryChange(
  planId: number,
  userId: number,
  snapshot: ItinerarySnapshot,
  sentence: string,
): Promise<void> {
  await db.insert(tripPlanOps).values({
    plan_id: planId,
    client_op_id: `itinerary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: ITINERARY_OP,
    payload: { sentence },
    previous: snapshot,
    actor_id: userId,
  });
}

/**
 * Write a chain: derive the frames, plan what changed, write it. With
 * `restore`, the stays it names keep those days instead of new ones.
 * Returns the stays whose days were rebuilt or deleted, as they were.
 */
async function applyChain(
  plan: StoredPlan,
  chain: { startDate: string | null; items: readonly ItineraryItem[] },
  restore?: ReadonlyMap<ItineraryItem, CreateDayInput[]>,
): Promise<{ planned: Planned; rebuilt: StoredLeg[] }> {
  const frames = deriveFrames(chain, { home: plan.home !== null, homeLabel: plan.home?.label ?? "Zuhause" });
  const slots = resolveSlots(plan, frames);
  if (restore) {
    for (const slot of slots.slots) {
      const days = restore.get(slot.frame.item);
      if (!days) continue;
      if (slot.existing && !slot.replan) refuseSettled(slot.existing, "zurückgesetzt");
      slot.replan = true;
    }
  }
  const planned = await planSlots(plan, slots);
  // On a trip of ideas every stop is somebody's choice: a stay planned
  // again keeps them on their days (`carry-stops.ts`).
  if (isIdeasTrip(plan.constraints)) {
    for (const [index, slot] of slots.slots.entries()) {
      const result = planned.legs.get(index);
      if (!result || !slot.replan || !slot.existing || restore?.has(slot.frame.item)) continue;
      const carried = carryStops(slot.existing, result.leg.days, {
        anchor: result.leg.anchor,
        mode: result.leg.mode ?? slot.existing.mode,
      });
      result.leg = { ...result.leg, days: carried.days, pool: [...result.leg.pool, ...carried.back] };
    }
  }
  if (restore) {
    for (const [index, slot] of slots.slots.entries()) {
      const days = restore.get(slot.frame.item);
      const result = planned.legs.get(index);
      if (!days || !result) continue;
      const kept = new Set(days.flatMap((day) => day.blocks.flatMap((block) => block.stops.map((stop) => stop.osmRef))));
      result.leg = {
        ...result.leg,
        days,
        pool: result.leg.pool.filter((candidate) => !kept.has(candidate.osmRef)),
      };
    }
  }
  await writeSlots(plan, slots, planned);
  if (restore) await dropPlannedFromManualPool(plan);

  const rebuilt = [
    ...slots.slots.filter((slot) => slot.replan && slot.existing?.kind === "stay").map((slot) => slot.existing as StoredLeg),
    ...slots.removed.filter((leg) => leg.kind === "stay"),
  ];
  return { planned, rebuilt };
}

/**
 * A find somebody added by hand survives every re-plan in the pool;
 * once its old day is back, it is on the day and must not also wait in
 * the pool.
 */
async function dropPlannedFromManualPool(before: StoredPlan): Promise<void> {
  const plan = await loadPlan(before.id, before.ownerId);
  if (!plan) return;
  for (const leg of plan.legs) {
    const onDays = new Set(leg.days.flatMap((day) => day.blocks.flatMap((block) => block.stops.map((stop) => stop.osmRef))));
    const doubled = leg.pool.filter((candidate) => onDays.has(candidate.osmRef)).map((candidate) => candidate.osmRef);
    if (doubled.length === 0) continue;
    await db.delete(tripPlanPool).where(and(eq(tripPlanPool.leg_id, leg.id), inArray(tripPlanPool.osm_ref, doubled)));
  }
}

// MARK: - Reading the chain

/**
 * The stored legs, read back as the chain.
 *
 * A transit leg is a journey with both times. Two stays with nothing
 * between them get an implicit journey: its arrival is the next stay's
 * `arriveMinutes`, its departure the fixpoint `journeyDeparture` wrote
 * on the previous stay's last day, and its nights are the calendar gap
 * between the two — so a trip written before the chain existed reads
 * back with exactly the dates it has.
 */
export function itineraryOf(plan: Pick<StoredPlan, "legs" | "home">): {
  startDate: string | null;
  items: ItineraryItem[];
} {
  const legs = [...plan.legs].sort((a, b) => a.position - b.position);
  const items: ItineraryItem[] = [];
  let previousStay: StoredLeg | null = null;
  let pendingJourney: StoredLeg | null = null;

  for (const leg of legs) {
    if (leg.kind === "transit") {
      pendingJourney = leg;
      continue;
    }
    if (pendingJourney) {
      items.push(journeyFromTransit(pendingJourney));
    } else if (previousStay) {
      items.push(implicitJourney(previousStay, leg));
    }
    items.push({
      kind: "stay",
      legId: leg.id,
      title: leg.title,
      anchor: leg.anchor,
      anchorLabel: leg.anchorLabel,
      anchorRadiusM: leg.anchorRadiusM,
      mode: leg.mode,
      days: Math.max(1, leg.days.length),
      radiusM: leg.radiusM,
      quartersAboard: leg.quartersAboard,
      tenderPort: leg.tenderPort,
      // The first stay keeps its own arrival only while no journey
      // leads into it; afterwards the journey owns that time.
      arriveAt: items.length === 0 && leg.arriveMinutes !== null ? formatMinutes(leg.arriveMinutes) : undefined,
    });
    previousStay = leg;
    pendingJourney = null;
  }
  if (pendingJourney) items.push(journeyFromTransit(pendingJourney));

  return { startDate: legs[0]?.startDate ?? null, items };
}

function journeyFromTransit(leg: StoredLeg): ItineraryItem {
  return {
    kind: "journey",
    legId: leg.id,
    title: leg.title,
    departAt: leg.departMinutes === null ? null : formatMinutes(leg.departMinutes),
    arriveAt: leg.endMinutes === null ? null : formatMinutes(leg.endMinutes),
    nights: Math.max(0, leg.days.length - 1),
    mode: leg.mode,
  };
}

function implicitJourney(previous: StoredLeg, next: StoredLeg): ItineraryItem {
  const departure = journeyDepartureOf(previous);
  const nights = previous.startDate && next.startDate
    ? Math.max(0, daysBetween(addDays(previous.startDate, Math.max(1, previous.days.length) - 1), next.startDate))
    : 0;
  return {
    kind: "journey",
    departAt: departure === null ? null : formatMinutes(departure.startMinutes),
    arriveAt: next.arriveMinutes === null ? null : formatMinutes(next.arriveMinutes),
    nights,
  };
}

/** The departure a journey wrote on this stay's last day, if any. */
function journeyDepartureOf(leg: StoredLeg): { startMinutes: number; label: string } | null {
  const lastDay = leg.days.find((d) => d.dayIndex === leg.days.length - 1);
  const fix = lastDay?.fixpoints.find((f) => isJourneyDeparture(f, leg.anchor));
  return fix ? { startMinutes: fix.startMinutes, label: fix.label } : null;
}

function itineraryResponse(plan: StoredPlan): ItineraryResponse {
  const chain = itineraryOf(plan);
  const frames = deriveFrames(chain, { home: plan.home !== null, homeLabel: plan.home?.label ?? "Zuhause" });
  return {
    planId: plan.id,
    startDate: chain.startDate,
    home: plan.home,
    items: chain.items.map((item, index) => ({
      ...item,
      startDate: frames[index].startDate,
      endDate: frames[index].endDate,
    })),
  };
}

// MARK: - Deriving the frames

/** A stay, with everything the chain decides for it. */
export interface StayFrame {
  kind: "stay";
  item: ItineraryItem;
  startDate: string | null;
  endDate: string | null;
  days: number;
  /** When the group gets there: the journey before, or the stay's own. */
  arriveMinutes: number | null;
  /** The departure on its last day, when the journey after knows it. */
  departure: { at: string; nextTitle: string } | null;
}

/** A journey, with everything the chain decides for it. */
export interface JourneyFrame {
  kind: "journey";
  item: ItineraryItem;
  startDate: string | null;
  endDate: string | null;
  /** nights + 1: the days the transit leg spans. */
  days: number;
  departMinutes: number | null;
  endMinutes: number | null;
  /** Both times known: this journey is a transit leg of its own. */
  timed: boolean;
  /** Index of the stay it leaves, or null for home. */
  from: number | null;
  /** Index of the stay it reaches, or null for home. */
  to: number | null;
}

export type ItineraryFrame = StayFrame | JourneyFrame;

/**
 * What the chain says about every item: pure, and the same answer for
 * the same chain every time. Refuses a chain that is not one — two
 * stays side by side, a journey from nowhere, a stay without days.
 */
export function deriveFrames(
  chain: { startDate: string | null; items: readonly ItineraryItem[] },
  options: { home: boolean; homeLabel: string },
): ItineraryFrame[] {
  const items = chain.items;
  if (chain.startDate !== null && !isCalendarDate(chain.startDate)) {
    throw APIError.invalidArgument(`startDate must be YYYY-MM-DD, got '${chain.startDate}'`);
  }
  if (!items.some((i) => i.kind === "stay")) {
    throw APIError.invalidArgument("eine Reise hat mindestens einen Aufenthalt");
  }
  for (const [index, item] of items.entries()) {
    if (item.kind !== "stay" && item.kind !== "journey") {
      throw APIError.invalidArgument(`items[${index}].kind must be stay or journey`);
    }
    const previous = items[index - 1];
    if (previous && previous.kind === item.kind) {
      throw APIError.invalidArgument(
        item.kind === "stay"
          ? `items[${index}]: zwischen zwei Aufenthalten steht eine Weiterreise`
          : `items[${index}]: zwei Weiterreisen hintereinander — dazwischen fehlt der Aufenthalt`,
      );
    }
  }
  if ((items[0].kind === "journey" || items[items.length - 1].kind === "journey") && !options.home) {
    throw APIError.invalidArgument(
      "für die Anreise und die Heimreise muss die Reise wissen, wo Zuhause ist",
    );
  }

  const frames: ItineraryFrame[] = [];
  let cursor = chain.startDate;
  for (const [index, item] of items.entries()) {
    if (item.kind === "stay") {
      const days = validateStayDays(item.days, index);
      if (!item.anchor) throw APIError.invalidArgument(`items[${index}]: ein Aufenthalt braucht einen Ort`);
      const before = items[index - 1];
      const after = items[index + 1];
      const arriveMinutes = before
        ? timeOf(before.arriveAt, `items[${index - 1}].arriveAt`)
        : timeOf(item.arriveAt, `items[${index}].arriveAt`);
      const departAt = after ? timeOf(after.departAt, `items[${index + 1}].departAt`) : null;
      const endDate = cursor ? addDays(cursor, days - 1) : null;
      frames.push({
        kind: "stay",
        item,
        startDate: cursor,
        endDate,
        days,
        arriveMinutes,
        departure: departAt === null
          ? null
          : { at: formatMinutes(departAt), nextTitle: stayTitle(items[index + 2], index + 2, options.homeLabel) },
      });
      cursor = endDate;
    } else {
      const nights = validateNights(item.nights, index);
      const departMinutes = timeOf(item.departAt, `items[${index}].departAt`);
      const endMinutes = timeOf(item.arriveAt, `items[${index}].arriveAt`);
      if (nights === 0 && departMinutes !== null && endMinutes !== null && endMinutes <= departMinutes) {
        throw APIError.invalidArgument(`items[${index}]: die Ankunft muss nach der Abfahrt liegen`);
      }
      const endDate = cursor ? addDays(cursor, nights) : null;
      frames.push({
        kind: "journey",
        item,
        startDate: cursor,
        endDate,
        days: nights + 1,
        departMinutes,
        endMinutes,
        timed: departMinutes !== null && endMinutes !== null,
        from: index === 0 ? null : index - 1,
        to: index === items.length - 1 ? null : index + 1,
      });
      cursor = endDate;
    }
  }
  return frames;
}

function stayTitle(item: ItineraryItem | undefined, index: number, homeLabel: string): string {
  if (!item) return homeLabel;
  return item.title?.trim() || item.anchorLabel?.trim() || `Aufenthalt ${index + 1}`;
}

function validateStayDays(days: number | undefined, index: number): number {
  if (days === undefined || !Number.isInteger(days) || days < 1) {
    throw APIError.invalidArgument(`items[${index}].days must be a whole number of at least 1`);
  }
  if (days > MAX_STAY_DAYS) {
    throw APIError.invalidArgument(`items[${index}].days may be at most ${MAX_STAY_DAYS}`);
  }
  return days;
}

function validateNights(nights: number | undefined, index: number): number {
  if (nights === undefined) return 0;
  if (!Number.isInteger(nights) || nights < 0) {
    throw APIError.invalidArgument(`items[${index}].nights must be a whole number of at least 0`);
  }
  if (nights > MAX_JOURNEY_NIGHTS) {
    throw APIError.invalidArgument(
      `eine Weiterreise dauert höchstens ${MAX_JOURNEY_NIGHTS + 1} Tage — länger ist es ein eigener Aufenthalt`,
    );
  }
  return nights;
}

function timeOf(text: string | null | undefined, label: string): number | null {
  if (text === null || text === undefined) return null;
  const minutes = minutesOf(text);
  if (minutes === null) throw APIError.invalidArgument(`${label} must be HH:MM, got '${text}'`);
  return minutes;
}

/** Minutes past midnight back to the "HH:MM" the request types use. */
function formatMinutes(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// MARK: - Matching the chain to the stored legs

/** One leg the plan will have, in order: a stay, or a journey with both times. */
interface Slot {
  frame: ItineraryFrame;
  /** The row it already is, or null for a new leg. */
  existing: StoredLeg | null;
  /** Whether its days are planned again; a new leg always is. */
  replan: boolean;
  request: LegRequest;
}

interface Resolved {
  slots: Slot[];
  removed: StoredLeg[];
}

function resolveSlots(plan: StoredPlan, frames: readonly ItineraryFrame[]): Resolved {
  const stays = frames.filter((f): f is StayFrame => f.kind === "stay");
  if (stays.length > MAX_STAYS) {
    throw APIError.failedPrecondition(
      `eine Reise hat höchstens ${MAX_STAYS} Aufenthalte — das ist ein Leben, keine Reise`,
    );
  }
  const byId = new Map(plan.legs.map((l) => [l.id, l]));
  const seen = new Set<number>();
  const existingOf = (frame: ItineraryFrame, kind: StoredLeg["kind"]): StoredLeg | null => {
    const id = frame.item.legId;
    if (id === undefined) return null;
    const leg = byId.get(id);
    if (!leg || leg.kind !== kind) {
      throw APIError.invalidArgument(`legId ${id} ist ${kind === "stay" ? "kein Aufenthalt" : "keine Weiterreise"} dieser Reise`);
    }
    if (seen.has(id)) throw APIError.invalidArgument(`legId ${id} kommt zweimal vor`);
    seen.add(id);
    return leg;
  };

  const homeLabel = plan.home?.label ?? "Zuhause";
  const slots: Slot[] = [];
  for (const frame of frames) {
    if (frame.kind === "stay") {
      const existing = existingOf(frame, "stay");
      const request = stayRequest(frame, existing);
      slots.push({ frame, existing, request, replan: existing === null || stayReplans(frame, existing, request) });
    } else {
      // A journey without both of its times writes only onto its
      // neighbours; its row, if it had one, goes.
      const existing = existingOf(frame, "transit");
      if (!frame.timed) continue;
      const request = journeyRequest(frame, frames, plan.home, homeLabel);
      slots.push({ frame, existing, request, replan: existing === null || journeyReplans(frame, existing, request) });
    }
  }
  const removed = plan.legs.filter((l) => !slots.some((s) => s.existing?.id === l.id));

  // Nothing here touches a day somebody has begun (§6.2).
  for (const leg of removed) refuseSettled(leg, "gelöscht");
  for (const slot of slots) {
    if (slot.existing && slot.replan) refuseSettled(slot.existing, "neu geplant");
  }
  return { slots, removed };
}

/** The stay as it will be, in the shape `planLeg` takes. */
function stayRequest(frame: StayFrame, existing: StoredLeg | null): LegRequest {
  const item = frame.item;
  const anchor = item.anchor as { lat: number; lon: number };
  const base: Partial<LegRequest> = existing ? legRequestFromStored(existing) : {};
  const quartersAboard = item.quartersAboard ?? existing?.quartersAboard ?? false;
  const tenderPort = item.tenderPort ?? existing?.tenderPort ?? false;
  const lastDay = frame.days - 1;
  const departure: FixpointRequest[] = frame.departure
    ? [journeyDeparture({ anchor, quartersAboard, tenderPort }, frame.departure.nextTitle, frame.departure.at, lastDay)]
    : [];
  return {
    ...base,
    title: (item.title === undefined ? existing?.title : item.title?.trim() || null) ?? undefined,
    anchor,
    anchorLabel: (item.anchorLabel === undefined ? existing?.anchorLabel : item.anchorLabel?.trim() || null) ?? undefined,
    anchorRadiusM: (item.anchorRadiusM === undefined ? existing?.anchorRadiusM : item.anchorRadiusM) ?? undefined,
    mode: validateMode(item.mode ?? existing?.mode),
    quartersAboard,
    tenderPort,
    days: frame.days,
    radiusM: (item.radiusM === undefined ? existing?.radiusM : item.radiusM) ?? undefined,
    startDate: frame.startDate ?? undefined,
    transfer: frame.arriveMinutes === null ? undefined : { arriveAt: formatMinutes(frame.arriveMinutes) },
    // Fixpoints belong to days a stay still has, and the one departure
    // a journey writes is written again from the chain, never kept.
    fixpoints: [
      ...(base.fixpoints ?? []).filter((f) => f.dayIndex < frame.days && !(existing && isJourneyDeparture(f, existing.anchor))),
      ...departure,
    ],
    dayAnchors: (base.dayAnchors ?? []).filter((a) => a.dayIndex < frame.days),
  };
}

/**
 * Does this change what the stay's days can hold? Moving the anchor,
 * the mode, the length, the radius, the arrival or the departure does;
 * a new date or a new name does not (§4.4).
 */
function stayReplans(frame: StayFrame, existing: StoredLeg, request: LegRequest): boolean {
  const anchor = request.anchor;
  if (anchor.lat !== existing.anchor.lat || anchor.lon !== existing.anchor.lon) return true;
  if ((request.anchorRadiusM ?? null) !== existing.anchorRadiusM) return true;
  if (request.mode !== existing.mode) return true;
  if (frame.days !== existing.days.length) return true;
  if ((request.radiusM ?? null) !== existing.radiusM) return true;
  if (frame.arriveMinutes !== existing.arriveMinutes) return true;
  // The departure is compared by time and by name: "Weiterreise nach"
  // names the stay it goes to, and that stay may be another one now.
  const stored = journeyDepartureOf(existing);
  const wanted = request.fixpoints?.find((f) => f.kind === "departure" && isJourneyDeparture(f, anchor)) ?? null;
  if ((stored?.startMinutes ?? null) !== (wanted ? minutesOf(wanted.at) : null)) return true;
  if ((stored?.label ?? null) !== (wanted?.label ?? null)) return true;
  if ((request.quartersAboard ?? false) !== existing.quartersAboard && frame.departure) return true;
  if ((request.tenderPort ?? false) !== existing.tenderPort && frame.departure) return true;
  return false;
}

/** The journey as a transit leg, between the two anchors it connects. */
function journeyRequest(
  frame: JourneyFrame,
  frames: readonly ItineraryFrame[],
  home: PlanHome | null,
  homeLabel: string,
): LegRequest {
  const previous = frame.from === null ? null : frames[frame.from] as StayFrame;
  const next = frame.to === null ? null : frames[frame.to] as StayFrame;
  if ((!previous || !next) && !home) throw APIError.internal("a journey to or from home needs a home");
  const previousTitle = previous ? stayTitle(previous.item, frame.from as number, homeLabel) : homeLabel;
  const nextTitle = next ? stayTitle(next.item, frame.to as number, homeLabel) : homeLabel;
  const mode = validateMode(frame.item.mode ?? next?.item.mode ?? previous?.item.mode);
  const title = frame.item.title?.trim()
    || (!previous ? `Anreise nach ${nextTitle}`
      : !next ? `Heimreise von ${previousTitle}`
        // The sea between two ports (§21.3): the day happens aboard.
        : mode === "ship" ? `An Bord nach ${nextTitle}`
          : `Weiterreise nach ${nextTitle}`);
  const origin = previous
    ? {
      lat: (previous.item.anchor as { lat: number; lon: number }).lat,
      lon: (previous.item.anchor as { lat: number; lon: number }).lon,
      label: previous.item.anchorLabel?.trim() || previous.item.title?.trim() || null,
    }
    : { lat: (home as PlanHome).lat, lon: (home as PlanHome).lon, label: homeLabel };
  const destination = next
    ? {
      anchor: next.item.anchor as { lat: number; lon: number },
      label: next.item.anchorLabel?.trim() || next.item.title?.trim() || null,
    }
    : { anchor: { lat: (home as PlanHome).lat, lon: (home as PlanHome).lon }, label: homeLabel };
  return {
    kind: "transit",
    title,
    anchor: destination.anchor,
    anchorLabel: destination.label ?? undefined,
    origin,
    mode,
    days: frame.days,
    startDate: frame.startDate ?? undefined,
    transit: {
      departAt: formatMinutes(frame.departMinutes as number),
      arriveAt: formatMinutes(frame.endMinutes as number),
    },
  };
}

function journeyReplans(frame: JourneyFrame, existing: StoredLeg, request: LegRequest): boolean {
  if ((frame.startDate ?? null) !== existing.startDate) return true;
  if (frame.days !== existing.days.length) return true;
  if (frame.departMinutes !== existing.departMinutes || frame.endMinutes !== existing.endMinutes) return true;
  if (request.mode !== existing.mode) return true;
  if ((request.title ?? null) !== existing.title) return true;
  const origin = request.origin as { lat: number; lon: number };
  if (origin.lat !== existing.origin?.lat || origin.lon !== existing.origin?.lon) return true;
  if (request.anchor.lat !== existing.anchor.lat || request.anchor.lon !== existing.anchor.lon) return true;
  return false;
}

function refuseSettled(leg: StoredLeg, verb: string): void {
  const settled = firstSettledStop(leg);
  if (settled) {
    throw APIError.failedPrecondition(
      `„${settled}" auf „${leg.title ?? `Aufenthalt ${leg.position + 1}`}" ist schon abgehakt — `
        + `ein begonnener Aufenthalt wird nicht ${verb}`,
    );
  }
}

function firstSettledStop(leg: StoredLeg): string | null {
  for (const day of leg.days) {
    for (const block of day.blocks) {
      for (const stop of block.stops) {
        if (stop.status !== "planned") return stop.name ?? stop.osmRef;
      }
    }
  }
  return null;
}

// MARK: - Planning and writing

interface Planned {
  /** By slot index; only the slots that are planned again. */
  legs: Map<number, Awaited<ReturnType<typeof planLegForTrip>>>;
  dropped: DroppedBlockReport[];
  pending: PendingRegionReport[];
}

/** Everything planned before anything is written. */
async function planSlots(plan: StoredPlan, resolved: Resolved): Promise<Planned> {
  const planned: Planned = { legs: new Map(), dropped: [], pending: [] };
  for (const [index, slot] of resolved.slots.entries()) {
    if (!slot.replan) continue;
    const detailed = slot.existing ? slot.existing.days.filter((d) => d.detailed).length : 0;
    const result = await planLegForTrip(plan, slot.request, {
      detailDays: slot.frame.kind === "journey"
        ? slot.frame.days
        : slot.existing ? Math.max(1, detailed) : DEFAULT_DETAIL_DAYS,
      firstDayStartMinutes: slot.frame.kind === "stay" ? slot.frame.arriveMinutes : undefined,
    });
    planned.legs.set(index, result);
    for (const d of result.dropped) planned.dropped.push({ ...d, legIndex: index });
    if (result.pending) {
      planned.pending.push({ ...result.pending, legIndex: index, legTitle: slot.request.title ?? null });
    }
  }
  return planned;
}

async function writeSlots(plan: StoredPlan, resolved: Resolved, planned: Planned): Promise<void> {
  for (const leg of resolved.removed) await removeLeg(plan.id, leg.id);

  // Every surviving leg takes its place in the chain; the gaps are
  // where the new ones go.
  await setLegPositions(plan.id, resolved.slots.flatMap((slot, index) =>
    slot.existing ? [{ legId: slot.existing.id, position: index }] : []));

  const awaiting: Array<{ legId: number; awaiting: boolean }> = [];
  for (const [index, slot] of resolved.slots.entries()) {
    const result = planned.legs.get(index);
    if (!slot.existing) {
      if (!result) throw APIError.internal("a new leg was not planned");
      await insertLeg(plan.id, index, result.leg);
      continue;
    }
    const legId = slot.existing.id;
    if (slot.frame.kind === "journey") {
      if (!result) continue;
      const request = slot.request;
      await updateTransitLeg(plan.id, legId, {
        title: request.title as string,
        mode: request.mode as TransportMode,
        origin: { ...(request.origin as { lat: number; lon: number }), label: request.origin?.label ?? null },
        anchor: request.anchor,
        anchorLabel: request.anchorLabel ?? null,
        startDate: slot.frame.startDate as string,
        departMinutes: slot.frame.departMinutes as number,
        endMinutes: slot.frame.endMinutes as number,
      });
      await replanPlan(plan.id, plan.constraints, [{
        legId,
        days: [...result.leg.days] as CreateDayInput[],
        pool: [...result.leg.pool],
      }]);
      awaiting.push({ legId, awaiting: result.pending !== null });
      continue;
    }

    // A stay: the frame (date, mode) and the place (name, lodging) are
    // always written; the days only when the chain changed what they
    // can hold.
    await updateLegFrames(plan.id, [{ legId, startDate: slot.frame.startDate, mode: slot.request.mode }]);
    await updateLegPlace(plan.id, legId, {
      title: slot.request.title ?? null,
      anchorLabel: slot.request.anchorLabel ?? null,
      quartersAboard: slot.request.quartersAboard ?? false,
      tenderPort: slot.request.tenderPort ?? false,
      ...(result
        ? {
          anchor: slot.request.anchor,
          anchorRadiusM: slot.request.anchorRadiusM ?? null,
          arriveMinutes: slot.frame.arriveMinutes,
          radiusM: slot.request.radiusM ?? null,
          regionDb: result.leg.regionDb,
          dayStartMinutes: result.leg.dayStartMinutes,
        }
        : {}),
    });
    if (result) {
      await replanPlan(plan.id, plan.constraints, [{
        legId,
        days: [...result.leg.days] as CreateDayInput[],
        pool: [...result.leg.pool],
      }]);
      awaiting.push({ legId, awaiting: result.pending !== null });
    }
  }
  await setLegsAwaitingRegion(awaiting);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
