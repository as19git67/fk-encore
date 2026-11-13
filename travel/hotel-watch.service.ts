/**
 * Hotel price watches (documentation/plans/reise-hotelpreise.md).
 *
 * A watch is one hotel, fixed dates and guests, a limit per night and the
 * conditions a rate must meet (free cancellation, breakfast). The travel
 * job checks every active watch once a day and writes the history:
 * one `travel_hotel_check` row per check with the summary, and every rate
 * it saw as `travel_hotel_offer`.
 *
 * Every watch ends: `end_date` is required, at most two years ahead, and
 * never after the check-in — once the stay begins there is nothing left to
 * watch. A watch past its end is kept with its history but never checked.
 *
 * Searches cost money beyond SerpApi's free plan, so the job counts what
 * this calendar month used across all users (one key for the deployment)
 * and stops at `monthlySearchBudget()`.
 *
 * A price below the limit is reported by push and mail (`hotel-alerts.ts`).
 *
 * Instead of one hotel a watch may name an area (`kind = 'area'`): the check
 * reads Google's result list for the place, narrowed by stars and guest
 * rating, and the offers of its cheapest hotels (`hotel-area.ts`). With
 * `flexible`, `check_in`/`check_out` are the earliest arrival and the latest
 * departure and a stay lasts `min_nights` to `max_nights`: a hotel picks the
 * cheapest stay from Google's price calendar (`hotel-calendar.ts`), an area
 * checks one stay per check in turn (`flexible-dates.ts`).
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { travelHotelChecks, travelHotelOffers, travelHotelWatches, users } from "../db/schema";
import { searchesThisMonth, SearchBudgetExhausted } from "./search-budget";
import { alertDecision, alertSender, type PriceAlert } from "./hotel-alerts";
import {
  ADULTS_PER_ROOM,
  asRooms,
  isHotelDetail,
  mergeOffers,
  offersOf,
  pickProperty,
  splitRoomCount,
  summarize,
  type HotelOffer,
} from "./hotel-offers";
import { HotelSearchError, monthlySearchBudget, type HotelSearchClient, type HotelSearchParams } from "./serpapi-client";
import { durableLink, type LinkContext } from "./offer-links";
import { AREA_DETAILS, AREA_MIN_STARS, AREA_RATINGS, areaHotels, hotelClasses, ratingCode } from "./hotel-area";
import { calendarPrices, estimateStays, KEPT_ESTIMATES, type Stay, type StayEstimate } from "./hotel-calendar";
import { rotationPick, stayCombinations } from "./flexible-dates";

/** How far ahead a watch may end. */
export const MAX_END_YEARS = 2;
export const MAX_NIGHTS = 30;
export const MAX_ADULTS = 10;
export const MAX_CHILDREN = 6;
/** Longest period a watch with flexible dates may span, earliest arrival to latest departure. */
export const MAX_FLEX_DAYS = 120;
/** The job leaves a watch alone that was checked more recently than this (e.g. by "check now"). */
export const MIN_CHECK_GAP_MS = 5 * 60 * 60_000;
/** Checks returned with a watch's detail. */
const HISTORY_LIMIT = 500;

const TIME_ZONE = "Europe/Berlin";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type WatchRow = typeof travelHotelWatches.$inferSelect;
export type CheckRow = typeof travelHotelChecks.$inferSelect;
export type OfferRow = typeof travelHotelOffers.$inferSelect;

export type WatchStatus = "active" | "paused" | "ended";
export type WatchKind = "hotel" | "area";

export interface WatchInput {
  query: string;
  check_in: string;
  check_out: string;
  adults: number;
  children_ages?: number[];
  currency?: string;
  limit_per_night?: number | null;
  free_cancellation_only?: boolean;
  breakfast_required?: boolean;
  /** Also price the party in double rooms (only adults, even number, at least four). */
  split_rooms?: boolean;
  /** 'area': `query` is a place, narrowed by `min_stars` and `min_rating`. */
  kind?: WatchKind;
  min_stars?: number | null;
  /** Google's guest rating, 1–5: 3.5, 4 or 4.5. */
  min_rating?: number | null;
  /** Any stay of `min_nights`–`max_nights` between `check_in` (earliest arrival) and `check_out` (latest departure). */
  flexible?: boolean;
  min_nights?: number | null;
  max_nights?: number | null;
  end_date: string;
  paused?: boolean;
  notify_push?: boolean;
  notify_email?: boolean;
}

