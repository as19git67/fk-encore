/**
 * Flight price watches (documentation/plans/reise-flugpreise.md).
 *
 * A watch is a route (one or more airports on each side), passengers,
 * travel class and filters (stops, airlines, departure hours), and either
 * fixed dates or a flexible window: earliest outbound, latest return and a
 * range of nights. The job checks one date combination per watch and day —
 * a fixed watch its dates, a flexible one the next combination in turn
 * (`rotationPick`, `flex_rotation`) — so a flexible watch costs no more
 * searches than a fixed one. One search returns the flights with the price
 * of the whole trip for all passengers plus Google's price insight and
 * history, which is kept per combination (`travel_flight_price_point`).
 *
 * The limit compares with the best price the watch knows: the cheapest of
 * the latest checks of the combinations still ahead. Reporting follows the
 * hotel watch's rule (`alertDecision`). Only when a price is reported does
 * the check spend one or two more searches on who sells the flight
 * (booking options), if the month's budget allows.
 *
 * Checked bag (`checked_bag`, on by default): Google Flights cannot filter
 * for it, so before a report the check reads the booking options of the
 * flight and adds the fee of one checked bag per seated traveller
 * (`bag_price` on the check). The limit then compares that price; a combination
 * whose price with a bag stands above the limit is not reported. A later
 * check of the same dates that is not cheaper reuses the known fee instead
 * of spending the searches again.
 *
 * Every watch ends: `end_date` is required, at most two years ahead and
 * before the last possible departure.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import {
  travelFlightBookings,
  travelFlightChecks,
  travelFlightOffers,
  travelFlightPricePoints,
  travelFlightWatches,
  users,
} from "../db/schema";
import { alertDecision } from "./hotel-alerts";
import { flightAlertSender, type FlightPriceAlert } from "./flight-alerts";
import {
  bookingOptionsOf,
  cheapestWithBag,
  flightsOf,
  googleFlightsLink,
  insightOf,
  stopsParam,
  type BookingOption,
  type FlightOffer,
} from "./flight-offers";
import type { FlightSearchClient, FlightSearchParams } from "./flight-search-client";
import { comboKey, MAX_COMBINATIONS, rotationPick, stayCombinations, type DateCombo } from "./flexible-dates";
import { monthlySearchBudget } from "./serpapi-client";
import { SearchBudgetExhausted, searchesThisMonth } from "./search-budget";
import { maxEndDate, MIN_CHECK_GAP_MS, todayIso } from "./hotel-watch.service";

export const MAX_PASSENGERS = 9;
export const MAX_AIRPORTS = 5;
export const MAX_NIGHTS = 60;
/** A flexible window longer than this has too many combinations to walk. */
export const MAX_WINDOW_DAYS = 180;
/** Flights kept per check. */
const OFFERS_KEPT = 20;
const HISTORY_LIMIT = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const AIRPORT = /^[A-Z]{3}$/;
const AIRLINE = /^([A-Z0-9]{2}|STAR_ALLIANCE|SKYTEAM|ONEWORLD)$/;

export type FlightWatchRow = typeof travelFlightWatches.$inferSelect;
type CheckRow = typeof travelFlightChecks.$inferSelect;

export type TripType = "round" | "oneway";
export type AirlinesMode = "include" | "exclude";
export type FlightWatchStatus = "active" | "paused" | "ended";

export interface FlightWatchInput {
  /** IATA codes, several separated by commas. */
  origin: string;
  destination: string;
  trip_type?: TripType;
  flexible?: boolean;
  /** Fixed dates. */
  outbound_date?: string | null;
  return_date?: string | null;
  /** Flexible: earliest outbound, latest return (one way: latest outbound), nights. */
  date_from?: string | null;
  date_until?: string | null;
  min_nights?: number | null;
  max_nights?: number | null;
  adults: number;
  children?: number;
  infants_on_lap?: number;
  /** 1 economy, 2 premium economy, 3 business, 4 first. */
  travel_class?: number;
  /** Null any number; 0 nonstop; 1 or 2 at most that many. */
  max_stops?: number | null;
  airlines?: string | null;
  airlines_mode?: AirlinesMode | null;
  /** Departure hours "from,to" (0–23). */
  outbound_times?: string | null;
  return_times?: string | null;
  currency?: string;
  /** For all passengers and both ways. */
  limit_total?: number | null;
  end_date: string;
  paused?: boolean;
  notify_push?: boolean;
  notify_email?: boolean;
  /** Only report prices with one checked bag per seated traveller (default true). */
  checked_bag?: boolean;
}

export interface FlightCheck {
  id: number;
  checked_at: string;
  searches: number;
  outbound_date: string;
  return_date: string | null;
  flight_count: number;
  lowest_price: number | null;
  lowest_airlines: string | null;
  lowest_stops: number | null;
  price_level: string | null;
  typical_low: number | null;
  typical_high: number | null;
  below_limit: boolean;
  /** The cheapest price with a checked bag per seated traveller, when known. */
  bag_price: number | null;
  error: string | null;
}

/** The cheapest price the watch knows for dates still ahead. */
export interface BestKnown {
  price: number;
  outbound_date: string;
  return_date: string | null;
  airlines: string | null;
  stops: number | null;
  checked_at: string;
  link: string;
  /** The price includes one checked bag per seated traveller. */
  with_bag: boolean;
}

