/**
 * HTTP client for the geo service.
 *
 * The geo container (see /geo) owns one PostGIS database per imported
 * Geofabrik region and exposes a small JSON surface that osm-admin
 * uses to manage imports and serve reverse / POI lookups.
 *
 *   POST   /import                — kick off a background osm2pgsql import
 *   GET    /imports/:postgresDb   — current status of an import
 *   GET    /replication/status/:postgresDb — replication initialization state
 *   POST   /reverse               — Nominatim-shaped reverse geocoding
 *   POST   /pois                  — radius-based POI candidate lookup
 *   POST   /pois/search           — area search for trip planning
 *   GET    /storage/:postgresDb   — per-table size breakdown for one region
 *   DELETE /regions/:postgresDb   — drop a region database
 *   GET    /health                — liveness
 *
 * The client is a thin typed wrapper around `fetch`; injectable via
 * `setGeoClient` for tests (mirrors how the old docker driver was
 * injected). The default base URL points at the in-cluster service name
 * `geo:8080`; override via `GEO_SERVICE_URL` for local dev.
 */

const DEFAULT_BASE_URL = process.env.GEO_SERVICE_URL ?? "http://geo:8080";
const SHARED_SECRET = process.env.GEO_SHARED_SECRET ?? "";
const STATUS_TIMEOUT_MS = parseInt(process.env.GEO_STATUS_TIMEOUT_MS ?? "10000", 10);
const REFRESH_TIMEOUT_MS = parseInt(process.env.GEO_REFRESH_TIMEOUT_MS ?? String(30 * 60_000), 10);

export interface GeoImportRequest {
  slug: string;
  postgresDb: string;
  pbfUrl: string;
}

export type GeoImportState = "running" | "ready" | "failed";

export interface GeoImportStatus {
  slug: string;
  postgresDb: string;
  state: GeoImportState;
  startedAt: string;
  finishedAt?: string;
  pbfSizeMb?: number;
  importedAt?: string;
  durationSeconds?: number;
  error?: string;
}

export interface GeoReverseResult {
  database: string;
  result: {
    display_name: string;
    address: Record<string, string>;
  };
}

export interface GeoTableStorage {
  table: string;
  /** Heap, indexes and TOAST — what the volume feels. */
  totalMb: number;
  /** Heap alone. */
  tableMb: number;
  rows: number;
}

export interface GeoRegionStorage {
  database: string;
  sizeMb: number;
  tables: GeoTableStorage[];
  poisByKind: { kind: string; count: number }[];
  poiTotal: number;
  poisWithShape: number;
  poisWithFacadeAzimuth: number;
}

export interface GeoPoiSearchQuery {
  /** Search a rectangle. */
  bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Search a disc. */
  center?: { lat: number; lon: number; radiusM: number };
  /**
   * Search what lies along a journey (§4.2): the spots that lengthen it
   * by at most `detourBudgetM`, counting the way back. Exactly one of
   * bbox, center and corridor may be given.
   */
  corridor?: {
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    detourBudgetM: number;
  };
  /** Category ids from GET /pois/categories. Omitted = all of them. */
  categories?: string[];
  limit?: number;
  offset?: number;
}

export interface GeoPoiSearchSpot {
  osmRef: string;
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  /** Only set when the query carried a centre. */
  distanceM: number | null;
  /** Extra metres the journey costs if visited. Corridor searches only. */
  detourM: number | null;
  name: string | null;
  nameDe: string | null;
  nameEn: string | null;
  kind: string | null;
  categories: string[];
  wikidataQid: string | null;
  wikipedia: string | null;
  /** Straight from OSM and unverified — absent means unknown, not "no". */
  openingHours: string | null;
  cuisine: string | null;
  wheelchair: string | null;
  outdoorSeating: string | null;
  /** Degrees clockwise from north, in [0, 180); null for node POIs. */
  facadeAzimuth: number | null;
}

export interface GeoPoiSearchPage {
  database: string;
  spots: GeoPoiSearchSpot[];
  hasMore: boolean;
}

/** One entry of the search's category vocabulary. */
export interface GeoPoiCategory {
  id: string;
  description: string;
}

export interface GeoPoiCandidate {
  osmRef: string;
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  distanceM: number;
  name: string | null;
  nameDe: string | null;
  primaryTag: string | null;
  wikidataQid: string | null;
  wikipedia: string | null;
}

export interface GeoPoiQueryOptions {
  radiusM?: number;
  maxCandidates?: number;
}

export interface GeoRefreshResult {
  postgresDb: string;
  /** Number of diffs applied this run; 0 when already up to date. */
  appliedDiffs: number;
  /** Sequence number reported by osm2pgsql-replication after the run. */
  sequence: number | null;
  /** ISO timestamp of the most recently applied diff. */
  timestamp: string | null;
}

export interface GeoReplicationStatus {
  postgresDb: string;
  initialized: boolean;
  sequence: number | null;
  timestamp: string | null;
}

