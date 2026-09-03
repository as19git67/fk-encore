/**
 * In-memory test double for the geo HTTP client.
 *
 * Used by every osm-admin unit test that previously injected an
 * InMemoryDockerDriver. The double keeps a small slice of state per
 * `postgresDb`: known imports (with their lifecycle state) and the
 * canned responses for reverse/findPois that the caller queues with
 * `setReverseResult` / `setPoiCandidates`.
 *
 * Default behaviour:
 *   - `startImport` flips the database's state to "running" and
 *     auto-transitions to "ready" on the next `getImportStatus` call
 *     unless `setImportState` overrode it explicitly.
 *   - `reverse` returns the canned result for the given postgresDb, or
 *     a generic stub when none is set.
 *   - `findPois` returns the canned candidates list, or an empty array.
 */

import type {
  GeoClient,
  GeoImportRequest,
  GeoImportStatus,
  GeoPoiCandidate,
  GeoPoiQueryOptions,
  GeoPoiSearchPage,
  GeoRegionStorage,
  GeoPoiSearchQuery,
  GeoPoiSearchSpot,
  GeoRefreshResult,
  GeoReplicationStatus,
  GeoReverseResult,
} from "./geo-client";

interface ImportEntry {
  state: GeoImportStatus["state"];
  status: GeoImportStatus;
}

export class InMemoryGeoClient implements GeoClient {
  private healthy = true;
  private imports = new Map<string, ImportEntry>();
  private reverseResults = new Map<string, GeoReverseResult["result"]>();
  private poiCandidates = new Map<string, GeoPoiCandidate[]>();
  private searchSpots = new Map<string, GeoPoiSearchSpot[]>();
  private storage = new Map<string, GeoRegionStorage>();
  private searchCalls: Array<{ postgresDb: string; query: GeoPoiSearchQuery }> = [];
  private refreshResults = new Map<string, GeoRefreshResult>();
  private replicationStatuses = new Map<string, GeoReplicationStatus>();
  private droppedRegions: string[] = [];
  private startImportCalls: GeoImportRequest[] = [];
  private refreshCalls: string[] = [];
  private refreshPbfUrls: Array<string | undefined> = [];

  setHealthy(v: boolean): void { this.healthy = v; }

  setImportState(postgresDb: string, state: GeoImportStatus["state"], extras: Partial<GeoImportStatus> = {}): void {
    const base: GeoImportStatus = {
      slug: postgresDb,
      postgresDb,
      state,
      startedAt: new Date(0).toISOString(),
      ...extras,
    };
    this.imports.set(postgresDb, { state, status: base });
  }

  setReverseResult(postgresDb: string, result: GeoReverseResult["result"]): void {
    this.reverseResults.set(postgresDb, result);
  }

  setPoiCandidates(postgresDb: string, candidates: GeoPoiCandidate[]): void {
    this.poiCandidates.set(postgresDb, candidates);
  }

  setRefreshResult(postgresDb: string, result: GeoRefreshResult): void {
    this.refreshResults.set(postgresDb, result);
  }

  setReplicationStatus(postgresDb: string, initialized: boolean, extras: Partial<GeoReplicationStatus> = {}): void {
    this.replicationStatuses.set(postgresDb, {
      postgresDb,
      initialized,
      sequence: null,
      timestamp: null,
      ...extras,
    });
  }

  /** Test inspection helpers. */
  getStartImportCalls(): GeoImportRequest[] { return [...this.startImportCalls]; }
  getDroppedRegions(): string[] { return [...this.droppedRegions]; }
  getRefreshCalls(): string[] { return [...this.refreshCalls]; }
  /** PBF URLs forwarded with each refresh call, positionally aligned. */
  getRefreshPbfUrls(): Array<string | undefined> { return [...this.refreshPbfUrls]; }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async startImport(req: GeoImportRequest): Promise<GeoImportStatus> {
    this.startImportCalls.push({ ...req });
    const existing = this.imports.get(req.postgresDb);
    if (existing && existing.state === "running") return existing.status;
    const status: GeoImportStatus = {
      slug: req.slug,
      postgresDb: req.postgresDb,
      state: "running",
      startedAt: new Date(0).toISOString(),
    };
    this.imports.set(req.postgresDb, { state: "running", status });
    return status;
  }

  async getImportStatus(postgresDb: string): Promise<GeoImportStatus | null> {
    const entry = this.imports.get(postgresDb);
    return entry?.status ?? null;
  }

  async getReplicationStatus(postgresDb: string): Promise<GeoReplicationStatus> {
    return this.replicationStatuses.get(postgresDb) ?? {
      postgresDb,
      initialized: true,
      sequence: null,
      timestamp: null,
    };
  }

  async reverse(
    postgresDb: string,
    lat: number,
    lon: number,
  ): Promise<GeoReverseResult["result"]> {
    const result = this.reverseResults.get(postgresDb);
    if (result) return result;
    return {
      display_name: `stub for ${postgresDb} @ (${lat},${lon})`,
      address: { country: "Stubland" },
    };
  }

  setRegionStorage(postgresDb: string, storage: GeoRegionStorage): void {
    this.storage.set(postgresDb, storage);
  }

  async regionStorage(postgresDb: string): Promise<GeoRegionStorage> {
    const known = this.storage.get(postgresDb);
    if (!known) throw new Error(`geo: GET /storage/${postgresDb} → HTTP 404`);
    return known;
  }

  setSearchSpots(postgresDb: string, spots: GeoPoiSearchSpot[]): void {
    this.searchSpots.set(postgresDb, spots);
  }

  /** What the planner asked for, so a test can assert on the query. */
  getSearchCalls(): ReadonlyArray<{ postgresDb: string; query: GeoPoiSearchQuery }> {
    return this.searchCalls;
  }

  async searchPois(postgresDb: string, query: GeoPoiSearchQuery): Promise<GeoPoiSearchPage> {
    this.searchCalls.push({ postgresDb, query });
    const spots = this.searchSpots.get(postgresDb) ?? [];
    const offset = query.offset ?? 0;
    const limit = query.limit ?? spots.length;
    const page = spots.slice(offset, offset + limit);
    return { database: postgresDb, spots: page, hasMore: offset + limit < spots.length };
  }

  async findPois(
    postgresDb: string,
    _lat: number,
    _lon: number,
    _opts?: GeoPoiQueryOptions,
  ): Promise<GeoPoiCandidate[]> {
    return this.poiCandidates.get(postgresDb) ?? [];
  }

  async refresh(postgresDb: string, pbfUrl?: string): Promise<GeoRefreshResult> {
    this.refreshCalls.push(postgresDb);
    this.refreshPbfUrls.push(pbfUrl);
    const cached = this.refreshResults.get(postgresDb);
    if (cached) {
      this.setReplicationStatus(postgresDb, true, {
        sequence: cached.sequence,
        timestamp: cached.timestamp,
      });
      return cached;
    }
    this.setReplicationStatus(postgresDb, true);
    return {
      postgresDb,
      appliedDiffs: 0,
      sequence: null,
      timestamp: null,
    };
  }

  async dropRegion(postgresDb: string): Promise<boolean> {
    this.droppedRegions.push(postgresDb);
    const had = this.imports.delete(postgresDb);
    this.reverseResults.delete(postgresDb);
    this.poiCandidates.delete(postgresDb);
    return had;
  }
}
