/**
 * Asking a height model how high the ground is (§7.3).
 *
 * [Open-Meteo's elevation API](https://open-meteo.com/en/docs/elevation-api)
 * serves the Copernicus DEM GLO-90 — ninety metres per pixel, worldwide,
 * no key, and the same host `api.open-meteo.com` the forecast already
 * uses, so the network policy needs nothing new.
 *
 * Ninety metres is coarse for a wall and right for a horizon: what cuts
 * the evening at a viewpoint is a ridge a few kilometres out, and a
 * ridge is many pixels wide. It will not know about the building
 * opposite, and §7.3's window is a hint rather than a promise partly
 * for that reason.
 *
 * **What leaves the house is a fan of coordinates around a public
 * place** — a viewpoint, a church, a square somebody put on a list. Not
 * where anybody is, and not when. The result is stored per place and
 * shared by everyone who plans there.
 */

import type { Coordinate } from "./horizon";

const ELEVATION_TIMEOUT_MS = 8_000;
/** Open-Meteo takes at most a hundred coordinates per request. */
export const ELEVATION_BATCH = 100;

export interface ElevationClient {
  /** Ground height in metres per point, null where the model has none. */
  elevations(points: readonly Coordinate[]): Promise<(number | null)[]>;
}

/** The height model is not available. Same shape as the weather's. */
export class ElevationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevationUnavailableError";
  }
}

export class OpenMeteoElevationClient implements ElevationClient {
  async elevations(points: readonly Coordinate[]): Promise<(number | null)[]> {
    const answers: (number | null)[] = [];
    for (let start = 0; start < points.length; start += ELEVATION_BATCH) {
      const batch = points.slice(start, start + ELEVATION_BATCH);
      answers.push(...(await this.batch(batch)));
    }
    return answers;
  }

  private async batch(points: readonly Coordinate[]): Promise<(number | null)[]> {
    const url = new URL("https://api.open-meteo.com/v1/elevation");
    // Five decimals is about a metre — far below the model's ninety and
    // enough that two samples never collapse onto one point.
    url.searchParams.set("latitude", points.map((p) => p.lat.toFixed(5)).join(","));
    url.searchParams.set("longitude", points.map((p) => p.lon.toFixed(5)).join(","));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ELEVATION_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new ElevationUnavailableError(`open-meteo elevation answered ${response.status}`);
      }
      return parseElevations(await response.json(), points.length);
    } catch (err) {
      if (err instanceof ElevationUnavailableError) throw err;
      throw new ElevationUnavailableError(
        err instanceof Error ? err.message : "elevation unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read the `elevation` array back.
 *
 * Padded to the number of points asked for, because the answer is
 * positional: a short array with no explanation would otherwise shift
 * every height onto the wrong bearing, which is worse than a gap.
 */
export function parseElevations(body: unknown, expected: number): (number | null)[] {
  const raw = (body as { elevation?: unknown } | null)?.elevation;
  if (!Array.isArray(raw)) {
    throw new ElevationUnavailableError("elevation response has no elevation array");
  }
  const values = raw.map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null,
  );
  while (values.length < expected) values.push(null);
  return values.slice(0, expected);
}

let active: ElevationClient = new OpenMeteoElevationClient();

export function getElevationClient(): ElevationClient {
  return active;
}

/** Replace the active client. Used by tests, which never leave the house. */
export function setElevationClient(client: ElevationClient): void {
  active = client;
}

export function resetElevationClient(): void {
  active = new OpenMeteoElevationClient();
}