export interface GeoClient {
  health(): Promise<boolean>;
  startImport(req: GeoImportRequest): Promise<GeoImportStatus>;
  getImportStatus(postgresDb: string): Promise<GeoImportStatus | null>;
  getReplicationStatus(postgresDb: string): Promise<GeoReplicationStatus>;
  reverse(postgresDb: string, lat: number, lon: number): Promise<GeoReverseResult["result"]>;
  findPois(
    postgresDb: string,
    lat: number,
    lon: number,
    opts?: GeoPoiQueryOptions,
  ): Promise<GeoPoiCandidate[]>;
  /** Area search for trip planning — see the method on HttpGeoClient. */
  searchPois(postgresDb: string, query: GeoPoiSearchQuery): Promise<GeoPoiSearchPage>;
  /** The category vocabulary `searchPois` accepts. Region-independent. */
  poiCategories(): Promise<GeoPoiCategory[]>;
  /** Per-table size breakdown, for before/after import measurements. */
  regionStorage(postgresDb: string): Promise<GeoRegionStorage>;
  /**
   * Apply replication diffs. `pbfUrl` is optional but lets the geo
   * service auto-initialise replication for a region whose status table
   * is missing (imported but never `init`-ed).
   */
  refresh(postgresDb: string, pbfUrl?: string): Promise<GeoRefreshResult>;
  dropRegion(postgresDb: string): Promise<boolean>;
}

export interface HttpGeoClientOptions {
  baseUrl?: string;
  sharedSecret?: string;
  fetcher?: typeof fetch;
}

export class HttpGeoClient implements GeoClient {
  private readonly baseUrl: string;
  private readonly sharedSecret: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: HttpGeoClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.sharedSecret = opts.sharedSecret ?? SHARED_SECRET;
    this.fetcher = opts.fetcher ?? fetch;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/health`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async startImport(req: GeoImportRequest): Promise<GeoImportStatus> {
    return await this.postJson<GeoImportStatus>("/import", req);
  }

  async getImportStatus(postgresDb: string): Promise<GeoImportStatus | null> {
    const res = await this.fetcher(
      `${this.baseUrl}/imports/${encodeURIComponent(postgresDb)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`geo: GET /imports/${postgresDb} → HTTP ${res.status}`);
    }
    return (await res.json()) as GeoImportStatus;
  }

  async getReplicationStatus(postgresDb: string): Promise<GeoReplicationStatus> {
    const path = `/replication/status/${encodeURIComponent(postgresDb)}`;
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`geo: GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as GeoReplicationStatus;
  }

  async reverse(
    postgresDb: string,
    lat: number,
    lon: number,
  ): Promise<GeoReverseResult["result"]> {
    const body = await this.postJson<GeoReverseResult>("/reverse", {
      database: postgresDb,
      lat,
      lon,
    });
    return body.result;
  }

  async findPois(
    postgresDb: string,
    lat: number,
    lon: number,
    opts: GeoPoiQueryOptions = {},
  ): Promise<GeoPoiCandidate[]> {
    const body = await this.postJson<{ candidates: GeoPoiCandidate[] }>("/pois", {
      database: postgresDb,
      lat,
      lon,
      radiusM: opts.radiusM,
      maxCandidates: opts.maxCandidates,
    });
    return body.candidates;
  }

  /**
   * Area search for trip planning. Unlike `findPois`, which answers
   * "what could this photo show?" for one point, this walks a bounding
   * box or a generous radius and returns candidates by category, in
   * pages. Ranking them is the planner's job, not geo's.
   */
  async searchPois(postgresDb: string, query: GeoPoiSearchQuery): Promise<GeoPoiSearchPage> {
    return await this.postJson<GeoPoiSearchPage>("/pois/search", {
      database: postgresDb,
      bbox: query.bbox,
      center: query.center,
      categories: query.categories,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /**
   * The category vocabulary the area search accepts. Lives in geo
   * (`poi-categories.ts`) and is fetched rather than duplicated here, so
   * a category added there needs no second edit to become usable.
   */
  async poiCategories(): Promise<GeoPoiCategory[]> {
    const res = await this.fetcher(`${this.baseUrl}/pois/categories`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`geo: GET /pois/categories → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { categories?: GeoPoiCategory[] };
    return body.categories ?? [];
  }

  /**
   * Size breakdown for one region. Read-only and cheap — the numbers
   * come from the catalog and the statistics collector, not from
   * scanning the tables.
   */
  async regionStorage(postgresDb: string): Promise<GeoRegionStorage> {
    const res = await this.fetcher(
      `${this.baseUrl}/storage/${encodeURIComponent(postgresDb)}`,
      { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
    );
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: string };
        detail = j.error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(
        `geo: GET /storage/${postgresDb} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await res.json()) as GeoRegionStorage;
  }

  async refresh(postgresDb: string, pbfUrl?: string): Promise<GeoRefreshResult> {
    return await this.postJson<GeoRefreshResult>("/refresh", { postgresDb, pbfUrl }, REFRESH_TIMEOUT_MS);
  }

  async dropRegion(postgresDb: string): Promise<boolean> {
    const res = await this.fetcher(
      `${this.baseUrl}/regions/${encodeURIComponent(postgresDb)}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`geo: DELETE /regions/${postgresDb} → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { deleted: boolean };
    return body.deleted;
  }

  private async postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: string };
        detail = j.error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(`geo: POST ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    return this.sharedSecret ? { authorization: `Bearer ${this.sharedSecret}` } : {};
  }
}

let active: GeoClient = new HttpGeoClient();

export function getGeoClient(): GeoClient {
  return active;
}

/** Replace the active geo client. Used by tests. */
export function setGeoClient(client: GeoClient): void {
  active = client;
}

/** Restore the default HTTP-backed client. */
export function resetGeoClient(): void {
  active = new HttpGeoClient();
}