export interface HotelWatch {
  id: number;
  query: string;
  hotel_name: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children_ages: number[];
  currency: string;
  limit_per_night: number | null;
  free_cancellation_only: boolean;
  breakfast_required: boolean;
  split_rooms: boolean;
  kind: WatchKind;
  min_stars: number | null;
  min_rating: number | null;
  flexible: boolean;
  min_nights: number | null;
  max_nights: number | null;
  /** The last day a stay may begin: the check-in, or with flexible dates the latest departure minus the shortest stay. */
  last_arrival: string;
  end_date: string;
  paused: boolean;
  notify_push: boolean;
  notify_email: boolean;
  /** The price last reported; null when nothing below the limit is pending. */
  notified_per_night: number | null;
  status: WatchStatus;
  last_checked_at: string | null;
  last_error: string | null;
  /** The newest check that did not fail. */
  latest: HotelCheck | null;
  /** The cheapest matching price any check found. */
  best_matching_per_night: number | null;
  created_at: string;
}

export interface HotelCheck {
  id: number;
  checked_at: string;
  searches: number;
  offer_count: number;
  lowest_per_night: number | null;
  lowest_free_per_night: number | null;
  lowest_free_breakfast_per_night: number | null;
  matching_per_night: number | null;
  matching_source: string | null;
  /** Area watches: the hotel of the matching offer. */
  matching_hotel: string | null;
  below_limit: boolean;
  error: string | null;
  /** The stay this check priced. */
  check_in: string | null;
  check_out: string | null;
  /** Hotel with flexible dates: the cheapest stays of the price calendar (estimates). */
  stays: StayEstimate[] | null;
}

export interface HotelOfferEntry {
  source: string;
  room: string;
  per_night: number;
  total: number | null;
  /** Null: Google names no cancellation terms for this provider. */
  free_cancellation: boolean | null;
  cancel_until: string | null;
  breakfast: boolean;
  guests: number | null;
  link: string | null;
  /** Rooms the offer books; prices are for all of them together. */
  rooms: number;
  /** Area watches: the hotel of the offer. */
  hotel: string | null;
}

export interface HotelWatchDetail {
  watch: HotelWatch;
  checks: HotelCheck[];
  /** The rates of the newest successful check. */
  offers: HotelOfferEntry[];
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** Today as `YYYY-MM-DD` in the app's time zone. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

function parseIso(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function validIso(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const t = parseIso(s);
  return new Date(t).toISOString().slice(0, 10) === s;
}

/** The latest end date a watch created today may have. */
export function maxEndDate(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y + MAX_END_YEARS, m - 1, d)).toISOString().slice(0, 10);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((parseIso(checkOut) - parseIso(checkIn)) / 86_400_000);
}

