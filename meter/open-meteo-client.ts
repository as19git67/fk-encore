/**
 * Open-Meteo for the utility meters (#1023 follow-up): daily mean
 * temperatures from the **archive** (ERA5 reanalysis, no key, back to 1940,
 * about five days behind today) and the **geocoding** search that turns a
 * place name into a coordinate.
 *
 * Same house rules as `trip-planner/weather-client.ts`: the coordinate is
 * snapped to the ~5 km grid before it leaves the house, calls time out, and
 * the clients are swappable so tests never reach a third party. Hosts that
 * have to be in the environment's network policy:
 * `archive-api.open-meteo.com` and `geocoding-api.open-meteo.com`.
 */

import { roundToGrid } from "../trip-planner/weather-client";

const TIMEOUT_MS = 15_000;

export interface DailyMeanTemperature {
  /** `YYYY-MM-DD` */
  day: string;
  /** null where the archive has no value for that day. */
  meanC: number | null;
}

export interface ArchiveClient {
  /** Daily mean temperature for `from` … `to` inclusive, both `YYYY-MM-DD`. */
  dailyMeanTemperature(lat: number, lon: number, from: string, to: string): Promise<DailyMeanTemperature[]>;
}

export interface GeocodeCandidate {
  name: string;
  /** Region / state, when the source knows one. */
  admin1: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

export interface GeocodingClient {
  search(query: string, limit: number): Promise<GeocodeCandidate[]>;
}

export class OpenMeteoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeteoUnavailableError";
  }
}

async function fetchJson(url: URL, what: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new OpenMeteoUnavailableError(`open-meteo ${what} answered ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof OpenMeteoUnavailableError) throw err;
    throw new OpenMeteoUnavailableError(
      err instanceof Error ? err.message : `open-meteo ${what} could not be reached`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function parseDailyMeans(body: unknown): DailyMeanTemperature[] {
  const daily = (body as { daily?: unknown } | null)?.daily as
    | { time?: unknown; temperature_2m_mean?: unknown }
    | undefined;
  if (!daily || !Array.isArray(daily.time)) {
    throw new OpenMeteoUnavailableError("open-meteo archive answered without a daily block");
  }
  const values = Array.isArray(daily.temperature_2m_mean) ? daily.temperature_2m_mean : [];
  return daily.time.map((day, index): DailyMeanTemperature => {
    const value = values[index];
    return {
      day: String(day),
      meanC: typeof value === "number" && Number.isFinite(value) ? value : null,
    };
  });
}

export function parseGeocodeCandidates(body: unknown): GeocodeCandidate[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry): GeocodeCandidate | null => {
      const row = entry as Record<string, unknown>;
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || typeof row.name !== "string") return null;
      return {
        name: row.name,
        admin1: typeof row.admin1 === "string" ? row.admin1 : null,
        country: typeof row.country === "string" ? row.country : null,
        lat,
        lon,
      };
    })
    .filter((entry): entry is GeocodeCandidate => entry !== null);
}

export class OpenMeteoArchiveClient implements ArchiveClient {
  async dailyMeanTemperature(lat: number, lon: number, from: string, to: string) {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", roundToGrid(lat).toFixed(2));
    url.searchParams.set("longitude", roundToGrid(lon).toFixed(2));
    url.searchParams.set("start_date", from);
    url.searchParams.set("end_date", to);
    url.searchParams.set("daily", "temperature_2m_mean");
    // Degree days are a calendar-day figure of the place, so the day
    // boundary follows the local clock there; "auto" lets the API resolve
    // the zone of the coordinate.
    url.searchParams.set("timezone", "auto");
    return parseDailyMeans(await fetchJson(url, "archive"));
  }
}

export class OpenMeteoGeocodingClient implements GeocodingClient {
  async search(query: string, limit: number) {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query);
    url.searchParams.set("count", String(limit));
    url.searchParams.set("language", "de");
    url.searchParams.set("format", "json");
    return parseGeocodeCandidates(await fetchJson(url, "geocoding"));
  }
}

let archive: ArchiveClient = new OpenMeteoArchiveClient();
let geocoding: GeocodingClient = new OpenMeteoGeocodingClient();

export function getArchiveClient(): ArchiveClient {
  return archive;
}
/** Replace the archive client — tests never leave the house. */
export function setArchiveClient(client: ArchiveClient): void {
  archive = client;
}
export function resetArchiveClient(): void {
  archive = new OpenMeteoArchiveClient();
}
export function getGeocodingClient(): GeocodingClient {
  return geocoding;
}
export function setGeocodingClient(client: GeocodingClient): void {
  geocoding = client;
}
export function resetGeocodingClient(): void {
  geocoding = new OpenMeteoGeocodingClient();
}
