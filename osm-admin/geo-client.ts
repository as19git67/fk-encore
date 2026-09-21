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
  /**
   * Keep only spots whose name contains this, case and diacritics
   * folded away. A substring, not an identity — which of the matches is
   * the place meant is decided by the caller (see
   * `trip-planner/resolve-place.ts`).
   */
  name?: string;
  /**
   * What the page holds when more matches exist than fit in it:
   * `"distance"` (the default with a centre) the nearest, or
   * `"prominence"` the ones the place is known for. See
   * `geo/src/poi-search.ts` — a page cut by distance and then filtered
   * by prominence keeps neither.
   */
  rank?: "distance" | "prominence";
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
  /** The `wikipedia` tag: the article in the **local** language. */
  wikipedia: string | null;
  /**
   * The `wikipedia:de` tag — the German article for the same place,
   * where a mapper has linked one (§10.4). Optional because a geo
   * container from before this field simply does not send it, and a
   * missing German article is exactly what `undefined` should mean
   * here.
   */
  wikipediaDe?: string | null;
  /** Straight from OSM and unverified — absent means unknown, not "no". */
  openingHours: string | null;
  cuisine: string | null;
  wheelchair: string | null;
  outdoorSeating: string | null;
  /** "yes" | "only" | "no" | "limited" as OSM has it, never a boolean. */
  dietVegetarian: string | null;
  dietVegan: string | null;
  /** For reserving a table or asking whether they are really open. */
  phone: string | null;
  website: string | null;
  /** Degrees clockwise from north, in [0, 180); null for node POIs. */
  facadeAzimuth: number | null;
}

/**
 * How much water lies on the straight line between two points (§4.5).
 *
 * The planner has no router: it estimates a journey as the straight
 * line times a per-mode factor, which is a fair average over a road
 * network and nonsense across a lake. This is what geo can answer
 * cheaply from data it already holds — the named water bodies are
 * imported with their geometry — and it is *not* a route: it says what
 * is in the way and how big that thing is, and leaves the cost of
 * going around it to the caller.
 */
