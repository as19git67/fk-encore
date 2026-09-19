/**
 * Geo HTTP server.
 *
 * Endpoints:
 *   GET    /health                — liveness + db reachability
 *   GET    /status                — list known region databases
 *   GET    /storage/:database     — per-table size breakdown for one region
 *   GET    /replication/status/:postgresDb — replication state for one region
 *   POST   /reverse               — { database, lat, lon } → ReverseResult
 *   POST   /pois                  — { database, lat, lon, radiusM?, maxCandidates? }
 *   POST   /pois/search           — area search for trip planning
 *   POST   /coverage              — { database, lat, lon, radiusM? } → is that
 *                                   corner of the world in this database at all
 *   POST   /water                 — { database, from, to } → how much water the
 *                                   straight line between them crosses
 *   GET    /pois/categories       — the category vocabulary /pois/search accepts
 *   POST   /import                — { slug, postgresDb, pbfUrl }
 *   GET    /regions/:database/tables — which style tables it has
 *   DELETE /regions/:database     — drop a region database (admin)
 *
 * Authentication: the geo service runs on a Docker-internal network
 * and is not exposed to the public; the encore-app is its only
 * client. We keep the surface unauthenticated by default but honour
 * GEO_SHARED_SECRET when set — a simple Bearer check.
 */

import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminPool, closeAllPools } from "./db.ts";
import { reverseGeocode } from "./reverse.ts";
import { findPoiCandidates } from "./pois.ts";
import { readRegionStorage } from "./storage.ts";
import { POI_CATEGORIES } from "./poi-categories.ts";
import { hasCoverage } from "./coverage.ts";
import { waterCrossing } from "./water.ts";
import { PoiSearchError, searchPois, type PoiSearchOptions } from "./poi-search.ts";
import { RouteSearchError, searchRoutes, type RouteSearchOptions } from "./route-search.ts";
import { DayTargetError, searchDayTargets, type DayTargetOptions } from "./day-targets.ts";
import {
  dropRegion,
  getImportStatus,
  reconcileImportStatus,
  regionTables,
  startImport,
  type ImportRequest,
} from "./import.ts";
import {
  getReplicationStatus,
  runReplicationUpdate,
  startReplicationLoop,
  stopReplicationLoop,
} from "./replication.ts";

const PORT = parseInt(process.env.GEO_PORT ?? "8080", 10);
/**
 * Mandatory, like the five Python services.
 *
 * This used to be optional: the check below was installed only when the
 * variable happened to be set, so an empty value meant geo answered anybody
 * who could route to it. It publishes no host port, but a container on the
 * same bridge network reached the whole OSM database and the import
 * endpoints. Refusing to start makes a misconfigured deployment fail loudly
 * at boot instead of quietly serving.
 */
const SHARED_SECRET = (process.env.GEO_SHARED_SECRET ?? "").trim();
if (!SHARED_SECRET) {
  console.error(
    "GEO_SHARED_SECRET is not set. This service has no other authentication, " +
      "so it refuses to start rather than listen unprotected. Generate a value " +
      "with `openssl rand -hex 32` and set it for both geo and the app.",
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "256kb" }));

