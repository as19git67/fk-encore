/**
 * Area watches: Google Hotels' result list for a place, narrowed by stars
 * and guest rating.
 *
 * Google rates guests on a 1–5 scale; the filter codes SerpApi takes are
 * 7 (3.5+), 8 (4.0+) and 9 (4.5+). Booking.com's "8+" is about Google's 4.0+.
 * The list shows only each hotel's lowest price, not its cancellation terms,
 * so a check reads the details of the cheapest few hits.
 *
 * Plain functions without I/O.
 */

/** Guest ratings a watch may ask for, on Google's 1–5 scale. */
export const AREA_RATINGS = [3.5, 4, 4.5] as const;
/** Lowest hotel class a watch may ask for. */
export const AREA_MIN_STARS = 2;
/** Hotels of a result list whose details a check reads. */
export const AREA_DETAILS = 2;

export interface AreaHotel {
  name: string;
  token: string;
  /** The lowest price per night the list shows. */
  perNight: number;
  stars: number | null;
  rating: number | null;
}

export interface AreaFilter {
  minStars: number | null;
  minRating: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** SerpApi's `rating` code for a minimum guest rating, or null. */
export function ratingCode(minRating: number | null): number | null {
  if (minRating === null) return null;
  if (minRating >= 4.5) return 9;
  if (minRating >= 4) return 8;
  if (minRating >= 3.5) return 7;
  return null;
}

/** SerpApi's `hotel_class` list for a minimum number of stars, empty for none. */
export function hotelClasses(minStars: number | null): number[] {
  if (minStars === null) return [];
  const out: number[] = [];
  for (let s = Math.max(AREA_MIN_STARS, minStars); s <= 5; s++) out.push(s);
  return out;
}

/** Stars from `extracted_hotel_class`, else from "4-star hotel" / "4-Sterne-Hotel". */
function starsOf(p: any): number | null {
  const n = num(p?.extracted_hotel_class);
  if (n !== null) return n;
  const m = /(\d)/.exec(str(p?.hotel_class) ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The hotels of a result list that meet the filter, cheapest first. Google
 * already filters; this checks again, because a list can carry ads and
 * vacation rentals beside the hotels. A hotel without stars or rating does
 * not meet a filter that asks for them.
 */
export function areaHotels(answer: any, filter: AreaFilter): AreaHotel[] {
  const out: AreaHotel[] = [];
  const seen = new Set<string>();
  for (const p of answer?.properties ?? []) {
    const name = str(p?.name);
    const token = str(p?.property_token);
    const perNight = num(p?.rate_per_night?.extracted_lowest);
    if (!name || !token || perNight === null || seen.has(token)) continue;
    if (str(p?.type) && !/hotel/i.test(p.type)) continue;
    const stars = starsOf(p);
    const rating = num(p?.overall_rating);
    if (filter.minStars !== null && (stars === null || stars < filter.minStars)) continue;
    if (filter.minRating !== null && (rating === null || rating < filter.minRating)) continue;
    seen.add(token);
    out.push({ name, token, perNight, stars, rating });
  }
  return out.sort((a, b) => a.perNight - b.perNight);
}
