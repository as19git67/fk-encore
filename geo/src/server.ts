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
 *   GET    /pois/categories       — the category vocabulary /pois/search accepts
 *   POST   /import                — { slug, postgresDb, pbfUrl }
 *   DELETE /regions/:database     — drop a region database (admin)
 *
 * Authentication: the geo service runs on a Docker-internal network
 * and is not exposed to the public; the encore-app is its only
 * client. We keep the surface unauthenticated by default but honour
 * GEO_SHARED_SECRET when set — a simple Bearer check.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { adminPool, closeAllPools } from "./db.ts";
import { reverseGeocode } from "./reverse.ts";
import { findPoiCandidates } from "./pois.ts";
import { readRegionStorage } from "./storage.ts";
import { POI_CATEGORIES } from "./poi-categories.ts";
import { PoiSearchError, searchPois, type PoiSearchOptions } from "./poi-search.ts";
import {
  dropRegion,
  getImportStatus,
  reconcileImportStatus,
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
const SHARED_SECRET = process.env.GEO_SHARED_SECRET ?? "";

const app = express();
app.use(express.json({ limit: "256kb" }));

if (SHARED_SECRET) {
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const header = req.header("authorization") ?? "";
    if (header !== `Bearer ${SHARED_SECRET}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
}

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
  if (err instanceof PoiSearchError) {
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
  if (b.categories !== undefined && b.categories !== null) {
    if (!Array.isArray(b.categories) || b.categories.some((c) => typeof c !== "string")) {
      throw new HttpError(400, "categories must be an array of strings");
    }
    options.categories = b.categories as string[];
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