/**
 * Compare without leaking where the mismatch is.
 *
 * `!==` on strings returns as soon as two bytes differ, which over enough
 * requests tells an attacker how long a shared prefix they have found.
 * Lengths are compared first because timingSafeEqual throws on a mismatch,
 * and the length of a secret is not the part worth hiding.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Health stays open so the container healthcheck needs no credentials.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const header = req.header("authorization") ?? "";
  if (!secretMatches(header, `Bearer ${SHARED_SECRET}`)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await adminPool().query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/status", async (_req, res, next) => {
  try {
    const result = await adminPool().query<{
      datname: string;
      size_mb: number;
    }>(`
      SELECT datname,
             pg_database_size(datname) / 1024 / 1024 AS size_mb
        FROM pg_database
       WHERE datname LIKE 'nom\\_%' ESCAPE '\\'
       ORDER BY datname
    `);
    res.json({
      regions: result.rows.map((r) => ({
        database: r.datname,
        sizeMb: Number(r.size_mb),
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.get("/storage/:database", async (req, res, next) => {
  try {
    const database = req.params.database ?? "";
    if (!/^[a-z0-9_]+$/.test(database)) {
      throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
    }
    res.json(await readRegionStorage(database));
  } catch (err) {
    next(err);
  }
});

app.post("/reverse", async (req, res, next) => {
  try {
    const { database, lat, lon } = parseLookupBody(req.body);
    const result = await reverseGeocode(database, lat, lon);
    res.json({ database, result });
  } catch (err) {
    next(err);
  }
});

app.post("/pois", async (req, res, next) => {
  try {
    const { database, lat, lon } = parseLookupBody(req.body);
    const radiusM = optionalPositiveInt(req.body?.radiusM);
    const maxCandidates = optionalPositiveInt(req.body?.maxCandidates);
    const candidates = await findPoiCandidates(database, lat, lon, {
      radiusM,
      maxCandidates,
    });
    res.json({ database, candidates });
  } catch (err) {
    next(err);
  }
});

app.post("/coverage", async (req, res, next) => {
  try {
    const { database, lat, lon } = parseLookupBody(req.body);
    const radiusM = optionalPositiveInt((req.body as Record<string, unknown>)?.radiusM);
    const covered = await hasCoverage(database, lat, lon, radiusM);
    res.json({ database, covered });
  } catch (err) {
    next(err);
  }
});

/**
 * Is there a lake in the way?
 *
 * The planner has no router and estimates a journey as the straight
 * line times a factor, which a lake makes nonsense of (see
 * `water.ts`). This says how much water is on the line and how big the
 * biggest thing in the way is; what the way round costs is the
 * caller's estimate.
 */
app.post("/water", async (req, res, next) => {
  try {
    const { database, from, to } = parseWaterBody(req.body);
    const crossing = await waterCrossing(database, from, to);
    res.json({ database, ...crossing });
  } catch (err) {
    next(err);
  }
});

app.get("/pois/categories", (_req, res) => {
  res.json({
    categories: POI_CATEGORIES.map((c) => ({ id: c.id, description: c.description })),
  });
});

app.post("/pois/search", async (req, res, next) => {
  try {
    const { database, options } = parseSearchBody(req.body);
    const page = await searchPois(database, options);
    res.json({ database, ...page });
  } catch (err) {
    next(err);
  }
});

// Signposted walking and cycling routes near a place (§4.7). Its own
// endpoint rather than a category of /pois/search, because a route is
// a way rather than a point: it answers with two ends, a length and a
// shape, none of which a POI has.
app.post("/routes/search", async (req, res, next) => {
  try {
    const { database, options } = parseRouteSearchBody(req.body);
    const page = await searchRoutes(database, options);
    res.json({ database, ...page });
  } catch (err) {
    next(err);
  }
});

// What lies within reach that would carry a day of its own (§4.6).
// Neither a POI search nor a route search: the answer is a *place*,
// counted out of the spots standing in it, and it exists so a planner
// can say "Florence is an hour away" instead of stretching four days
// out of a pool that carries two.
app.post("/day-targets/search", async (req, res, next) => {
  try {
    const { database, options } = parseDayTargetBody(req.body);
    const page = await searchDayTargets(database, options);
    res.json({ database, ...page });
  } catch (err) {
    next(err);
  }
});

app.post("/import", async (req, res, next) => {
  try {
    const body = req.body as Partial<ImportRequest>;
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "request body must be a JSON object");
    }
    const slug = requireString(body.slug, "slug");
    const postgresDb = requireString(body.postgresDb, "postgresDb");
    const pbfUrl = requireString(body.pbfUrl, "pbfUrl");
    const status = startImport({ slug, postgresDb, pbfUrl });
    res.status(202).json(status);
  } catch (err) {
    next(err);
  }
});

