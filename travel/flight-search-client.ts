/**
 * SerpApi as the source of flight prices (`engine=google_flights`).
 *
 * Same key as the hotel client (secret `SerpApiKey`), sent only as the
 * `api_key` URL parameter. The client is a seam: the tests set a fake with
 * `setFlightSearchClient`.
 */

import { secret } from "encore.dev/config";
import { HotelSearchError } from "./serpapi-client";

export interface FlightSearchParams {
  departure_id: string;
  arrival_id: string;
  outbound_date: string;
  /** Null: one way. */
  return_date: string | null;
  adults: number;
  children: number;
  infants_on_lap: number;
  travel_class: number;
  /** SerpApi's `stops`: 0 any, 1 nonstop, 2 at most one, 3 at most two. */
  stops: number;
  include_airlines?: string | null;
  exclude_airlines?: string | null;
  outbound_times?: string | null;
  return_times?: string | null;
  currency: string;
  /** The return flights of a chosen outbound flight (round trip). */
  departure_token?: string | null;
  /** The booking options of a chosen flight. */
  booking_token?: string | null;
}

export interface FlightSearchClient {
  search(params: FlightSearchParams): Promise<any>;
}

const ENDPOINT = "https://serpapi.com/search.json";
const TIMEOUT_MS = 45_000;

/** The query SerpApi gets for `params`, without the key. */
export function flightQuery(params: FlightSearchParams): Record<string, string> {
  const q: Record<string, string> = {
    engine: "google_flights",
    hl: "de",
    gl: "de",
    departure_id: params.departure_id,
    arrival_id: params.arrival_id,
    type: params.return_date ? "1" : "2",
    outbound_date: params.outbound_date,
    adults: String(params.adults),
    travel_class: String(params.travel_class),
    stops: String(params.stops),
    currency: params.currency,
  };
  if (params.return_date) q.return_date = params.return_date;
  if (params.children) q.children = String(params.children);
  if (params.infants_on_lap) q.infants_on_lap = String(params.infants_on_lap);
  if (params.include_airlines) q.include_airlines = params.include_airlines;
  if (params.exclude_airlines) q.exclude_airlines = params.exclude_airlines;
  if (params.outbound_times) q.outbound_times = params.outbound_times;
  if (params.return_date && params.return_times) q.return_times = params.return_times;
  if (params.booking_token) q.booking_token = params.booking_token;
  else if (params.departure_token) q.departure_token = params.departure_token;
  return q;
}

export function createFlightSearchClient(key: string, fetchImpl: typeof fetch = fetch): FlightSearchClient {
  return {
    async search(params) {
      const url = new URL(ENDPOINT);
      for (const [k, v] of Object.entries(flightQuery(params))) url.searchParams.set(k, v);
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
    },
  };
}

/** The same secret the hotel client reads (one key for the deployment). */
const serpApiKey = secret("SerpApiKey");

function keyValue(): string | null {
  try {
    return serpApiKey().trim() || null;
  } catch {
    return null;
  }
}

let override: FlightSearchClient | null | undefined;

/** Tests: a fake client, `null` for "no key configured", `undefined` to reset. */
export function setFlightSearchClient(client: FlightSearchClient | null | undefined): void {
  override = client;
}

export function flightSearchClient(): FlightSearchClient | null {
  if (override !== undefined) return override;
  const key = keyValue();
  return key ? createFlightSearchClient(key) : null;
}