export interface GeoWaterCrossing {
  /** Metres of the line that lie on water. Zero when nothing is in the way. */
  crossedM: number;
  /** The longest single crossing, when several bodies are in the way. */
  widestM: number;
  /** The biggest body's extent, corner to corner of its bounding box. */
  extentM: number;
  /** What that body is called. */
  name: string | null;
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

/** A signposted walking or cycling route (§4.7). */
export interface GeoRouteSearchQuery {
  center: { lat: number; lon: number };
  radiusM: number;
  /** hiking | foot | bicycle | mtb. Omitted = all four. */
  kinds?: string[];
  limit?: number;
}

export interface GeoRoutePoint {
  lat: number;
  lon: number;
}

export interface GeoRoute {
  osmRef: string;
  id: number;
  name: string;
  route: string;
  network: string | null;
  ref: string | null;
  /** The real length of the way, in metres. */
  lengthM: number;
  /** Metres of climb where the relation says so — never guessed. */
  ascentM: number | null;
  /** How close the way passes to the centre of the search. */
  distanceM: number;
  start: GeoRoutePoint;
  /** Null for a loop and for a relation whose members do not join up. */
  end: GeoRoutePoint | null;
  /** A simplified shape; empty where the members do not join up. */
  via: GeoRoutePoint[];
  joined: boolean;
  roundtrip: boolean;
  website: string | null;
  wikipedia: string | null;
  difficulty: string | null;
}

/**
 * One route's course in full, for export (§4.7).
 *
 * A different answer from the `via` on `GeoRoute`, and deliberately so:
 * that one is simplified to fifty metres and thinned to sixty-four
 * points, which is right for a map and wrong for a file somebody walks
 * by. This is the geometry as imported.
 */
export interface GeoRouteGeometry {
  osmRef: string;
  id: number;
  name: string;
  route: string;
  lengthM: number;
  ascentM: number | null;
  network: string | null;
  ref: string | null;
  website: string | null;
  /**
   * The course, one array per connected part. Several parts mean the
   * relation has gaps — they are pieces of one route in order along
   * it, not alternatives.
   */
  parts: GeoRoutePoint[][];
  joined: boolean;
}

export interface GeoRouteSearchPage {
  database: string;
  routes: GeoRoute[];
  hasMore: boolean;
  /**
   * False when the region was imported before routes were part of the
   * style — an older import, not an empty landscape.
   */
  imported: boolean;
}

export interface GeoDayTargetQuery {
  center: { lat: number; lon: number };
  /** Nothing nearer than this: below it lies the leg's own pool. */
  minRadiusM: number;
  maxRadiusM: number;
  limit?: number;
}

export interface GeoDayTarget {
  name: string;
  /** "admin" when a named area holds it, "cluster" when the grid found it. */
  source: string;
  osmRef: string | null;
  adminLevel: number | null;
  /** Where the spots stand, not where the boundary's middle is. */
  at: { lat: number; lon: number };
  distanceM: number;
  /** How many spots worth a block are there. */
  spotCount: number;
  /** How many of those carry a Wikidata or Wikipedia link. */
  linkedCount: number;
  examples: string[];
}

export interface GeoDayTargetPage {
  database: string;
  targets: GeoDayTarget[];
  hasMore: boolean;
}

export interface GeoRegionTables {
  database: string;
  /** Which of the current style's tables this region database has. */
  present: string[];
  /**
   * Which it lacks. Non-empty means the region was imported under an
   * older style — a re-import would give it more than it has.
   */
  missing: string[];
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
  /** Walking and cycling routes near a place (§4.7). */
  searchRoutes(postgresDb: string, query: GeoRouteSearchQuery): Promise<GeoRouteSearchPage>;
  /**
   * One route's full course, unsimplified — null when that region has
   * no such relation (§4.7).
   */
  routeGeometry(postgresDb: string, osmId: number): Promise<GeoRouteGeometry | null>;
  /** Places within reach that would carry a day of their own (§4.6). */
  searchDayTargets(postgresDb: string, query: GeoDayTargetQuery): Promise<GeoDayTargetPage>;
  /** Which of the current style's tables a region database has. */
  regionTables(postgresDb: string): Promise<GeoRegionTables>;
  /**
   * Is this corner of the world in that database at all (§4.3)?
   *
   * The region router picks by bounding box, and a bounding box says
   * "might contain", never "does": a Geofabrik extract is cut along
   * administrative borders and its rectangle overlaps its neighbours.
   * Italy's Nord-Ovest rectangle covers Pisa; its data stops at the
   * Tuscan border.
   */
  hasCoverage(postgresDb: string, lat: number, lon: number): Promise<boolean>;
  /**
   * Is there a lake between these two points, and how big is it?
   *
   * For the travel estimate, which without a router cannot see that the
   * road goes round (§4.5, §14).
   */
  waterCrossing(
    postgresDb: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<GeoWaterCrossing>;
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
      corridor: query.corridor,
      categories: query.categories,
      name: query.name,
      rank: query.rank,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /**
   * Walking and cycling routes near a place (§4.7).
   *
   * Its own call rather than a category of `searchPois`, because a
   * route is a way rather than a point: it answers with two ends, a
   * length and a shape, none of which a POI has.
   */
  async searchRoutes(
    postgresDb: string,
    query: GeoRouteSearchQuery,
  ): Promise<GeoRouteSearchPage> {
    return await this.postJson<GeoRouteSearchPage>("/routes/search", {
      database: postgresDb,
      center: query.center,
      radiusM: query.radiusM,
      kinds: query.kinds,
      limit: query.limit,
    });
  }

  /**
   * One route's full course, for export (§4.7).
   *
   * Not a mode of `searchRoutes`: that answers with a shape simplified
   * to fifty metres and thinned to sixty-four points, which is right
   * for a map and wrong for a track somebody follows. Null when the
   * region has no such relation any more — a saved link outliving a
   * re-import is ordinary, not an error.
   */
  async routeGeometry(postgresDb: string, osmId: number): Promise<GeoRouteGeometry | null> {
    const path = `/regions/${encodeURIComponent(postgresDb)}`
      + `/routes/${encodeURIComponent(String(osmId))}/geometry`;
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`geo: GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as GeoRouteGeometry;
  }

  /**
   * What lies within reach that would carry a day of its own (§4.6).
   *
   * Neither a POI search nor a route search: the answer is a *place*,
   * counted out of the spots standing in it. It exists so the planner
   * can say "Florence is an hour away" rather than stretch four days
   * out of a pool that carries two.
   */
  async searchDayTargets(
    postgresDb: string,
    query: GeoDayTargetQuery,
  ): Promise<GeoDayTargetPage> {
    return await this.postJson<GeoDayTargetPage>("/day-targets/search", {
      database: postgresDb,
      center: query.center,
      minRadiusM: query.minRadiusM,
      maxRadiusM: query.maxRadiusM,
      limit: query.limit,
    });
  }

  /**
   * Which of the current style's tables a region database has.
   *
   * osm2pgsql applies a style on `--create` only and never migrates an
   * existing database, so a region imported before a table joined the
   * style does not have it. This is how "that region is an older
   * import" becomes a fact rather than a guess from a date.
   */
  async regionTables(postgresDb: string): Promise<GeoRegionTables> {
    const path = `/regions/${encodeURIComponent(postgresDb)}/tables`;
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`geo: GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as GeoRegionTables;
  }

  async hasCoverage(postgresDb: string, lat: number, lon: number): Promise<boolean> {
    const body = await this.postJson<{ covered: boolean }>("/coverage", {
      database: postgresDb,
      lat,
      lon,
    });
    return body.covered === true;
  }

  async waterCrossing(
    postgresDb: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<GeoWaterCrossing> {
    const body = await this.postJson<GeoWaterCrossing>("/water", {
      database: postgresDb,
      from,
      to,
    });
    return {
      crossedM: Number(body.crossedM ?? 0),
      widestM: Number(body.widestM ?? 0),
      extentM: Number(body.extentM ?? 0),
      name: body.name ?? null,
    };
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
