import type { Coordinate, TransportMode } from "./travel";
import { haversineMeters } from "./travel";
import { costingFor, type RouterCell, type RouterClient, type RouterRoute, type RouterStatus } from "./router-client";

/**
 * A router for tests: answers from a speed per mode, or refuses, or is
 * away. What it was asked is kept, so a test can say "the planner asked
 * for one matrix, not one route per pair".
 */
export class InMemoryRouterClient implements RouterClient {
  reachable = true;
  hasTiles = true;
  tilesBuiltAt: string | null = "2026-09-01T00:00:00.000Z";
  /** Metres per minute per mode; a mode missing here is "no way". */
  speeds: Partial<Record<TransportMode, number>> = { car: 800, bike: 250, foot: 80 };
  readonly matrixCalls: Array<{ sources: number; targets: number; mode: TransportMode }> = [];
  readonly routeCalls: TransportMode[] = [];
  /**
   * The roads, for `routes`: encoded shapes a test lays down so the
   * corridor can follow a road that bends away from the straight line.
   * Empty means the straight line between the two ends, as one route.
   */
  shapes: string[] = [];

  async status(): Promise<RouterStatus> {
    return {
      reachable: this.reachable,
      reason: this.reachable ? null : "ECONNREFUSED",
      version: this.reachable ? "test" : null,
      hasTiles: this.reachable && this.hasTiles,
      tilesBuiltAt: this.reachable && this.hasTiles ? this.tilesBuiltAt : null,
    };
  }

  async matrix(
    sources: readonly Coordinate[],
    targets: readonly Coordinate[],
    mode: TransportMode,
  ): Promise<(RouterCell | null)[][] | null> {
    this.matrixCalls.push({ sources: sources.length, targets: targets.length, mode });
    if (!this.reachable || !costingFor(mode)) return null;
    return sources.map((s) => targets.map((t) => this.cell(s, t, mode)));
  }

  async route(from: Coordinate, to: Coordinate, mode: TransportMode): Promise<RouterRoute | null> {
    const routes = await this.routes(from, to, mode, 0);
    return routes?.[0] ?? null;
  }

  async routes(from: Coordinate, to: Coordinate, mode: TransportMode, alternates: number): Promise<RouterRoute[] | null> {
    this.routeCalls.push(mode);
    if (!this.reachable || !costingFor(mode)) return null;
    const cell = this.cell(from, to, mode);
    if (!cell) return null;
    const shapes = this.shapes.length > 0 ? this.shapes.slice(0, 1 + alternates) : [encodeLine([from, to])];
    return shapes.map((shape) => ({ ...cell, shape }));
  }

  private cell(from: Coordinate, to: Coordinate, mode: TransportMode): RouterCell | null {
    const speed = this.speeds[mode];
    if (!speed) return null;
    const distanceM = Math.round(haversineMeters(from, to) * 1.2);
    return { minutes: Math.round(distanceM / speed), distanceM };
  }
}

/** Encode a line the way Valhalla does (polyline, six places). */
export function encodeLine(points: readonly Coordinate[], precision = 6): string {
  const factor = 10 ** precision;
  let out = "";
  let lastLat = 0;
  let lastLon = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lon = Math.round(p.lon * factor);
    out += encodeValue(lat - lastLat) + encodeValue(lon - lastLon);
    lastLat = lat;
    lastLon = lon;
  }
  return out;

  function encodeValue(value: number): string {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  }
}
