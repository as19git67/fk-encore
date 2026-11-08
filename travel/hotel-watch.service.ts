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
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { travelHotelChecks, travelHotelOffers, travelHotelWatches, users } from "../db/schema";
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
import { HotelSearchError, monthlySearchBudget, type HotelSearchClient } from "./serpapi-client";

/** How far ahead a watch may end. */
export const MAX_END_YEARS = 2;
export const MAX_NIGHTS = 30;
export const MAX_ADULTS = 10;
export const MAX_CHILDREN = 6;
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
  below_limit: boolean;
  error: string | null;
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

/** The status the job reads: ended once the end date or the check-in has passed. */
export function watchStatus(w: Pick<WatchRow, "paused" | "end_date" | "check_in">, today: string): WatchStatus {
  if (w.end_date < today || w.check_in <= today) return "ended";
  return w.paused ? "paused" : "active";
}

// ── Validation ───────────────────────────────────────────────────────────────

type Normalized = Omit<Required<WatchInput>, "limit_per_night"> & { limit_per_night: number | null };

export function normalizeWatchInput(input: WatchInput, today: string): Normalized {
  const bad = (msg: string): never => {
    throw APIError.invalidArgument(msg);
  };
  const query = typeof input.query === "string" ? input.query.trim().replace(/\s+/g, " ") : "";
  if (query.length < 2 || query.length > 200) bad("Hotel: 2 bis 200 Zeichen");

  if (!validIso(input.check_in)) bad("Anreise: kein gültiges Datum");
  if (!validIso(input.check_out)) bad("Abreise: kein gültiges Datum");
  if (!validIso(input.end_date)) bad("Ende der Beobachtung: kein gültiges Datum");
  if (input.check_in <= today) bad("Die Anreise muss in der Zukunft liegen");
  const nights = nightsBetween(input.check_in, input.check_out);
  if (nights < 1) bad("Die Abreise muss nach der Anreise liegen");
  if (nights > MAX_NIGHTS) bad(`Höchstens ${MAX_NIGHTS} Nächte`);

  if (input.end_date < today) bad("Das Ende der Beobachtung liegt in der Vergangenheit");
  const maxEnd = maxEndDate(today);
  if (input.end_date > maxEnd) bad(`Das Ende der Beobachtung darf höchstens ${MAX_END_YEARS} Jahre in der Zukunft liegen (bis ${maxEnd})`);
  if (input.end_date >= input.check_in) bad("Das Ende der Beobachtung muss vor der Anreise liegen");

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
    end_date: input.end_date,
    paused: input.paused ?? false,
    notify_push: input.notify_push ?? true,
    notify_email: input.notify_email ?? true,
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
    below_limit: c.below_limit,
    error: c.error,
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
      link: o.link,
      rooms: o.rooms,
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
  const sameHotel = values.query === before.query;
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
    values.split_rooms === before.split_rooms;
  await db
    .update(travelHotelWatches)
    .set({
      ...values,
      hotel_name: sameHotel ? before.hotel_name : null,
      property_token: sameHotel ? before.property_token : null,
      ...(sameCriteria ? {} : { notified_per_night: null, notified_at: null }),
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

/** SerpApi searches all checks used since the start of `now`'s calendar month (UTC). */
export async function searchesThisMonth(now: Date = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [row] = await db
    .select({ n: sql<number>`COALESCE(SUM(${travelHotelChecks.searches}), 0)` })
    .from(travelHotelChecks)
    .where(gte(travelHotelChecks.checked_at, start));
  return Number(row?.n ?? 0);
}

export class SearchBudgetExhausted extends Error {
  constructor(used: number, budget: number) {
    super(`Das Monatskontingent von ${budget} SerpApi-Suchen ist aufgebraucht (${used} verbraucht)`);
    this.name = "SearchBudgetExhausted";
  }
}

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

  const base = {
    q: watch.query,
    check_in_date: watch.check_in,
    check_out_date: watch.check_out,
    adults: watch.adults,
    children_ages: watch.children_ages ?? [],
    currency: watch.currency,
  };
  let searches = 0;
  let hotelName = watch.hotel_name;
  let token = watch.property_token;
  let offers: HotelOffer[] = [];
  let error: string | null = null;
  try {
    searches++;
    let answer = await client.search({ ...base, property_token: token });
    if (!isHotelDetail(answer)) {
      const hit = pickProperty(answer, watch.query);
      if (!hit) throw new HotelSearchError("Kein Hotel zu dieser Suche gefunden");
      if (searches + used >= budget) throw new SearchBudgetExhausted(searches + used, budget);
      token = hit.token;
      searches++;
      answer = await client.search({ ...base, property_token: token });
      if (!isHotelDetail(answer)) throw new HotelSearchError(`Keine Preise für „${hit.name}“`);
    }
    token = String(answer.property_token);
    hotelName = typeof answer.name === "string" && answer.name.trim() ? answer.name.trim() : hotelName;
    offers = offersOf(answer, watch.adults + (watch.children_ages?.length ?? 0));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // The same hotel in double rooms: one more search, its prices times the rooms.
  // It only adds offers — when it fails, the check stands with the rooms for everyone.
  const rooms = splitRoomCount(watch.adults, watch.children_ages ?? []);
  if (error === null && watch.split_rooms && rooms !== null) {
    if (used + searches >= budget) {
      console.warn(`[travel.hotel-watch] watch ${watch.id}: no search left for the double rooms`);
    } else {
      try {
        searches++;
        const answer = await client.search({ ...base, adults: ADULTS_PER_ROOM, children_ages: [], property_token: token });
        if (!isHotelDetail(answer)) throw new HotelSearchError("Keine Preise für Doppelzimmer");
        offers = mergeOffers(offers, asRooms(offersOf(answer, ADULTS_PER_ROOM), rooms));
      } catch (err) {
        console.warn(`[travel.hotel-watch] watch ${watch.id} double rooms: ${err instanceof Error ? err.message : err}`);
      }
    }
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
        below_limit: belowLimit,
        error,
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
        })),
      );
    }
    await tx
      .update(travelHotelWatches)
      .set({
        last_checked_at: checkedAt,
        last_error: error,
        ...(error === null ? { hotel_name: hotelName, property_token: token } : {}),
      })
      .where(eq(travelHotelWatches.id, watch.id));
    return c;
  });
  if (options.alert && error === null) {
    await reportPrice({ ...watch, hotel_name: hotelName }, matching, now);
  }
  return toCheck(check);
}

/**
 * Report the check's matching price if `alertDecision` says so, and keep
 * `notified_per_night` in step. The report counts as made once it is tried:
 * a mail server that is down must not turn into a mail every morning.
 */
async function reportPrice(watch: WatchRow, matching: HotelOffer | null, now: Date): Promise<void> {
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
    hotel: watch.hotel_name ?? watch.query,
    checkIn: watch.check_in,
    checkOut: watch.check_out,
    nights: nightsBetween(watch.check_in, watch.check_out),
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
        sql`${travelHotelWatches.check_in} > ${today}`,
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