function addDays(iso: string, days: number): string {
  return new Date(parseIso(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

type ArrivalFields = Pick<WatchRow, "check_in"> & Partial<Pick<WatchRow, "check_out" | "flexible" | "min_nights">>;

/** The last day a stay may begin. */
export function lastArrival(w: ArrivalFields): string {
  return w.flexible && w.check_out ? addDays(w.check_out, -(w.min_nights ?? 1)) : w.check_in;
}

/** The status the job reads: ended once the end date or the last possible arrival has passed. */
export function watchStatus(w: Pick<WatchRow, "paused" | "end_date"> & ArrivalFields, today: string): WatchStatus {
  if (w.end_date < today || lastArrival(w) <= today) return "ended";
  return w.paused ? "paused" : "active";
}

// ── Validation ───────────────────────────────────────────────────────────────

type Normalized = Omit<Required<WatchInput>, "limit_per_night"> & { limit_per_night: number | null };

export function normalizeWatchInput(input: WatchInput, today: string): Normalized {
  const bad = (msg: string): never => {
    throw APIError.invalidArgument(msg);
  };
  const kind: WatchKind = input.kind ?? "hotel";
  if (kind !== "hotel" && kind !== "area") bad("Art: Hotel oder Gebiet");
  const query = typeof input.query === "string" ? input.query.trim().replace(/\s+/g, " ") : "";
  if (query.length < 2 || query.length > 200) bad(kind === "area" ? "Gebiet: 2 bis 200 Zeichen" : "Hotel: 2 bis 200 Zeichen");

  let minStars: number | null = null;
  let minRating: number | null = null;
  if (kind === "area") {
    minStars = input.min_stars ?? null;
    if (minStars !== null && (!Number.isInteger(minStars) || minStars < AREA_MIN_STARS || minStars > 5)) {
      bad(`Sterne: ${AREA_MIN_STARS} bis 5`);
    }
    minRating = input.min_rating ?? null;
    if (minRating !== null && !(AREA_RATINGS as readonly number[]).includes(minRating)) {
      bad(`Bewertung: ${AREA_RATINGS.map((r) => r.toLocaleString("de-DE")).join(", ")} oder keine`);
    }
  }

  const flexible = input.flexible ?? false;
  if (!validIso(input.check_in)) bad(flexible ? "Früheste Anreise: kein gültiges Datum" : "Anreise: kein gültiges Datum");
  if (!validIso(input.check_out)) bad(flexible ? "Späteste Abreise: kein gültiges Datum" : "Abreise: kein gültiges Datum");
  if (!validIso(input.end_date)) bad("Ende der Beobachtung: kein gültiges Datum");
  if (input.check_in <= today) bad("Die Anreise muss in der Zukunft liegen");
  const nights = nightsBetween(input.check_in, input.check_out);
  if (nights < 1) bad("Die Abreise muss nach der Anreise liegen");

  let minNights: number | null = null;
  let maxNights: number | null = null;
  if (flexible) {
    if (nights > MAX_FLEX_DAYS) bad(`Der Zeitraum darf höchstens ${MAX_FLEX_DAYS} Tage umfassen`);
    minNights = input.min_nights ?? null;
    maxNights = input.max_nights ?? minNights;
    if (minNights === null || !Number.isInteger(minNights) || minNights < 1 || minNights > MAX_NIGHTS) {
      bad(`Mindestens: 1 bis ${MAX_NIGHTS} Nächte`);
    }
    if (maxNights === null || !Number.isInteger(maxNights) || maxNights < minNights! || maxNights > MAX_NIGHTS) {
      bad(`Höchstens: ${minNights} bis ${MAX_NIGHTS} Nächte`);
    }
    if (minNights! > nights) bad("Der Zeitraum ist kürzer als der kürzeste Aufenthalt");
    maxNights = Math.min(maxNights!, nights);
  } else if (nights > MAX_NIGHTS) {
    bad(`Höchstens ${MAX_NIGHTS} Nächte`);
  }

  if (input.end_date < today) bad("Das Ende der Beobachtung liegt in der Vergangenheit");
  const maxEnd = maxEndDate(today);
  if (input.end_date > maxEnd) bad(`Das Ende der Beobachtung darf höchstens ${MAX_END_YEARS} Jahre in der Zukunft liegen (bis ${maxEnd})`);
  const arrival = lastArrival({ check_in: input.check_in, check_out: input.check_out, flexible, min_nights: minNights });
  if (input.end_date >= arrival) {
    bad(flexible ? "Das Ende der Beobachtung muss vor der letztmöglichen Anreise liegen" : "Das Ende der Beobachtung muss vor der Anreise liegen");
  }

  if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > MAX_ADULTS) {
    bad(`Erwachsene: 1 bis ${MAX_ADULTS}`);
  }
  const children = input.children_ages ?? [];
  if (!Array.isArray(children) || children.length > MAX_CHILDREN) bad(`Höchstens ${MAX_CHILDREN} Kinder`);
  for (const age of children) {
    if (!Number.isInteger(age) || age < 0 || age > 17) bad("Alter eines Kindes: 0 bis 17");
  }

  const currency = (input.currency ?? "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) bad("Währung: drei Buchstaben, z. B. EUR");

  const limit = input.limit_per_night ?? null;
  if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > 100_000)) {
    bad("Grenze pro Nacht: eine positive Zahl");
  }

  const splitRooms = input.split_rooms ?? false;
  if (splitRooms && kind === "area") bad("Doppelzimmer gibt es nur für ein einzelnes Hotel");
  if (splitRooms && splitRoomCount(input.adults, children) === null) {
    bad("Doppelzimmer gehen nur bei einer geraden Zahl Erwachsener ab 4 und ohne Kinder");
  }

  return {
    query,
    check_in: input.check_in,
    check_out: input.check_out,
    adults: input.adults,
    children_ages: children,
    currency,
    limit_per_night: limit,
    free_cancellation_only: input.free_cancellation_only ?? true,
    breakfast_required: input.breakfast_required ?? false,
    split_rooms: splitRooms,
    kind,
    min_stars: minStars,
    min_rating: minRating,
    flexible,
    min_nights: minNights,
    max_nights: maxNights,
    end_date: input.end_date,
    paused: input.paused ?? false,
    notify_push: input.notify_push ?? true,
    notify_email: input.notify_email ?? true,
  };
}

/** What `durableLink` needs to build a portal search or the hotel's Google page. */
function linkContext(
  w: Pick<WatchRow, "query" | "adults" | "children_ages">,
  stay: Stay,
  hotelName: string | null,
  token: string | null,
  rooms: number,
  hotelSite: string | null = null,
): LinkContext {
  return {
    hotelName: hotelName ?? w.query,
    checkIn: stay.start,
    checkOut: stay.end,
    adults: w.adults,
    childrenAges: w.children_ages ?? [],
    rooms,
    propertyToken: token,
    hotelSite,
  };
}

// ── Shaping ──────────────────────────────────────────────────────────────────

function toCheck(c: CheckRow): HotelCheck {
  return {
    id: c.id,
    checked_at: c.checked_at,
    searches: c.searches,
    offer_count: c.offer_count,
    lowest_per_night: c.lowest_per_night,
    lowest_free_per_night: c.lowest_free_per_night,
    lowest_free_breakfast_per_night: c.lowest_free_breakfast_per_night,
    matching_per_night: c.matching_per_night,
    matching_source: c.matching_source,
    matching_hotel: c.matching_hotel,
    below_limit: c.below_limit,
    error: c.error,
    check_in: c.check_in,
    check_out: c.check_out,
    stays: c.stays ?? null,
  };
}

function toWatch(w: WatchRow, today: string, latest: CheckRow | null, best: number | null): HotelWatch {
  return {
    id: w.id,
    query: w.query,
    hotel_name: w.hotel_name,
    check_in: w.check_in,
    check_out: w.check_out,
    nights: nightsBetween(w.check_in, w.check_out),
    adults: w.adults,
    children_ages: w.children_ages ?? [],
    currency: w.currency,
    limit_per_night: w.limit_per_night,
    free_cancellation_only: w.free_cancellation_only,
    breakfast_required: w.breakfast_required,
    split_rooms: w.split_rooms,
    kind: w.kind,
    min_stars: w.min_stars,
    min_rating: w.min_rating,
    flexible: w.flexible,
    min_nights: w.min_nights,
    max_nights: w.max_nights,
    last_arrival: lastArrival(w),
    end_date: w.end_date,
    paused: w.paused,
    notify_push: w.notify_push,
    notify_email: w.notify_email,
    notified_per_night: w.notified_per_night,
    status: watchStatus(w, today),
    last_checked_at: w.last_checked_at,
    last_error: w.last_error,
    latest: latest ? toCheck(latest) : null,
    best_matching_per_night: best,
    created_at: w.created_at,
  };
}

/** Newest successful check and best matching price per watch. */
async function checkFacts(watchIds: number[]): Promise<Map<number, { latest: CheckRow | null; best: number | null }>> {
  const facts = new Map<number, { latest: CheckRow | null; best: number | null }>();
  if (!watchIds.length) return facts;
  const latest = await db
    .selectDistinctOn([travelHotelChecks.watch_id])
    .from(travelHotelChecks)
    .where(and(inArray(travelHotelChecks.watch_id, watchIds), sql`${travelHotelChecks.error} IS NULL`))
    .orderBy(travelHotelChecks.watch_id, desc(travelHotelChecks.checked_at), desc(travelHotelChecks.id));
  const best = await db
    .select({ watch_id: travelHotelChecks.watch_id, best: sql<number | null>`MIN(${travelHotelChecks.matching_per_night})` })
    .from(travelHotelChecks)
    .where(inArray(travelHotelChecks.watch_id, watchIds))
    .groupBy(travelHotelChecks.watch_id);
  for (const id of watchIds) facts.set(id, { latest: null, best: null });
  for (const c of latest) facts.get(c.watch_id)!.latest = c;
  for (const b of best) facts.get(b.watch_id)!.best = b.best === null ? null : Number(b.best);
  return facts;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function ownWatch(userId: number, id: number): Promise<WatchRow> {
  const [row] = await db
    .select()
    .from(travelHotelWatches)
    .where(and(eq(travelHotelWatches.id, id), eq(travelHotelWatches.user_id, userId)));
  if (!row) throw APIError.notFound("Hotelpreis-Wächter nicht gefunden");
  return row;
}

export async function listWatches(userId: number, now: Date = new Date()): Promise<HotelWatch[]> {
  const rows = await db
    .select()
    .from(travelHotelWatches)
    .where(eq(travelHotelWatches.user_id, userId))
    .orderBy(travelHotelWatches.check_in, travelHotelWatches.id);
  const facts = await checkFacts(rows.map((r) => r.id));
  const today = todayIso(now);
  return rows.map((r) => toWatch(r, today, facts.get(r.id)?.latest ?? null, facts.get(r.id)?.best ?? null));
}

export async function getWatchDetail(userId: number, id: number, now: Date = new Date()): Promise<HotelWatchDetail> {
  const row = await ownWatch(userId, id);
  const facts = (await checkFacts([id])).get(id)!;
  const checks = await db
    .select()
    .from(travelHotelChecks)
    .where(eq(travelHotelChecks.watch_id, id))
    .orderBy(desc(travelHotelChecks.checked_at), desc(travelHotelChecks.id))
    .limit(HISTORY_LIMIT);
  const offers = facts.latest
    ? await db
        .select()
        .from(travelHotelOffers)
        .where(eq(travelHotelOffers.check_id, facts.latest.id))
        .orderBy(travelHotelOffers.per_night, travelHotelOffers.id)
    : [];
  return {
    watch: toWatch(row, todayIso(now), facts.latest, facts.best),
    checks: checks.map(toCheck),
    offers: offers.map((o) => ({
      source: o.source,
      room: o.room,
      per_night: o.per_night,
      total: o.total,
      free_cancellation: o.free_cancellation,
      cancel_until: o.cancel_until,
      breakfast: o.breakfast,
      guests: o.guests,
      // Checks before the fix stored Google's redirects; they are replaced on reading.
      link: durableLink(
        o.link,
        o.source,
        linkContext(
          row,
          { start: facts.latest?.check_in ?? row.check_in, end: facts.latest?.check_out ?? row.check_out },
          o.hotel ?? row.hotel_name,
          o.hotel ? null : row.property_token,
          o.rooms,
        ),
      ),
      rooms: o.rooms,
      hotel: o.hotel,
    })),
  };
}

export async function createWatch(userId: number, input: WatchInput, now: Date = new Date()): Promise<HotelWatch> {
  const values = normalizeWatchInput(input, todayIso(now));
  const [row] = await db
    .insert(travelHotelWatches)
    .values({ user_id: userId, ...values })
    .returning();
  return toWatch(row, todayIso(now), null, null);
}

export async function updateWatch(userId: number, id: number, input: WatchInput, now: Date = new Date()): Promise<HotelWatch> {
  const before = await ownWatch(userId, id);
  const values = normalizeWatchInput(input, todayIso(now));
  // A different hotel is a different search; dates and guests are not.
  const sameHotel = values.query === before.query && values.kind === before.kind;
  // Different criteria make the last report stale: the next price below the limit is news.
  const sameCriteria =
    sameHotel &&
    values.check_in === before.check_in &&
    values.check_out === before.check_out &&
    values.adults === before.adults &&
    JSON.stringify(values.children_ages) === JSON.stringify(before.children_ages ?? []) &&
    values.currency === before.currency &&
    values.limit_per_night === before.limit_per_night &&
    values.free_cancellation_only === before.free_cancellation_only &&
    values.breakfast_required === before.breakfast_required &&
    values.split_rooms === before.split_rooms &&
    values.min_stars === before.min_stars &&
    values.min_rating === before.min_rating &&
    values.flexible === before.flexible &&
    values.min_nights === before.min_nights &&
    values.max_nights === before.max_nights;
  await db
    .update(travelHotelWatches)
    .set({
      ...values,
      hotel_name: sameHotel ? before.hotel_name : null,
      property_token: sameHotel ? before.property_token : null,
      ...(sameCriteria ? {} : { notified_per_night: null, notified_at: null, flex_rotation: -1 }),
      last_error: null,
      updated_at: now.toISOString(),
    })
    .where(eq(travelHotelWatches.id, id));
  return (await getWatchDetail(userId, id, now)).watch;
}

export async function deleteWatch(userId: number, id: number): Promise<void> {
  await ownWatch(userId, id);
  await db.delete(travelHotelWatches).where(eq(travelHotelWatches.id, id));
}

// ── Checking ─────────────────────────────────────────────────────────────────

export { searchesThisMonth, SearchBudgetExhausted } from "./search-budget";

/**
 * One check: search the hotel (by its stored token, or by name and then the
 * hit of the result list), write the check and its rates, update the watch.
 * A failed search is a check too — with its error and the searches it cost.
 */
export async function checkWatch(
  watch: WatchRow,
  client: HotelSearchClient,
  now: Date = new Date(),
  options: { alert?: boolean } = {},
): Promise<HotelCheck> {
  const used = await searchesThisMonth(now);
  const budget = monthlySearchBudget();
  if (used >= budget) throw new SearchBudgetExhausted(used, budget);

  const today = todayIso(now);
  const party = { adults: watch.adults, children_ages: watch.children_ages ?? [], currency: watch.currency };
  const guests = watch.adults + party.children_ages.length;
  let searches = 0;
  /** Count one more search; a check that would pass the budget stops with that as its error. */
  const spend = () => {
    if (used + searches >= budget) throw new SearchBudgetExhausted(used + searches, budget);
    searches++;
  };
  const search = (stay: Stay, extra: Partial<HotelSearchParams> = {}) =>
    client.search({ q: watch.query, check_in_date: stay.start, check_out_date: stay.end, ...party, ...extra });
  /** Offers of one hotel's detail answer with links that still open later (Google's redirects die with their session). */
  const linked = (list: HotelOffer[], stay: Stay, name: string | null, tok: string | null, site: string | null) =>
    list.map((o) => ({
      ...o,
      link: durableLink(o.link, o.source, linkContext(watch, stay, name, tok, o.rooms, site), o.official),
    }));

  let stay: Stay = { start: watch.check_in, end: watch.check_out };
  let hotelName = watch.hotel_name;
  let token = watch.property_token;
  let offers: HotelOffer[] = [];
  let stays: StayEstimate[] | null = null;
  let rotation: number | null = null;
  let error: string | null = null;

  /** The detail answer of the watched hotel for `at`: by its stored token, or by name and then the hit of the result list. */
  const hotelDetail = async (at: Stay): Promise<any> => {
    spend();
    let answer = await search(at, { property_token: token });
    if (!isHotelDetail(answer)) {
      const hit = pickProperty(answer, watch.query);
      if (!hit) throw new HotelSearchError("Kein Hotel zu dieser Suche gefunden");
      token = hit.token;
      spend();
      answer = await search(at, { property_token: token });
      if (!isHotelDetail(answer)) throw new HotelSearchError(`Keine Preise für „${hit.name}“`);
    }
    token = String(answer.property_token);
    hotelName = typeof answer.name === "string" && answer.name.trim() ? answer.name.trim() : hotelName;
    return answer;
  };

  try {
    let combos: Stay[] = [];
    if (watch.flexible) {
      combos = stayCombinations({
        from: watch.check_in,
        to: watch.check_out,
        minNights: watch.min_nights ?? 1,
        maxNights: watch.max_nights ?? watch.min_nights ?? 1,
        today,
      }).map((c) => ({ start: c.start, end: c.end! }));
      if (!combos.length) throw new HotelSearchError("Im Zeitraum ist kein Aufenthalt mehr möglich");
      // Until a check knows better, the stays take turns.
      const pick = rotationPick(combos, watch.flex_rotation);
      stay = pick.combo as Stay;
      rotation = pick.index;
    }

    if (watch.kind === "area") {
      spend();
      const list = await search(stay, {
        hotel_class: hotelClasses(watch.min_stars),
        rating: ratingCode(watch.min_rating),
        free_cancellation: watch.free_cancellation_only,
        sort_by: 3,
      });
      const hits = areaHotels(list, { minStars: watch.min_stars, minRating: watch.min_rating });
      if (!hits.length) throw new HotelSearchError("Kein Hotel in diesem Gebiet erfüllt die Kriterien");
      for (const hit of hits.slice(0, AREA_DETAILS)) {
        if (used + searches >= budget) break;
        searches++;
        try {
          const detail = await search(stay, { property_token: hit.token });
          if (!isHotelDetail(detail)) continue;
          const site = typeof detail.link === "string" ? detail.link : null;
          const found = linked(offersOf(detail, guests), stay, hit.name, hit.token, site).map((o) => ({ ...o, hotel: hit.name }));
          offers = mergeOffers(offers, found);
        } catch (err) {
          console.warn(`[travel.hotel-watch] watch ${watch.id} area hotel: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!offers.length) throw new HotelSearchError("Keine Preise für die Hotels in diesem Gebiet");
    } else {
      let answer: any = null;
      if (watch.flexible) {
        if (!token) answer = await hotelDetail(stay);
        // One calendar search prices every arrival day; the cheapest stay is read for real.
        if (client.calendar && token && used + searches < budget) {
          spend();
          try {
            const calendar = await client.calendar({
              property_token: token,
              start_date: combos[0].start,
              end_date: combos.reduce((last, c) => (c.start > last ? c.start : last), combos[0].start),
              ...party,
            });
            const estimates = estimateStays(calendarPrices(calendar), combos);
            if (estimates.length) {
              stays = estimates.slice(0, KEPT_ESTIMATES);
              const best = estimates[0];
              if (answer === null || best.start !== stay.start || best.end !== stay.end) answer = null;
              stay = { start: best.start, end: best.end };
              rotation = null;
            }
          } catch (err) {
            console.warn(`[travel.hotel-watch] watch ${watch.id} price calendar: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      answer ??= await hotelDetail(stay);
      const site = typeof answer.link === "string" ? answer.link : null;
      offers = linked(offersOf(answer, guests), stay, hotelName, token, site);

      // The same hotel in double rooms: one more search, its prices times the rooms.
      // It only adds offers — when it fails, the check stands with the rooms for everyone.
      const rooms = splitRoomCount(watch.adults, watch.children_ages ?? []);
      if (watch.split_rooms && rooms !== null) {
        if (used + searches >= budget) {
          console.warn(`[travel.hotel-watch] watch ${watch.id}: no search left for the double rooms`);
        } else {
          try {
            searches++;
            const double = await search(stay, { adults: ADULTS_PER_ROOM, children_ages: [], property_token: token });
            if (!isHotelDetail(double)) throw new HotelSearchError("Keine Preise für Doppelzimmer");
            offers = mergeOffers(offers, linked(asRooms(offersOf(double, ADULTS_PER_ROOM), rooms), stay, hotelName, token, site));
          } catch (err) {
            console.warn(`[travel.hotel-watch] watch ${watch.id} double rooms: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const summary = summarize(offers, {
    freeCancellationOnly: watch.free_cancellation_only,
    breakfastRequired: watch.breakfast_required,
  });
  const matching = summary.matching;
  const belowLimit =
    error === null && matching !== null && watch.limit_per_night !== null && matching.perNight < watch.limit_per_night;
  const checkedAt = now.toISOString();

  const check = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(travelHotelChecks)
      .values({
        watch_id: watch.id,
        checked_at: checkedAt,
        searches,
        offer_count: offers.length,
        lowest_per_night: summary.lowest?.perNight ?? null,
        lowest_free_per_night: summary.lowestFree?.perNight ?? null,
        lowest_free_breakfast_per_night: summary.lowestFreeBreakfast?.perNight ?? null,
        matching_per_night: matching?.perNight ?? null,
        matching_source: matching?.source ?? null,
        matching_hotel: matching?.hotel ?? null,
        below_limit: belowLimit,
        error,
        check_in: stay.start,
        check_out: stay.end,
        stays,
      })
      .returning();
    if (offers.length) {
      await tx.insert(travelHotelOffers).values(
        offers.map((o) => ({
          check_id: c.id,
          source: o.source,
          room: o.room,
          per_night: o.perNight,
          total: o.total,
          free_cancellation: o.freeCancellation,
          cancel_until: o.cancelUntil,
          breakfast: o.breakfast,
          guests: o.guests,
          link: o.link,
          rooms: o.rooms,
          hotel: o.hotel ?? null,
        })),
      );
    }
    await tx
      .update(travelHotelWatches)
      .set({
        last_checked_at: checkedAt,
        last_error: error,
        ...(error === null && watch.kind !== "area" ? { hotel_name: hotelName, property_token: token } : {}),
        ...(rotation !== null ? { flex_rotation: rotation } : {}),
      })
      .where(eq(travelHotelWatches.id, watch.id));
    return c;
  });
  if (options.alert && error === null) {
    await reportPrice({ ...watch, hotel_name: hotelName }, matching, stay, now);
  }
  return toCheck(check);
}

/**
 * Report the check's matching price if `alertDecision` says so, and keep
 * `notified_per_night` in step. The report counts as made once it is tried:
 * a mail server that is down must not turn into a mail every morning.
 */
async function reportPrice(watch: WatchRow, matching: HotelOffer | null, stay: Stay, now: Date): Promise<void> {
  const decision = alertDecision(watch.limit_per_night, matching?.perNight ?? null, watch.notified_per_night);
  if (decision.kind === "none") return;
  if (decision.kind === "reset") {
    await db
      .update(travelHotelWatches)
      .set({ notified_per_night: null, notified_at: null })
      .where(eq(travelHotelWatches.id, watch.id));
    return;
  }
  const offer = matching!;
  await db
    .update(travelHotelWatches)
    .set({ notified_per_night: offer.perNight, notified_at: now.toISOString() })
    .where(eq(travelHotelWatches.id, watch.id));
  if (!watch.notify_push && !watch.notify_email) return;

  const alert: PriceAlert = {
    userId: watch.user_id,
    watchId: watch.id,
    hotel: offer.hotel ?? watch.hotel_name ?? watch.query,
    checkIn: stay.start,
    checkOut: stay.end,
    nights: nightsBetween(stay.start, stay.end),
    currency: watch.currency,
    perNight: offer.perNight,
    limit: watch.limit_per_night!,
    source: offer.source,
    room: offer.room,
    freeCancellation: offer.freeCancellation,
    cancelUntil: offer.cancelUntil,
    breakfast: offer.breakfast,
    link: offer.link,
    rooms: offer.rooms,
    newLow: decision.newLow,
  };
  const sender = alertSender();
  const failed = (channel: string) => (err: unknown) =>
    console.warn(`[travel.hotel-watch] ${channel} for watch ${watch.id} failed: ${err instanceof Error ? err.message : err}`);
  if (watch.notify_push) await sender.push(alert).catch(failed("push"));
  if (watch.notify_email) {
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, watch.user_id));
    if (owner?.email) await sender.email(alert, owner.email).catch(failed("mail"));
  }
}

/** "Check now" from the page: the user's own watch, if it is still running. */
export async function checkWatchNow(userId: number, id: number, client: HotelSearchClient, now: Date = new Date()): Promise<HotelCheck> {
  const watch = await ownWatch(userId, id);
  if (watchStatus(watch, todayIso(now)) === "ended") {
    throw APIError.failedPrecondition("Die Beobachtung ist beendet");
  }
  try {
    return await checkWatch(watch, client, now);
  } catch (err) {
    if (err instanceof SearchBudgetExhausted) throw APIError.resourceExhausted(err.message);
    throw err;
  }
}

export interface CheckRunResult {
  due: number;
  checked: number;
  failed: number;
  /** Watches left for the next run because the month's searches ran out. */
  skippedBudget: number;
}

/** The job: every active watch not checked within `MIN_CHECK_GAP_MS`, oldest check first. */
export async function runDueChecks(client: HotelSearchClient, now: Date = new Date()): Promise<CheckRunResult> {
  const today = todayIso(now);
  const cutoff = new Date(now.getTime() - MIN_CHECK_GAP_MS).toISOString();
  const rows = await db
    .select()
    .from(travelHotelWatches)
    .where(
      and(
        eq(travelHotelWatches.paused, false),
        gte(travelHotelWatches.end_date, today),
        sql`(CASE WHEN ${travelHotelWatches.flexible} THEN ${travelHotelWatches.check_out} - COALESCE(${travelHotelWatches.min_nights}, 1) ELSE ${travelHotelWatches.check_in} END) > ${today}::date`,
        sql`(${travelHotelWatches.last_checked_at} IS NULL OR ${travelHotelWatches.last_checked_at} < ${cutoff})`,
      ),
    )
    .orderBy(sql`${travelHotelWatches.last_checked_at} ASC NULLS FIRST`, travelHotelWatches.id);

  const result: CheckRunResult = { due: rows.length, checked: 0, failed: 0, skippedBudget: 0 };
  for (const [i, watch] of rows.entries()) {
    try {
      const check = await checkWatch(watch, client, now, { alert: true });
      result.checked++;
      if (check.error) result.failed++;
    } catch (err) {
      if (err instanceof SearchBudgetExhausted) {
        result.skippedBudget = rows.length - i;
        break;
      }
      result.failed++;
      console.warn(`[travel.hotel-watch] watch ${watch.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
