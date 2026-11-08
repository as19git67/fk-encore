/**
 * Reading a Google Hotels answer from SerpApi (`engine=google_hotels`).
 *
 * Prices stand per provider → room → rate. Cancellation and breakfast stand
 * only on the rate, so every rate becomes one offer; a provider without a
 * room list (only in `prices`) comes in with its best price, its
 * cancellation terms unknown (`null`) and without breakfast. An unknown term
 * never meets "free cancellation only" — a guess in the user's favour would
 * raise false alarms — but the page shows the offer with its link. Prices include taxes; a resort or destination fee the
 * hotel charges on site is not in them.
 *
 * Plain functions without I/O, so the tests feed them a synthetic answer.
 */

export interface HotelOffer {
  source: string;
  room: string;
  perNight: number;
  total: number | null;
  /** Null when Google names no cancellation terms for the provider. */
  freeCancellation: boolean | null;
  cancelUntil: string | null;
  breakfast: boolean;
  guests: number | null;
  link: string | null;
  /** Rooms the offer books; `perNight` and `total` are for all of them. */
  rooms: number;
}

export interface OfferConditions {
  freeCancellationOnly: boolean;
  breakfastRequired: boolean;
}

export interface OfferSummary {
  lowest: HotelOffer | null;
  lowestFree: HotelOffer | null;
  lowestFreeBreakfast: HotelOffer | null;
  /** The cheapest offer that meets the watch's conditions. */
  matching: HotelOffer | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Only http(s) links reach the page. */
const url = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/** Every rate of a hotel's detail answer, cheapest first, for at least `guests` people. */
export function offersOf(detail: any, guests: number): HotelOffer[] {
  const offers: HotelOffer[] = [];
  const withRooms = new Set<string>();
  for (const fp of detail?.featured_prices ?? []) {
    const source = str(fp?.source);
    if (!source) continue;
    for (const room of fp.rooms ?? []) {
      for (const rate of room?.rates ?? []) {
        const perNight = num(rate?.rate_per_night?.extracted_lowest);
        if (perNight === null) continue;
        withRooms.add(source);
        offers.push({
          source,
          room: str(room.name) ?? "(ohne Zimmerangabe)",
          perNight,
          total: num(rate?.total_rate?.extracted_lowest),
          freeCancellation: rate.free_cancellation === true,
          cancelUntil: str(rate.free_cancellation_until_date),
          breakfast: rate.breakfast_included === true,
          guests: num(rate.num_guests ?? room.num_guests),
          link: url(rate.link) ?? url(room.link) ?? url(fp.link),
          rooms: 1,
        });
      }
    }
  }
  for (const p of [...(detail?.featured_prices ?? []), ...(detail?.prices ?? [])]) {
    const source = str(p?.source);
    if (!source || withRooms.has(source)) continue;
    const perNight = num(p?.rate_per_night?.extracted_lowest);
    if (perNight === null) continue;
    withRooms.add(source);
    offers.push({
      source,
      room: "(ohne Zimmerangabe)",
      perNight,
      total: num(p?.total_rate?.extracted_lowest),
      freeCancellation: null,
      cancelUntil: null,
      breakfast: false,
      guests: num(p.num_guests),
      link: url(p.link),
      rooms: 1,
    });
  }
  return offers
    .filter((o) => o.guests === null || o.guests >= guests)
    .sort((a, b) => a.perNight - b.perNight);
}

/** Adults per room when a watch also prices double rooms. */
export const ADULTS_PER_ROOM = 2;

/**
 * How many double rooms a party fills, or null when it cannot be split
 * evenly: only adults, an even number, at least two rooms.
 */
export function splitRoomCount(adults: number, childrenAges: number[]): number | null {
  if (childrenAges.length > 0) return null;
  if (adults < 2 * ADULTS_PER_ROOM || adults % ADULTS_PER_ROOM !== 0) return null;
  return adults / ADULTS_PER_ROOM;
}

/**
 * The offers of a search for one double room, booked `rooms` times: the
 * price is for all rooms together, so it compares with a room for the whole
 * party. Google shows the price of one room; whether that many are free is
 * only seen at the provider.
 */
export function asRooms(offers: HotelOffer[], rooms: number): HotelOffer[] {
  return offers.map((o) => ({
    ...o,
    room: `${rooms} × ${o.room}`,
    perNight: o.perNight * rooms,
    total: o.total === null ? null : o.total * rooms,
    guests: o.guests === null ? null : o.guests * rooms,
    rooms,
  }));
}

/** Two lists from `offersOf`/`asRooms` as one, cheapest first. */
export function mergeOffers(a: HotelOffer[], b: HotelOffer[]): HotelOffer[] {
  return [...a, ...b].sort((x, y) => x.perNight - y.perNight);
}

export function meetsConditions(offer: HotelOffer, conditions: OfferConditions): boolean {
  if (conditions.freeCancellationOnly && offer.freeCancellation !== true) return false;
  if (conditions.breakfastRequired && !offer.breakfast) return false;
  return true;
}

/** `offers` must be sorted cheapest first, as `offersOf` returns them. */
export function summarize(offers: HotelOffer[], conditions: OfferConditions): OfferSummary {
  return {
    lowest: offers[0] ?? null,
    lowestFree: offers.find((o) => o.freeCancellation === true) ?? null,
    lowestFreeBreakfast: offers.find((o) => o.freeCancellation === true && o.breakfast) ?? null,
    matching: offers.find((o) => meetsConditions(o, conditions)) ?? null,
  };
}

/** True when the answer is the detail page of one hotel, not a result list. */
export function isHotelDetail(answer: any): boolean {
  return Boolean(str(answer?.property_token)) && Array.isArray(answer?.featured_prices ?? answer?.prices);
}

/**
 * The hit of a result list that the query names: a property whose name
 * contains the query or is contained in it (case and accents ignored),
 * otherwise the first. Null when the list is empty.
 */
export function pickProperty(answer: any, query: string): { name: string; token: string } | null {
  const fold = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const q = fold(query);
  const hits = ((answer?.properties ?? []) as any[])
    .map((p) => ({ name: str(p?.name), token: str(p?.property_token) }))
    .filter((p): p is { name: string; token: string } => p.name !== null && p.token !== null);
  const named = hits.find((p) => {
    const n = fold(p.name);
    return n.includes(q) || q.includes(n);
  });
  return named ?? hits[0] ?? null;
}