export interface FlightWatch {
  id: number;
  origin: string;
  destination: string;
  trip_type: TripType;
  flexible: boolean;
  outbound_date: string | null;
  return_date: string | null;
  date_from: string | null;
  date_until: string | null;
  min_nights: number | null;
  max_nights: number | null;
  adults: number;
  children: number;
  infants_on_lap: number;
  travel_class: number;
  max_stops: number | null;
  airlines: string | null;
  airlines_mode: AirlinesMode | null;
  outbound_times: string | null;
  return_times: string | null;
  currency: string;
  limit_total: number | null;
  end_date: string;
  paused: boolean;
  notify_push: boolean;
  notify_email: boolean;
  checked_bag: boolean;
  notified_price: number | null;
  status: FlightWatchStatus;
  last_checked_at: string | null;
  last_error: string | null;
  /** Date combinations still ahead (1 for fixed dates). */
  combinations: number;
  /** The newest check that did not fail. */
  latest: FlightCheck | null;
  best: BestKnown | null;
  /** The Google Flights search for the fixed dates (or the best combination). */
  link: string | null;
  created_at: string;
}

export interface FlightOfferEntry {
  price: number;
  airlines: string;
  flight_numbers: string;
  departs_at: string | null;
  arrives_at: string | null;
  duration_min: number | null;
  stops: number;
  layovers: string;
  best: boolean;
}

export interface FlightBookingEntry {
  book_with: string;
  price: number | null;
  option_title: string | null;
  extensions: string;
  baggage: string;
}

export interface FlightCombinationEntry {
  outbound_date: string;
  return_date: string | null;
  /** Null until its turn came. */
  price: number | null;
  price_level: string | null;
  checked_at: string | null;
  link: string;
}

export interface FlightWatchDetail {
  watch: FlightWatch;
  checks: FlightCheck[];
  /** The flights of the newest successful check. */
  offers: FlightOfferEntry[];
  /** Booking options of the newest check that fetched them, with its dates. */
  bookings: { checked_at: string; outbound_date: string; return_date: string | null; options: FlightBookingEntry[] } | null;
  /** Google's price history of the newest check's dates, oldest first. */
  history: { outbound_date: string; return_date: string | null; points: { day: string; price: number }[] } | null;
  /** Flexible watches: every combination ahead with the price its last check found. */
  combinations: FlightCombinationEntry[];
}

// ── Dates ────────────────────────────────────────────────────────────────────

