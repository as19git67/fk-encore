/**
 * SerpApi as the source of hotel prices (Google Hotels).
 *
 * The key is the secret `SerpApiKey` (env `SERPAPI_API_KEY`). SerpApi reads
 * it only from the `api_key` URL parameter, never from a header. Without a
 * key there is no client, and the job and "check now" say so instead of
 * failing on every watch.
 *
 * The client is a seam: the tests set a fake with `setHotelSearchClient`.
 */

import { secret } from "encore.dev/config";

export interface HotelSearchParams {
  q: string;
  check_in_date: string;
  check_out_date: string;
  adults: number;
  children_ages: number[];
  currency: string;
  property_token?: string | null;
  /** Area search: Google's hotel classes to keep, e.g. [4, 5]. */
  hotel_class?: number[];
  /** Area search: Google's guest rating code (7 = 3.5+, 8 = 4.0+, 9 = 4.5+). */
  rating?: number | null;
  /** Area search: only hotels with a freely cancellable rate. */
  free_cancellation?: boolean;
  /** Area search: Google's order (3 = lowest price). */
  sort_by?: number | null;
}

export interface PriceCalendarParams {
  property_token: string;
  /** First and last arrival day of the calendar. */
  start_date: string;
  end_date: string;
  adults: number;
  children_ages: number[];
  currency: string;
}

export interface HotelSearchClient {
  /** One SerpApi search; resolves with the raw JSON answer. */
  search(params: HotelSearchParams): Promise<any>;
  /**
   * One price calendar search (`engine=google_hotels_price_calendar`): the
   * best price of a one-night stay for every arrival day of the range.
   */
  calendar?(params: PriceCalendarParams): Promise<any>;
}

export class HotelSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotelSearchError";
  }
}

const serpApiKey = secret("SerpApiKey");
const ENDPOINT = "https://serpapi.com/search.json";
const TIMEOUT_MS = 30_000;

export function createSerpApiClient(key: string, fetchImpl: typeof fetch = fetch): HotelSearchClient {
  async function get(query: Record<string, string>): Promise<any> {
    const url = new URL(ENDPOINT);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", key);

    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new HotelSearchError(`SerpApi nicht erreichbar: ${err instanceof Error ? err.message : err}`);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new HotelSearchError(`SerpApi antwortete mit HTTP ${res.status} ohne JSON`);
    }
    if (body?.error) throw new HotelSearchError(`SerpApi: ${body.error}`);
    if (!res.ok) throw new HotelSearchError(`SerpApi antwortete mit HTTP ${res.status}`);
    return body;
  }

  return {
    async calendar(params) {
      const query: Record<string, string> = {
        engine: "google_hotels_price_calendar",
        hl: "de",
        gl: "de",
        property_token: params.property_token,
        start_date: params.start_date,
        end_date: params.end_date,
        adults: String(params.adults),
        currency: params.currency,
      };
      if (params.children_ages.length) {
        query.children = String(params.children_ages.length);
        query.children_ages = params.children_ages.join(",");
      }
      return get(query);
    },
    async search(params) {
      const query: Record<string, string> = {
        engine: "google_hotels",
        hl: "de",
        gl: "de",
        q: params.q,
        check_in_date: params.check_in_date,
        check_out_date: params.check_out_date,
        adults: String(params.adults),
        currency: params.currency,
      };
      if (params.children_ages.length) {
        query.children = String(params.children_ages.length);
        query.children_ages = params.children_ages.join(",");
      }
      if (params.property_token) query.property_token = params.property_token;
      if (params.hotel_class?.length) query.hotel_class = params.hotel_class.join(",");
      if (params.rating) query.rating = String(params.rating);
      if (params.free_cancellation) query.free_cancellation = "true";
      if (params.sort_by) query.sort_by = String(params.sort_by);
      return get(query);
    },
  };
}

let override: HotelSearchClient | null | undefined;

/** Tests: a fake client, `null` for "no key configured", `undefined` to reset. */
export function setHotelSearchClient(client: HotelSearchClient | null | undefined): void {
  override = client;
}

export function hotelSearchClient(): HotelSearchClient | null {
  if (override !== undefined) return override;
  let key = "";
  try {
    key = serpApiKey().trim();
  } catch {
    return null;
  }
  return key ? createSerpApiClient(key) : null;
}

/** Searches per calendar month the deployment may spend (SerpApi's free plan: 250). */
export function monthlySearchBudget(): number {
  const raw = Number(process.env.TRAVEL_SERPAPI_MONTHLY_SEARCHES);
  return Number.isInteger(raw) && raw > 0 ? raw : 250;
}