app.get("/imports/:postgresDb", async (req, res, next) => {
  try {
    const postgresDb = req.params.postgresDb ?? "";
    if (!/^[a-z0-9_]+$/.test(postgresDb)) {
      throw new HttpError(400, `postgresDb must match [a-z0-9_]+, got '${postgresDb}'`);
    }
    const status = getImportStatus(postgresDb) ?? await reconcileImportStatus(postgresDb);
    if (!status) {
      res.status(404).json({ error: "no import known for this database" });
      return;
    }
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.get("/replication/status/:postgresDb", async (req, res, next) => {
  try {
    const postgresDb = requireDatabaseName(req.params.postgresDb ?? "");
    res.json(await getReplicationStatus(postgresDb));
  } catch (err) {
    next(err);
  }
});

app.post("/refresh", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const postgresDb = requireDatabaseName(requireString(body.postgresDb, "postgresDb"));
    // Optional: the PBF URL lets the updater auto-initialise replication
    // if the region's status table is missing (see runReplicationUpdate).
    const pbfUrl = typeof body.pbfUrl === "string" ? body.pbfUrl : undefined;
    const result = await runReplicationUpdate(postgresDb, pbfUrl);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Which of the current style's tables a region database has (§4.7).
//
// osm2pgsql applies a style on --create only, so a region imported
// before a table joined the style does not have it and never will
// without a re-import. This is how the admin side finds those regions
// without guessing from an import date.
app.get("/regions/:database/tables", async (req, res, next) => {
  try {
    const database = req.params.database ?? "";
    if (!/^[a-z0-9_]+$/.test(database)) {
      throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
    }
    res.json(await regionTables(database));
  } catch (err) {
    next(err);
  }
});

app.delete("/regions/:database", async (req, res, next) => {
  try {
    const database = req.params.database ?? "";
    if (!/^[a-z0-9_]+$/.test(database)) {
      throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
    }
    const deleted = await dropRegion(database);
    res.json({ database, deleted });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Rejected search arguments (bad bbox, unknown category, oversized
  // radius) are the caller's mistake, not ours — 400, not 500.
  if (err instanceof PoiSearchError || err instanceof RouteSearchError
      || err instanceof DayTargetError) {
    res.status(400).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[geo] unhandled error:", err);
  res.status(500).json({ error: msg });
});

const server = app.listen(PORT, () => {
  console.log(`[geo] listening on :${PORT}`);
});

// Arm the background replication loop. Disabled when GEO_REPLICATION
// is set to "off" — useful in tests and during initial import work.
if (process.env.GEO_REPLICATION !== "off") {
  startReplicationLoop();
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[geo] ${signal} received, shutting down`);
  stopReplicationLoop();
  server.close(async () => {
    await closeAllPools();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── helpers ────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parseLookupBody(body: unknown): { database: string; lat: number; lon: number } {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const database = requireString(b.database, "database");
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
  }
  const lat = requireFiniteNumber(b.lat, "lat");
  const lon = requireFiniteNumber(b.lon, "lon");
  if (lat < -90 || lat > 90) throw new HttpError(400, `lat out of range: ${lat}`);
  if (lon < -180 || lon > 180) throw new HttpError(400, `lon out of range: ${lon}`);
  return { database, lat, lon };
}

function parseWaterBody(body: unknown): {
  database: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
} {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const database = requireString(b.database, "database");
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
  }
  return { database, from: requirePoint(b.from, "from"), to: requirePoint(b.to, "to") };
}

function requirePoint(value: unknown, field: string): { lat: number; lon: number } {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, `${field} must be an object with lat and lon`);
  }
  const p = value as Record<string, unknown>;
  const lat = requireFiniteNumber(p.lat, `${field}.lat`);
  const lon = requireFiniteNumber(p.lon, `${field}.lon`);
  if (lat < -90 || lat > 90) throw new HttpError(400, `${field}.lat out of range: ${lat}`);
  if (lon < -180 || lon > 180) throw new HttpError(400, `${field}.lon out of range: ${lon}`);
  return { lat, lon };
}

function requireDatabaseName(database: string): string {
  if (!/^nom_[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `postgresDb must match nom_[a-z0-9_]+, got '${database}'`);
  }
  return database;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, `${field} is required`);
  }
  return v;
}

function requireFiniteNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(400, `${field} must be a finite number`);
  }
  return v;
}

function parseRouteSearchBody(
  body: unknown,
): { database: string; options: RouteSearchOptions } {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const database = requireString(b.database, "database");
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
  }
  if (b.center === undefined || b.center === null) {
    throw new HttpError(400, "center is required");
  }
  const center = b.center as Record<string, unknown>;
  return {
    database,
    options: {
      center: {
        lat: requireFiniteNumber(center.lat, "center.lat"),
        lon: requireFiniteNumber(center.lon, "center.lon"),
      },
      radiusM: requireFiniteNumber(b.radiusM, "radiusM"),
      kinds: Array.isArray(b.kinds) ? b.kinds.map(String) : undefined,
      limit: optionalPositiveInt(b.limit),
    },
  };
}

function parseDayTargetBody(
  body: unknown,
): { database: string; options: DayTargetOptions } {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const database = requireString(b.database, "database");
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
  }
  if (b.center === undefined || b.center === null) {
    throw new HttpError(400, "center is required");
  }
  const center = b.center as Record<string, unknown>;
  return {
    database,
    options: {
      center: {
        lat: requireFiniteNumber(center.lat, "center.lat"),
        lon: requireFiniteNumber(center.lon, "center.lon"),
      },
      minRadiusM: requireFiniteNumber(b.minRadiusM, "minRadiusM"),
      maxRadiusM: requireFiniteNumber(b.maxRadiusM, "maxRadiusM"),
      limit: optionalPositiveInt(b.limit),
    },
  };
}

function parseSearchBody(body: unknown): { database: string; options: PoiSearchOptions } {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const database = requireString(b.database, "database");
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new HttpError(400, `database must match [a-z0-9_]+, got '${database}'`);
  }

  const options: PoiSearchOptions = {
    limit: optionalPositiveInt(b.limit),
    offset: optionalNonNegativeInt(b.offset),
  };

  if (b.bbox !== undefined && b.bbox !== null) {
    const bbox = b.bbox as Record<string, unknown>;
    options.bbox = {
      minLat: requireFiniteNumber(bbox.minLat, "bbox.minLat"),
      minLon: requireFiniteNumber(bbox.minLon, "bbox.minLon"),
      maxLat: requireFiniteNumber(bbox.maxLat, "bbox.maxLat"),
      maxLon: requireFiniteNumber(bbox.maxLon, "bbox.maxLon"),
    };
  }
  if (b.center !== undefined && b.center !== null) {
    const center = b.center as Record<string, unknown>;
    options.center = {
      lat: requireFiniteNumber(center.lat, "center.lat"),
      lon: requireFiniteNumber(center.lon, "center.lon"),
      radiusM: requireFiniteNumber(center.radiusM, "center.radiusM"),
    };
  }
  if (b.corridor !== undefined && b.corridor !== null) {
    const corridor = b.corridor as Record<string, unknown>;
    const from = (corridor.from ?? {}) as Record<string, unknown>;
    const to = (corridor.to ?? {}) as Record<string, unknown>;
    options.corridor = {
      from: {
        lat: requireFiniteNumber(from.lat, "corridor.from.lat"),
        lon: requireFiniteNumber(from.lon, "corridor.from.lon"),
      },
      to: {
        lat: requireFiniteNumber(to.lat, "corridor.to.lat"),
        lon: requireFiniteNumber(to.lon, "corridor.to.lon"),
      },
      detourBudgetM: requireFiniteNumber(corridor.detourBudgetM, "corridor.detourBudgetM"),
    };
  }
  if (b.categories !== undefined && b.categories !== null) {
    if (!Array.isArray(b.categories) || b.categories.some((c) => typeof c !== "string")) {
      throw new HttpError(400, "categories must be an array of strings");
    }
    options.categories = b.categories as string[];
  }
  if (b.name !== undefined && b.name !== null) {
    if (typeof b.name !== "string") throw new HttpError(400, "name must be a string");
    options.name = b.name;
  }
  if (b.rank !== undefined && b.rank !== null) {
    if (b.rank !== "distance" && b.rank !== "prominence") {
      throw new HttpError(400, "rank must be 'distance' or 'prominence'");
    }
    options.rank = b.rank;
  }

  return { database, options };
}

function optionalNonNegativeInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new HttpError(400, "value must be zero or a positive number");
  }
  return Math.floor(v);
}

function optionalPositiveInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new HttpError(400, "value must be a positive number");
  }
  return Math.floor(v);
}
