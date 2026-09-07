/**
 * Fetching the forecast (§7.2).
 *
 * [Open-Meteo](https://open-meteo.com): hourly `precipitation`,
 * `cloud_cover`, `temperature_2m` and `relative_humidity_2m`, no API
 * key, no registration, worldwide. `api.open-meteo.com` has to be in
 * the environment's network policy; without it every call here fails
 * the same way as a timeout, which the caller already has to handle.
 *
 * **What leaves the house is a coordinate rounded to about five
 * kilometres, and a date.** That is enough for a city forecast and
 * useless as a movement profile — §7.2 states the rule and this is
 * where it is kept, at the one place a request is built. Rounding also
 * happens to be why the cache works: everybody in the same city asks
 * the same question.
 */

import log from "encore.dev/log";
import type { ForecastHour } from "./weather";

/**
 * The grid the coordinate is snapped to, in degrees.
 *
 * 0.05° is about 5.5 km north-south and less east-west — the size of a
 * city district, well below what a forecast resolves and well above
 * what identifies a hotel.
 */
export const GRID_DEGREES = 0.05;

const FORECAST_TIMEOUT_MS = 8_000;
/** Open-Meteo answers at most this far ahead; beyond it, §7.2 wants climate normals. */
export const FORECAST_HORIZON_DAYS = 16;

export interface Forecast {
  /** The rounded coordinate the answer is for. */
  lat: number;
  lon: number;
  hours: ForecastHour[];
}

export interface WeatherClient {
  /** Hourly weather for the days `from` … `to` inclusive, both `YYYY-MM-DD`. */
  forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast>;
}

/**
 * Snap to the grid, and never send more precision than that.
 *
 * Rounded to three decimals afterwards because the multiplication
 * leaves floating-point dust — 48.150000000000006 — and that dust is
 * the cache key: two callers at the same place would otherwise ask two
 * different questions and store two identical answers.
 */
export function roundToGrid(value: number): number {
  return Math.round(Math.round(value / GRID_DEGREES) * GRID_DEGREES * 1000) / 1000;
}

export class OpenMeteoClient implements WeatherClient {
  async forecast(lat: number, lon: number, from: string, to: string): Promise<Forecast> {
    const roundedLat = roundToGrid(lat);
    const roundedLon = roundToGrid(lon);

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", roundedLat.toFixed(2));
    url.searchParams.set("longitude", roundedLon.toFixed(2));
    url.searchParams.set(
      "hourly",
      "precipitation,cloud_cover,temperature_2m,relative_humidity_2m",
    );
    url.searchParams.set("start_date", from);
    url.searchParams.set("end_date", to);
    // Everything is kept in UTC and converted where the local clock is
    // known (§7.3): a coordinate does not carry its time zone, and
    // letting the API guess one would put a second opinion about it in
    // the system.
    url.searchParams.set("timezone", "UTC");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS);
    let body: unknown;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new WeatherUnavailableError(`open-meteo answered ${response.status}`);
      }
      body = await response.json();
    } catch (err) {
      if (err instanceof WeatherUnavailableError) throw err;
      throw new WeatherUnavailableError(
        err instanceof Error ? err.message : "the forecast could not be fetched",
      );
    } finally {
      clearTimeout(timer);
    }

    return { lat: roundedLat, lon: roundedLon, hours: parseHours(body) };
  }
}

/**
 * The forecast is not available.
 *
 * Its own type because the callers all do the same thing with it —
 * carry on without weather. A plan is still a plan in the rain; a plan
 * that refuses to open because a third party is down is not.
 */
export class WeatherUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherUnavailableError";
  }
}

/**
 * Read the arrays Open-Meteo answers with.
 *
 * The response is column-oriented — one array per variable, aligned by
 * index with `time` — so an hour is only usable when every column has
 * a number at that index. A hole in one of them is skipped rather than
 * filled with a zero, which would read as "no rain" (§15.3).
 */
export function parseHours(body: unknown): ForecastHour[] {
  const hourly = (body as { hourly?: Record<string, unknown> } | null)?.hourly;
  if (!hourly) throw new WeatherUnavailableError("open-meteo answered without an hourly block");

  const times = hourly.time;
  if (!Array.isArray(times)) {
    throw new WeatherUnavailableError("open-meteo answered without hourly times");
  }
  const precipitation = numbers(hourly.precipitation);
  const cloud = numbers(hourly.cloud_cover);
  const temperature = numbers(hourly.temperature_2m);
  const humidity = numbers(hourly.relative_humidity_2m);

  const hours: ForecastHour[] = [];
  let skipped = 0;
  for (const [index, time] of times.entries()) {
    if (typeof time !== "string") { skipped++; continue; }
    const values = [precipitation[index], cloud[index], temperature[index], humidity[index]];
    if (values.some((value) => value === null)) { skipped++; continue; }

    hours.push({
      // Open-Meteo stamps UTC hours without a zone marker; saying so
      // explicitly keeps Date.parse from reading them as local.
      time: time.endsWith("Z") ? time : `${time}Z`,
      precipitationMm: values[0]!,
      cloudCover: values[1]!,
      temperatureC: values[2]!,
      relativeHumidity: values[3]!,
    });
  }
  if (skipped > 0) {
    log.info("weather: skipped hours with missing values", { skipped, kept: hours.length });
  }
  return hours;
}

function numbers(column: unknown): (number | null)[] {
  if (!Array.isArray(column)) return [];
  return column.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
}

let active: WeatherClient = new OpenMeteoClient();

export function getWeatherClient(): WeatherClient {
  return active;
}

/** Replace the active client. Used by tests, which never leave the house. */
export function setWeatherClient(client: WeatherClient): void {
  active = client;
}

export function resetWeatherClient(): void {
  active = new OpenMeteoClient();
}
