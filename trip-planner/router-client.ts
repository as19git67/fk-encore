/**
 * The router (Valhalla) as the planner sees it (§12, §24).
 *
 * Three questions, nothing else: is it there and how fresh are its
 * tiles; how long from each of these points to each of those; how long
 * and which way from here to there. Everything is optional — a
 * planner without a router estimates as it always has (`travel.ts`),
 * and every caller must be written so that `null` from here means
 * "estimate", never "fail" (§15.3: say what you do not know, do not
 * refuse over it).
 *
 * Transit is not asked: without a GTFS feed Valhalla knows no
 * timetable, and a pedestrian answer for a tram hop would be worse
 * than the estimate. That comes with the feeds (§24, stage 3).
 */

import log from "encore.dev/log";
import type { Coordinate, TransportMode } from "./travel";

const DEFAULT_BASE_URL = process.env.ROUTING_SERVICE_URL ?? "http://routing:8002";
const TIMEOUT_MS = parseInt(process.env.ROUTING_TIMEOUT_MS ?? "8000", 10);

export interface RouterStatus {
  reachable: boolean;
  /**
   * Why not, when not: the error as the app saw it. "ENOTFOUND routing"
   * is a container that was never started, "ECONNREFUSED" one that is
   * up but not serving yet (building tiles) — the admin can tell the
   * two apart only if we say which (§15.3).
   */
  reason: string | null;
  /** Valhalla's version, when it answered. */
  version: string | null;
  /** Whether a tile set is loaded at all. */
  hasTiles: boolean;
  /** When the tiles were built, when Valhalla says (ISO). */
  tilesBuiltAt: string | null;
}

/** One cell of a travel matrix. Null where the router found no way. */
export interface RouterCell {
  minutes: number;
  distanceM: number;
}

export interface RouterRoute {
  minutes: number;
  distanceM: number;
  /** Encoded polyline (precision 6), for a map. */
  shape: string | null;
}

export interface RouterClient {
  status(): Promise<RouterStatus>;
  /**
   * Travel from every source to every target, `[source][target]`.
   * Null for the whole call when the router cannot answer this mode
   * (transit) or is not there; null per cell where no way exists.
   */
  matrix(
    sources: readonly Coordinate[],
    targets: readonly Coordinate[],
    mode: TransportMode,
  ): Promise<(RouterCell | null)[][] | null>;
  route(from: Coordinate, to: Coordinate, mode: TransportMode): Promise<RouterRoute | null>;
}

/** Valhalla's word for each of ours; transit has none yet. */
export function costingFor(mode: TransportMode): "auto" | "bicycle" | "pedestrian" | null {
  switch (mode) {
    case "car": return "auto";
    case "bike": return "bicycle";
    case "foot": return "pedestrian";
    case "transit": return null;
  }
}

type Fetcher = typeof fetch;

export class HttpRouterClient implements RouterClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(opts: { baseUrl?: string; fetcher?: Fetcher } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetcher = opts.fetcher ?? fetch;
  }

  async status(): Promise<RouterStatus> {
    try {
      // Plain status: `?verbose=true` is not how Valhalla reads options
      // on a GET (it wants `?json={...}`), so `has_tiles` never came and
      // a router with tiles read as one without. The verbose answer also
      // walks every tile for its bbox. The tile set's age is in the plain
      // answer, and Valhalla only has one when there are tiles.
      const res = await this.fetcher(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return unreachable(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        version?: string;
        has_tiles?: boolean;
        tileset_last_modified?: number;
      };
      const tilesBuiltAt = typeof body.tileset_last_modified === "number" && body.tileset_last_modified > 0
        ? new Date(body.tileset_last_modified * 1000).toISOString()
        : null;
      return {
        reachable: true,
        reason: null,
        version: body.version ?? null,
        hasTiles: body.has_tiles ?? tilesBuiltAt !== null,
        tilesBuiltAt,
      };
    } catch (err) {
      const reason = describe(err);
      log.warn("routing status unavailable", { reason });
      return unreachable(reason);
    }
  }

  async matrix(
    sources: readonly Coordinate[],
    targets: readonly Coordinate[],
    mode: TransportMode,
  ): Promise<(RouterCell | null)[][] | null> {
    const costing = costingFor(mode);
    if (!costing || sources.length === 0 || targets.length === 0) return null;
    const body = await this.post("/sources_to_targets", {
      sources: sources.map(point),
      targets: targets.map(point),
      costing,
      units: "kilometers",
    });
    if (!body) return null;
    const rows = (body as { sources_to_targets?: Array<Array<{ time: number | null; distance: number | null }>> })
      .sources_to_targets;
    if (!Array.isArray(rows) || rows.length !== sources.length) return null;
    return rows.map((row) => row.map((cell) =>
      typeof cell?.time === "number" && typeof cell.distance === "number"
        ? { minutes: Math.round(cell.time / 60), distanceM: Math.round(cell.distance * 1000) }
        : null));
  }

  async route(from: Coordinate, to: Coordinate, mode: TransportMode): Promise<RouterRoute | null> {
    const costing = costingFor(mode);
    if (!costing) return null;
    const body = await this.post("/route", { locations: [point(from), point(to)], costing, units: "kilometers" });
    if (!body) return null;
    const trip = (body as { trip?: { summary?: { time?: number; length?: number }; legs?: Array<{ shape?: string }> } }).trip;
    if (!trip?.summary || typeof trip.summary.time !== "number" || typeof trip.summary.length !== "number") return null;
    return {
      minutes: Math.round(trip.summary.time / 60),
      distanceM: Math.round(trip.summary.length * 1000),
      shape: trip.legs?.[0]?.shape ?? null,
    };
  }

  /**
   * One POST, one answer, or null: the router being down or refusing
   * is logged and becomes an estimate upstream, never an error the
   * traveller sees.
   */
  private async post(path: string, body: unknown): Promise<unknown> {
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn("routing request refused", { path, status: res.status });
        return null;
      }
      return await res.json();
    } catch (err) {
      log.warn("routing request failed", { path, reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

function point(c: Coordinate): { lat: number; lon: number } {
  return { lat: c.lat, lon: c.lon };
}

function unreachable(reason: string): RouterStatus {
  return { reachable: false, reason, version: null, hasTiles: false, tilesBuiltAt: null };
}

/** The error with its cause, which is where fetch keeps the useful part. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const inner = cause instanceof Error ? cause.message : cause ? String(cause) : null;
  return inner && inner !== err.message ? `${err.message}: ${inner}` : err.message;
}

let client: RouterClient | null = null;

export function getRouterClient(): RouterClient {
  if (!client) client = new HttpRouterClient();
  return client;
}

/** Test seam. */
export function setRouterClient(next: RouterClient | null): void {
  client = next;
}
