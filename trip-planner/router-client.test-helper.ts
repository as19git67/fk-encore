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
    this.routeCalls.push(mode);
    if (!this.reachable || !costingFor(mode)) return null;
    const cell = this.cell(from, to, mode);
    return cell ? { ...cell, shape: null } : null;
  }

  private cell(from: Coordinate, to: Coordinate, mode: TransportMode): RouterCell | null {
    const speed = this.speeds[mode];
    if (!speed) return null;
    const distanceM = Math.round(haversineMeters(from, to) * 1.2);
    return { minutes: Math.round(distanceM / speed), distanceM };
  }
}