function validIso(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How many combinations a window has; `stayCombinations` stops at MAX_COMBINATIONS. */
function countCombinations(from: string, until: string, minNights: number | null, maxNights: number | null, today: string): number {
  let n = 0;
  for (let start = from; start <= until; start = addDays(start, 1)) {
    if (start <= today) continue;
    if (minNights === null || maxNights === null) n++;
    else for (let k = minNights; k <= maxNights && addDays(start, k) <= until; k++) n++;
  }
  return n;
}

function daysBetween(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

type DatesOf = Pick<
  FlightWatchRow,
  "trip_type" | "flexible" | "outbound_date" | "return_date" | "date_from" | "date_until" | "min_nights" | "max_nights"
>;

/** The date combinations of a watch that have not begun. */
export function combinationsOf(w: DatesOf, today: string): DateCombo[] {
  if (!w.flexible) {
    if (!w.outbound_date || w.outbound_date <= today) return [];
    return [{ start: w.outbound_date, end: w.trip_type === "round" ? w.return_date : null }];
  }
  if (!w.date_from || !w.date_until) return [];
  const round = w.trip_type === "round";
  return stayCombinations({
    from: w.date_from,
    to: w.date_until,
    minNights: round ? w.min_nights : null,
    maxNights: round ? w.max_nights : null,
    today,
  });
}

/** The last day a flight of the watch can leave. */
function lastDeparture(w: DatesOf): string | null {
  if (!w.flexible) return w.outbound_date;
  if (!w.date_until) return null;
  return w.trip_type === "round" ? addDays(w.date_until, -(w.min_nights ?? 0)) : w.date_until;
}

export function flightWatchStatus(
  w: DatesOf & Pick<FlightWatchRow, "paused" | "end_date">,
  today: string,
): FlightWatchStatus {
  const last = lastDeparture(w);
  if (w.end_date < today || !last || last <= today) return "ended";
  return w.paused ? "paused" : "active";
}

// ── Validation ───────────────────────────────────────────────────────────────

type Normalized = Omit<typeof travelFlightWatches.$inferInsert, "id" | "user_id">;

function codes(raw: unknown, pattern: RegExp): string[] | null {
  if (typeof raw !== "string") return null;
  const list = [...new Set(raw.split(/[,;\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  return list.length && list.every((c) => pattern.test(c)) ? list : null;
}

function hours(raw: unknown, label: string, bad: (m: string) => never): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parts = String(raw).split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2 || !parts.every((h) => Number.isInteger(h) && h >= 0 && h <= 23) || parts[0]! > parts[1]!) {
    bad(`${label}: zwei Stunden von 0 bis 23, z. B. „6,12“`);
  }
  return parts[0] === 0 && parts[1] === 23 ? null : parts.join(",");
}

export function normalizeFlightWatchInput(input: FlightWatchInput, today: string): Normalized {
  const bad = (msg: string): never => {
    throw APIError.invalidArgument(msg);
  };

  const origin = codes(input.origin, AIRPORT) ?? bad("Abflug: Flughafen-Codes mit drei Buchstaben, z. B. FRA oder FRA,HHN");
  const destination = codes(input.destination, AIRPORT) ?? bad("Ziel: Flughafen-Codes mit drei Buchstaben, z. B. JFK");
  if (origin.length > MAX_AIRPORTS || destination.length > MAX_AIRPORTS) bad(`Höchstens ${MAX_AIRPORTS} Flughäfen je Seite`);
  if (origin.some((c) => destination.includes(c))) bad("Abflug und Ziel dürfen keinen Flughafen gemeinsam haben");

  const tripType: TripType = input.trip_type ?? "round";
  if (tripType !== "round" && tripType !== "oneway") bad("Reiseart: hin und zurück oder einfach");
  const round = tripType === "round";
  const flexible = input.flexible ?? false;

  let outbound: string | null = null;
  let ret: string | null = null;
  let from: string | null = null;
  let until: string | null = null;
  let minNights: number | null = null;
  let maxNights: number | null = null;
  if (!flexible) {
    if (!validIso(input.outbound_date)) bad("Hinflug: kein gültiges Datum");
    outbound = input.outbound_date as string;
    if (outbound <= today) bad("Der Hinflug muss in der Zukunft liegen");
    if (round) {
      if (!validIso(input.return_date)) bad("Rückflug: kein gültiges Datum");
      ret = input.return_date as string;
      if (ret < outbound) bad("Der Rückflug darf nicht vor dem Hinflug liegen");
      if (daysBetween(outbound, ret) > MAX_NIGHTS) bad(`Höchstens ${MAX_NIGHTS} Tage zwischen Hin- und Rückflug`);
    }
  } else {
    if (!validIso(input.date_from)) bad("Frühester Hinflug: kein gültiges Datum");
    if (!validIso(input.date_until)) bad(round ? "Spätester Rückflug: kein gültiges Datum" : "Spätester Hinflug: kein gültiges Datum");
    from = input.date_from as string;
    until = input.date_until as string;
    if (until < from) bad("Der Zeitraum endet vor seinem Beginn");
    if (daysBetween(from, until) > MAX_WINDOW_DAYS) bad(`Der Zeitraum darf höchstens ${MAX_WINDOW_DAYS} Tage lang sein`);
    if (round) {
      minNights = input.min_nights ?? null;
      maxNights = input.max_nights ?? null;
      if (!Number.isInteger(minNights) || !Number.isInteger(maxNights)) bad("Dauer: Nächte von und bis angeben");
      if ((minNights as number) < 0 || (maxNights as number) > MAX_NIGHTS || (minNights as number) > (maxNights as number)) {
        bad(`Dauer: 0 bis ${MAX_NIGHTS} Nächte, „von“ nicht größer als „bis“`);
      }
    }
    const count = countCombinations(from as string, until as string, minNights, maxNights, today);
    if (!count) bad("Im Zeitraum passt keine Reise mehr, die nach heute beginnt");
    if (count > MAX_COMBINATIONS) {
      bad(`Zu viele Kombinationen (${count}, höchstens ${MAX_COMBINATIONS}): Zeitraum oder Dauer enger fassen`);
    }
  }

  const children = input.children ?? 0;
  const infants = input.infants_on_lap ?? 0;
  if (!Number.isInteger(input.adults) || input.adults < 1) bad("Mindestens ein Erwachsener");
  if (!Number.isInteger(children) || children < 0) bad("Kinder: eine Zahl ab 0");
  if (!Number.isInteger(infants) || infants < 0 || infants > input.adults) bad("Kleinkinder auf dem Schoß: höchstens eins je Erwachsenem");
  if (input.adults + children + infants > MAX_PASSENGERS) bad(`Höchstens ${MAX_PASSENGERS} Reisende`);

  const travelClass = input.travel_class ?? 1;
  if (![1, 2, 3, 4].includes(travelClass)) bad("Klasse: 1 bis 4");
  const maxStops = input.max_stops ?? null;
  if (maxStops !== null && ![0, 1, 2].includes(maxStops)) bad("Umstiege: beliebig, 0, 1 oder 2");

  let airlines: string | null = null;
  let airlinesMode: AirlinesMode | null = null;
  if (typeof input.airlines === "string" && input.airlines.trim()) {
    airlines = (codes(input.airlines, AIRLINE) ?? bad("Airlines: zweistellige Codes wie LH oder eine Allianz (STAR_ALLIANCE, SKYTEAM, ONEWORLD)")).join(",");
    airlinesMode = input.airlines_mode ?? "include";
    if (airlinesMode !== "include" && airlinesMode !== "exclude") bad("Airlines: nur diese oder alle außer diesen");
  }

  const outboundTimes = hours(input.outbound_times, "Abflugzeit hin", bad);
  const returnTimes = round ? hours(input.return_times, "Abflugzeit zurück", bad) : null;

  const currency = (input.currency ?? "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) bad("Währung: drei Buchstaben, z. B. EUR");
  const limit = input.limit_total ?? null;
  if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > 1_000_000)) {
    bad("Preisgrenze: eine positive Zahl");
  }

  if (!validIso(input.end_date)) bad("Ende der Beobachtung: kein gültiges Datum");
  if (input.end_date < today) bad("Das Ende der Beobachtung liegt in der Vergangenheit");
  const maxEnd = maxEndDate(today);
  if (input.end_date > maxEnd) bad(`Das Ende der Beobachtung darf höchstens zwei Jahre in der Zukunft liegen (bis ${maxEnd})`);
  const last = lastDeparture({
    trip_type: tripType,
    flexible,
    outbound_date: outbound,
    return_date: ret,
    date_from: from,
    date_until: until,
    min_nights: minNights,
    max_nights: maxNights,
  });
  if (last && input.end_date >= last) bad("Das Ende der Beobachtung muss vor dem letzten möglichen Hinflug liegen");

  return {
    origin: origin.join(","),
    destination: destination.join(","),
    trip_type: tripType,
    flexible,
    outbound_date: outbound,
    return_date: ret,
    date_from: from,
    date_until: until,
    min_nights: minNights,
    max_nights: maxNights,
    adults: input.adults,
    children,
    infants_on_lap: infants,
    travel_class: travelClass,
    max_stops: maxStops,
    airlines,
    airlines_mode: airlinesMode,
    outbound_times: outboundTimes,
    return_times: returnTimes,
    currency,
    limit_total: limit,
    end_date: input.end_date,
    paused: input.paused ?? false,
    notify_push: input.notify_push ?? true,
    notify_email: input.notify_email ?? true,
    checked_bag: input.checked_bag ?? true,
  };
}

// ── Shaping ──────────────────────────────────────────────────────────────────

function linkFor(w: FlightWatchRow, outbound: string, ret: string | null): string {
  return googleFlightsLink({
    origin: w.origin,
    destination: w.destination,
    outbound,
    return: ret,
    travelClass: w.travel_class,
    currency: w.currency,
  });
}

function toCheck(c: CheckRow): FlightCheck {
  return {
    id: c.id,
    checked_at: c.checked_at,
    searches: c.searches,
    outbound_date: c.outbound_date,
    return_date: c.return_date,
    flight_count: c.flight_count,
    lowest_price: c.lowest_price,
    lowest_airlines: c.lowest_airlines,
    lowest_stops: c.lowest_stops,
    price_level: c.price_level,
    typical_low: c.typical_low,
    typical_high: c.typical_high,
    below_limit: c.below_limit,
    bag_price: c.bag_price,
    error: c.error,
  };
}

/** The latest successful check of every date combination of the watches. */
async function latestPerCombination(watchIds: number[]): Promise<CheckRow[]> {
  if (!watchIds.length) return [];
  return db
    .selectDistinctOn([travelFlightChecks.watch_id, travelFlightChecks.outbound_date, travelFlightChecks.return_date])
    .from(travelFlightChecks)
    .where(and(inArray(travelFlightChecks.watch_id, watchIds), sql`${travelFlightChecks.error} IS NULL`))
    .orderBy(
      travelFlightChecks.watch_id,
      travelFlightChecks.outbound_date,
      travelFlightChecks.return_date,
      desc(travelFlightChecks.checked_at),
      desc(travelFlightChecks.id),
    );
}

/**
 * What a check's price counts as: with a checked bag when the watch wants
 * one and the check knows its price, else the price Google showed.
 */
export function countedPrice(w: Pick<FlightWatchRow, "checked_bag">, c: Pick<CheckRow, "lowest_price" | "bag_price">): number | null {
  if (c.lowest_price === null) return null;
  return w.checked_bag && c.bag_price !== null ? c.bag_price : c.lowest_price;
}

/** The cheapest of the latest checks of combinations still ahead. */
export function bestOf(w: FlightWatchRow, latest: CheckRow[], today: string): BestKnown | null {
  const ahead = new Set(combinationsOf(w, today).map(comboKey));
  let best: CheckRow | null = null;
  let bestPrice = Infinity;
  for (const c of latest) {
    const price = countedPrice(w, c);
    if (price === null || !ahead.has(comboKey({ start: c.outbound_date, end: c.return_date }))) continue;
    if (price < bestPrice) {
      best = c;
      bestPrice = price;
    }
  }
  if (!best) return null;
  return {
    price: bestPrice,
    outbound_date: best.outbound_date,
    return_date: best.return_date,
    airlines: best.lowest_airlines,
    stops: best.lowest_stops,
    checked_at: best.checked_at,
    link: linkFor(w, best.outbound_date, best.return_date),
    with_bag: w.checked_bag && best.bag_price !== null,
  };
}

function toWatch(w: FlightWatchRow, today: string, latest: CheckRow | null, perCombo: CheckRow[]): FlightWatch {
  const best = bestOf(w, perCombo, today);
  const combos = combinationsOf(w, today);
  const link = !w.flexible && w.outbound_date ? linkFor(w, w.outbound_date, w.return_date) : (best?.link ?? null);
  return {
    id: w.id,
    origin: w.origin,
    destination: w.destination,
    trip_type: w.trip_type as TripType,
    flexible: w.flexible,
    outbound_date: w.outbound_date,
    return_date: w.return_date,
    date_from: w.date_from,
    date_until: w.date_until,
    min_nights: w.min_nights,
    max_nights: w.max_nights,
    adults: w.adults,
    children: w.children,
    infants_on_lap: w.infants_on_lap,
    travel_class: w.travel_class,
    max_stops: w.max_stops,
    airlines: w.airlines,
    airlines_mode: (w.airlines_mode as AirlinesMode | null) ?? null,
    outbound_times: w.outbound_times,
    return_times: w.return_times,
    currency: w.currency,
    limit_total: w.limit_total,
    end_date: w.end_date,
    paused: w.paused,
    notify_push: w.notify_push,
    notify_email: w.notify_email,
    checked_bag: w.checked_bag,
    notified_price: w.notified_price,
    status: flightWatchStatus(w, today),
    last_checked_at: w.last_checked_at,
    last_error: w.last_error,
    combinations: combos.length,
    latest: latest ? toCheck(latest) : null,
    best,
    link,
    created_at: w.created_at,
  };
}

async function newestChecks(watchIds: number[]): Promise<Map<number, CheckRow>> {
  const map = new Map<number, CheckRow>();
  if (!watchIds.length) return map;
  const rows = await db
    .selectDistinctOn([travelFlightChecks.watch_id])
    .from(travelFlightChecks)
    .where(and(inArray(travelFlightChecks.watch_id, watchIds), sql`${travelFlightChecks.error} IS NULL`))
    .orderBy(travelFlightChecks.watch_id, desc(travelFlightChecks.checked_at), desc(travelFlightChecks.id));
  for (const r of rows) map.set(r.watch_id, r);
  return map;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function ownWatch(userId: number, id: number): Promise<FlightWatchRow> {
  const [row] = await db
    .select()
    .from(travelFlightWatches)
    .where(and(eq(travelFlightWatches.id, id), eq(travelFlightWatches.user_id, userId)));
  if (!row) throw APIError.notFound("Flugpreis-Wächter nicht gefunden");
  return row;
}

export async function listFlightWatches(userId: number, now: Date = new Date()): Promise<FlightWatch[]> {
  const rows = await db
    .select()
    .from(travelFlightWatches)
    .where(eq(travelFlightWatches.user_id, userId))
    .orderBy(sql`COALESCE(${travelFlightWatches.outbound_date}, ${travelFlightWatches.date_from})`, travelFlightWatches.id);
  const ids = rows.map((r) => r.id);
  const [newest, perCombo] = await Promise.all([newestChecks(ids), latestPerCombination(ids)]);
  const today = todayIso(now);
  return rows.map((r) => toWatch(r, today, newest.get(r.id) ?? null, perCombo.filter((c) => c.watch_id === r.id)));
}

export async function getFlightWatchDetail(userId: number, id: number, now: Date = new Date()): Promise<FlightWatchDetail> {
  const row = await ownWatch(userId, id);
  const today = todayIso(now);
  const [newest, perCombo] = await Promise.all([newestChecks([id]), latestPerCombination([id])]);
  const latest = newest.get(id) ?? null;
  const checks = await db
    .select()
    .from(travelFlightChecks)
    .where(eq(travelFlightChecks.watch_id, id))
    .orderBy(desc(travelFlightChecks.checked_at), desc(travelFlightChecks.id))
    .limit(HISTORY_LIMIT);
  const offers = latest
    ? await db
        .select()
        .from(travelFlightOffers)
        .where(eq(travelFlightOffers.check_id, latest.id))
        .orderBy(travelFlightOffers.price, travelFlightOffers.id)
    : [];

  const [withBookings] = await db
    .select({ check: travelFlightChecks })
    .from(travelFlightChecks)
    .where(
      and(
        eq(travelFlightChecks.watch_id, id),
        sql`EXISTS (SELECT 1 FROM ${travelFlightBookings} b WHERE b.check_id = ${travelFlightChecks.id})`,
      ),
    )
    .orderBy(desc(travelFlightChecks.checked_at), desc(travelFlightChecks.id))
    .limit(1);
  let bookings: FlightWatchDetail["bookings"] = null;
  if (withBookings) {
    const options = await db
      .select()
      .from(travelFlightBookings)
      .where(eq(travelFlightBookings.check_id, withBookings.check.id))
      .orderBy(travelFlightBookings.price, travelFlightBookings.id);
    bookings = {
      checked_at: withBookings.check.checked_at,
      outbound_date: withBookings.check.outbound_date,
      return_date: withBookings.check.return_date,
      options: options.map((o) => ({
        book_with: o.book_with,
        price: o.price,
        option_title: o.option_title,
        extensions: o.extensions,
        baggage: o.baggage,
      })),
    };
  }

  let history: FlightWatchDetail["history"] = null;
  if (latest) {
    const points = await db
      .select({ day: travelFlightPricePoints.day, price: travelFlightPricePoints.price })
      .from(travelFlightPricePoints)
      .where(
        and(
          eq(travelFlightPricePoints.watch_id, id),
          eq(travelFlightPricePoints.combo, comboKey({ start: latest.outbound_date, end: latest.return_date })),
        ),
      )
      .orderBy(travelFlightPricePoints.day);
    history = { outbound_date: latest.outbound_date, return_date: latest.return_date, points };
  }

  const byKey = new Map(perCombo.map((c) => [comboKey({ start: c.outbound_date, end: c.return_date }), c]));
  const combinations: FlightCombinationEntry[] = row.flexible
    ? combinationsOf(row, today).map((combo) => {
        const c = byKey.get(comboKey(combo));
        return {
          outbound_date: combo.start,
          return_date: combo.end,
          price: c ? countedPrice(row, c) : null,
          price_level: c?.price_level ?? null,
          checked_at: c?.checked_at ?? null,
          link: linkFor(row, combo.start, combo.end),
        };
      })
    : [];

  return {
    watch: toWatch(row, today, latest, perCombo),
    checks: checks.map(toCheck),
    offers: offers.map((o) => ({
      price: o.price,
      airlines: o.airlines,
      flight_numbers: o.flight_numbers,
      departs_at: o.departs_at,
      arrives_at: o.arrives_at,
      duration_min: o.duration_min,
      stops: o.stops,
      layovers: o.layovers,
      best: o.best,
    })),
    bookings,
    history,
    combinations,
  };
}

export async function createFlightWatch(userId: number, input: FlightWatchInput, now: Date = new Date()): Promise<FlightWatch> {
  const today = todayIso(now);
  const values = normalizeFlightWatchInput(input, today);
  const [row] = await db
    .insert(travelFlightWatches)
    .values({ user_id: userId, ...values })
    .returning();
  return toWatch(row, today, null, []);
}

/** The fields that make a report stale when they change. */
const CRITERIA = [
  "origin",
  "destination",
  "trip_type",
  "flexible",
  "outbound_date",
  "return_date",
  "date_from",
  "date_until",
  "min_nights",
  "max_nights",
  "adults",
  "children",
  "infants_on_lap",
  "travel_class",
  "max_stops",
  "airlines",
  "airlines_mode",
  "outbound_times",
  "return_times",
  "currency",
  "limit_total",
  "checked_bag",
] as const;

export async function updateFlightWatch(
  userId: number,
  id: number,
  input: FlightWatchInput,
  now: Date = new Date(),
): Promise<FlightWatch> {
  const before = await ownWatch(userId, id);
  const values = normalizeFlightWatchInput(input, todayIso(now));
  const sameCriteria = CRITERIA.every((k) => (values as Record<string, unknown>)[k] === before[k]);
  // A different window is a different rotation: start it over.
  const sameWindow =
    values.flexible === before.flexible &&
    values.trip_type === before.trip_type &&
    values.date_from === before.date_from &&
    values.date_until === before.date_until &&
    values.min_nights === before.min_nights &&
    values.max_nights === before.max_nights;
  await db
    .update(travelFlightWatches)
    .set({
      ...values,
      ...(sameCriteria ? {} : { notified_price: null, notified_at: null }),
      ...(sameWindow ? {} : { flex_rotation: -1 }),
      last_error: null,
      updated_at: now.toISOString(),
    })
    .where(eq(travelFlightWatches.id, id));
  return (await getFlightWatchDetail(userId, id, now)).watch;
}

export async function deleteFlightWatch(userId: number, id: number): Promise<void> {
  await ownWatch(userId, id);
  await db.delete(travelFlightWatches).where(eq(travelFlightWatches.id, id));
}

// ── Checking ─────────────────────────────────────────────────────────────────

function searchParams(w: FlightWatchRow, combo: DateCombo): FlightSearchParams {
  return {
    departure_id: w.origin,
    arrival_id: w.destination,
    outbound_date: combo.start,
    return_date: w.trip_type === "round" ? combo.end : null,
    adults: w.adults,
    children: w.children,
    infants_on_lap: w.infants_on_lap,
    travel_class: w.travel_class,
    stops: stopsParam(w.max_stops),
    include_airlines: w.airlines_mode === "include" ? w.airlines : null,
    exclude_airlines: w.airlines_mode === "exclude" ? w.airlines : null,
    outbound_times: w.outbound_times,
    return_times: w.return_times,
    currency: w.currency,
  };
}

/** The combination a check takes: the fixed dates, or the next one in turn. */
export function nextCombination(w: FlightWatchRow, today: string): { combo: DateCombo; index: number } | null {
  const combos = combinationsOf(w, today);
  if (!combos.length) return null;
  if (!w.flexible) return { combo: combos[0]!, index: 0 };
  return rotationPick(combos, w.flex_rotation);
}

/**
 * Who sells the cheapest flight: on a round trip its return flights first
 * (one search), then the booking options of the cheapest (one more); one
 * way directly. Best effort: nothing when the budget or a token is missing.
 */
async function fetchBookings(
  w: FlightWatchRow,
  combo: DateCombo,
  cheapest: FlightOffer,
  client: FlightSearchClient,
  searchesLeft: number,
): Promise<{ options: BookingOption[]; searches: number }> {
  const base = searchParams(w, combo);
  let searches = 0;
  let bookingToken = cheapest.bookingToken;
  if (!bookingToken && cheapest.departureToken) {
    if (searchesLeft < 2) return { options: [], searches };
    searches++;
    const returns = flightsOf(await client.search({ ...base, departure_token: cheapest.departureToken }));
    bookingToken = returns.find((r) => r.bookingToken)?.bookingToken ?? null;
  }
  if (!bookingToken || searchesLeft - searches < 1) return { options: [], searches };
  searches++;
  const options = bookingOptionsOf(await client.search({ ...base, booking_token: bookingToken }));
  return { options, searches };
}

/**
 * One check: search the watch's next date combination, write the check,
 * its flights and Google's price history, move the rotation on. A failed
 * search is a check too, with its error and the search it cost.
 */
export async function checkFlightWatch(
  watch: FlightWatchRow,
  client: FlightSearchClient,
  now: Date = new Date(),
  options: { alert?: boolean } = {},
): Promise<FlightCheck> {
  const today = todayIso(now);
  const used = await searchesThisMonth(now);
  const budget = monthlySearchBudget();
  if (used >= budget) throw new SearchBudgetExhausted(used, budget);
  const pick = nextCombination(watch, today);
  if (!pick) throw APIError.failedPrecondition("Für diesen Wächter liegt kein Reisedatum mehr in der Zukunft");
  const { combo, index } = pick;

  let searches = 0;
  let offers: FlightOffer[] = [];
  let insight = insightOf(null);
  let error: string | null = null;
  try {
    searches++;
    const answer = await client.search(searchParams(watch, combo));
    offers = flightsOf(answer);
    insight = insightOf(answer);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const cheapest = offers[0] ?? null;
  const belowLimit = error === null && cheapest !== null && watch.limit_total !== null && cheapest.price < watch.limit_total;
  const checkedAt = now.toISOString();
  const key = comboKey(combo);

  const check = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(travelFlightChecks)
      .values({
        watch_id: watch.id,
        checked_at: checkedAt,
        searches,
        outbound_date: combo.start,
        return_date: combo.end,
        flight_count: offers.length,
        lowest_price: cheapest?.price ?? null,
        lowest_airlines: cheapest?.airlines ?? null,
        lowest_stops: cheapest?.stops ?? null,
        price_level: insight.level,
        typical_low: insight.typicalLow,
        typical_high: insight.typicalHigh,
        below_limit: belowLimit,
        error,
      })
      .returning();
    if (offers.length) {
      await tx.insert(travelFlightOffers).values(
        offers.slice(0, OFFERS_KEPT).map((o) => ({
          check_id: c.id,
          price: o.price,
          airlines: o.airlines,
          flight_numbers: o.flightNumbers,
          departs_at: o.departsAt,
          arrives_at: o.arrivesAt,
          duration_min: o.durationMin,
          stops: o.stops,
          layovers: o.layovers,
          best: o.best,
        })),
      );
    }
    if (insight.history.length) {
      await tx
        .insert(travelFlightPricePoints)
        .values(insight.history.map((p) => ({ watch_id: watch.id, combo: key, day: p.day, price: p.price })))
        .onConflictDoUpdate({
          target: [travelFlightPricePoints.watch_id, travelFlightPricePoints.combo, travelFlightPricePoints.day],
          set: { price: sql`excluded.price` },
        });
    }
    await tx
      .update(travelFlightWatches)
      .set({ last_checked_at: checkedAt, last_error: error, flex_rotation: index })
      .where(eq(travelFlightWatches.id, watch.id));
    return c;
  });

  if (options.alert && error === null) {
    const extra = await reportFlightPrice(watch, check, combo, cheapest, client, budget - used - searches, now);
    if (extra) {
      check.searches += extra;
      await db.update(travelFlightChecks).set({ searches: check.searches }).where(eq(travelFlightChecks.id, check.id));
    }
  }
  return toCheck(check);
}

/** Travellers with a seat of their own, each with a checked bag. */
export function seatedTravellers(w: Pick<FlightWatchRow, "adults" | "children">): number {
  return w.adults + w.children;
}

/**
 * The price of this check's cheapest flight with a checked bag, written to
 * the check. A previous check of the same dates whose flight was not
 * cheaper lends its bag fee (no searches); otherwise the booking options are
 * fetched. Returns the options read and the searches spent.
 */
async function priceTheBag(
  watch: FlightWatchRow,
  check: CheckRow,
  combo: DateCombo,
  cheapest: FlightOffer,
  client: FlightSearchClient,
  searchesLeft: number,
): Promise<{ bookings: BookingOption[]; searches: number; fetched: boolean }> {
  const [previous] = await db
    .select()
    .from(travelFlightChecks)
    .where(
      and(
        eq(travelFlightChecks.watch_id, watch.id),
        eq(travelFlightChecks.outbound_date, combo.start),
        combo.end === null ? sql`${travelFlightChecks.return_date} IS NULL` : eq(travelFlightChecks.return_date, combo.end),
        sql`${travelFlightChecks.id} <> ${check.id}`,
        sql`${travelFlightChecks.bag_price} IS NOT NULL`,
        sql`${travelFlightChecks.error} IS NULL`,
      ),
    )
    .orderBy(desc(travelFlightChecks.checked_at), desc(travelFlightChecks.id))
    .limit(1);
  let bagPrice: number | null = null;
  let bookings: BookingOption[] = [];
  let searches = 0;
  let fetched = false;
  if (previous && previous.lowest_price !== null && previous.lowest_price <= cheapest.price) {
    bagPrice = cheapest.price + (previous.bag_price! - previous.lowest_price);
  } else {
    try {
      const got = await fetchBookings(watch, combo, cheapest, client, searchesLeft);
      bookings = got.options;
      searches = got.searches;
      fetched = true;
      bagPrice = cheapestWithBag(bookings, seatedTravellers(watch));
    } catch (err) {
      console.warn(`[travel.flight-watch] booking options for watch ${watch.id}: ${err instanceof Error ? err.message : err}`);
      searches = Math.max(searches, 1);
    }
  }
  if (bagPrice !== null) {
    check.bag_price = bagPrice;
    check.below_limit = watch.limit_total !== null && bagPrice < watch.limit_total;
    await db
      .update(travelFlightChecks)
      .set({ bag_price: bagPrice, below_limit: check.below_limit })
      .where(eq(travelFlightChecks.id, check.id));
  }
  return { bookings, searches, fetched };
}

async function keepBookings(checkId: number, bookings: BookingOption[]): Promise<void> {
  if (!bookings.length) return;
  await db.insert(travelFlightBookings).values(
    bookings.map((b) => ({
      check_id: checkId,
      book_with: b.bookWith,
      price: b.price,
      option_title: b.optionTitle,
      extensions: b.extensions,
      baggage: b.baggage,
    })),
  );
}

/**
 * Report the best known price if `alertDecision` says so. Returns the
 * searches spent on booking options. The report counts as made once tried.
 *
 * With `checked_bag`, a price about to be reported that is this check's
 * flight first gets its price with a bag (`priceTheBag`), and the decision
 * is made again on that.
 */
async function reportFlightPrice(
  watch: FlightWatchRow,
  check: CheckRow,
  combo: DateCombo,
  cheapest: FlightOffer | null,
  client: FlightSearchClient,
  searchesLeft: number,
  now: Date,
): Promise<number> {
  const today = todayIso(now);
  const isThisCheck = (b: BestKnown) =>
    b.outbound_date === combo.start && b.return_date === combo.end && cheapest !== null;

  let best = bestOf(watch, await latestPerCombination([watch.id]), today);
  let decision = alertDecision(watch.limit_total, best?.price ?? null, watch.notified_price);
  let bookings: BookingOption[] = [];
  let searches = 0;
  let bookingsFetched = false;

  if (decision.kind === "report" && watch.checked_bag && best && isThisCheck(best) && check.bag_price === null) {
    const priced = await priceTheBag(watch, check, combo, cheapest!, client, searchesLeft);
    bookings = priced.bookings;
    searches = priced.searches;
    bookingsFetched = priced.fetched;
    await keepBookings(check.id, bookings);
    best = bestOf(watch, await latestPerCombination([watch.id]), today);
    decision = alertDecision(watch.limit_total, best?.price ?? null, watch.notified_price);
  }

  if (decision.kind === "none") return searches;
  if (decision.kind === "reset") {
    await db
      .update(travelFlightWatches)
      .set({ notified_price: null, notified_at: null })
      .where(eq(travelFlightWatches.id, watch.id));
    return searches;
  }
  const found = best!;
  await db
    .update(travelFlightWatches)
    .set({ notified_price: found.price, notified_at: now.toISOString() })
    .where(eq(travelFlightWatches.id, watch.id));
  if (!watch.notify_push && !watch.notify_email) return searches;

  // Who sells it: only for the flight of this check, the tokens of others are gone.
  const thisCheck = isThisCheck(found);
  if (thisCheck && !bookingsFetched && !bookings.length) {
    try {
      const fetched = await fetchBookings(watch, combo, cheapest!, client, searchesLeft - searches);
      bookings = fetched.options;
      searches += fetched.searches;
      await keepBookings(check.id, bookings);
    } catch (err) {
      console.warn(`[travel.flight-watch] booking options for watch ${watch.id}: ${err instanceof Error ? err.message : err}`);
      searches = Math.max(searches, 1);
    }
  }

  const alert: FlightPriceAlert = {
    userId: watch.user_id,
    watchId: watch.id,
    route: `${watch.origin.replaceAll(",", "/")} → ${watch.destination.replaceAll(",", "/")}`,
    outbound: found.outbound_date,
    return: found.return_date,
    currency: watch.currency,
    price: found.price,
    limit: watch.limit_total!,
    passengers: watch.adults + watch.children + watch.infants_on_lap,
    airlines: found.airlines ?? "–",
    stops: found.stops ?? 0,
    level: thisCheck ? check.price_level : null,
    bookings,
    link: found.link,
    newLow: decision.newLow,
    bag: watch.checked_bag ? (found.with_bag ? "included" : "unknown") : null,
    seated: seatedTravellers(watch),
  };
  const sender = flightAlertSender();
  const failed = (channel: string) => (err: unknown) =>
    console.warn(`[travel.flight-watch] ${channel} for watch ${watch.id} failed: ${err instanceof Error ? err.message : err}`);
  if (watch.notify_push) await sender.push(alert).catch(failed("push"));
  if (watch.notify_email) {
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, watch.user_id));
    if (owner?.email) await sender.email(alert, owner.email).catch(failed("mail"));
  }
  return searches;
}

/** "Check now" from the page: the user's own watch, if it is still running. */
export async function checkFlightWatchNow(
  userId: number,
  id: number,
  client: FlightSearchClient,
  now: Date = new Date(),
): Promise<FlightCheck> {
  const watch = await ownWatch(userId, id);
  if (flightWatchStatus(watch, todayIso(now)) === "ended") {
    throw APIError.failedPrecondition("Die Beobachtung ist beendet");
  }
  try {
    return await checkFlightWatch(watch, client, now);
  } catch (err) {
    if (err instanceof SearchBudgetExhausted) throw APIError.resourceExhausted(err.message);
    throw err;
  }
}

export interface FlightRunResult {
  due: number;
  checked: number;
  failed: number;
  skippedBudget: number;
}

/** The job: every running watch not checked within `MIN_CHECK_GAP_MS`, oldest check first. */
export async function runDueFlightChecks(client: FlightSearchClient, now: Date = new Date()): Promise<FlightRunResult> {
  const today = todayIso(now);
  const cutoff = new Date(now.getTime() - MIN_CHECK_GAP_MS).toISOString();
  const rows = (
    await db
      .select()
      .from(travelFlightWatches)
      .where(
        and(
          eq(travelFlightWatches.paused, false),
          sql`${travelFlightWatches.end_date} >= ${today}`,
          sql`(${travelFlightWatches.last_checked_at} IS NULL OR ${travelFlightWatches.last_checked_at} < ${cutoff})`,
        ),
      )
      .orderBy(sql`${travelFlightWatches.last_checked_at} ASC NULLS FIRST`, travelFlightWatches.id)
  ).filter((w) => flightWatchStatus(w, today) === "active");

  const result: FlightRunResult = { due: rows.length, checked: 0, failed: 0, skippedBudget: 0 };
  for (const [i, watch] of rows.entries()) {
    try {
      const check = await checkFlightWatch(watch, client, now, { alert: true });
      result.checked++;
      if (check.error) result.failed++;
    } catch (err) {
      if (err instanceof SearchBudgetExhausted) {
        result.skippedBudget = rows.length - i;
        break;
      }
      result.failed++;
      console.warn(`[travel.flight-watch] watch ${watch.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
