/**
 * Region import pipeline.
 *
 *   POST /import { slug, postgresDb, pbfUrl }
 *
 * Steps:
 *   1. Download PBF to /data/pbf/<slug>.pbf (skipped if file present).
 *   2. CREATE DATABASE <postgresDb> on geo-db (idempotent).
 *   3. CREATE EXTENSION postgis on the new DB.
 *   4. Run osm2pgsql --create with the flex style in src/osm2pgsql.lua.
 *   5. Add the trigram + GIN indexes the runtime queries need.
 *   6. ANALYZE.
 *
 * The handler streams osm2pgsql stdout/stderr into the parent process'
 * log so a stuck import is debuggable from `docker compose logs geo`.
 */

import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { adminPool, connectionInfo, dropPool, poolFor } from "./db.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = process.env.GEO_DATA_DIR ?? "/data";
const PBF_DIR = path.join(DATA_DIR, "pbf");
const FLAT_NODE_DIR = path.join(DATA_DIR, "work");
const LUA_STYLE = path.join(__dirname, "osm2pgsql.lua");

export interface ImportRequest {
  slug: string;
  postgresDb: string;
  pbfUrl: string;
}

export interface ImportResult {
  slug: string;
  postgresDb: string;
  pbfSizeMb: number;
  importedAt: string;
  durationSeconds: number;
}

export async function runImport(req: ImportRequest): Promise<ImportResult> {
  validateRequest(req);

  await mkdir(PBF_DIR, { recursive: true });
  await mkdir(FLAT_NODE_DIR, { recursive: true });

  const startedAt = Date.now();
  const pbfPath = path.join(PBF_DIR, `${slugToFile(req.slug)}.pbf`);

  await downloadPbf(req.pbfUrl, pbfPath);
  const pbfBytes = statSync(pbfPath).size;

  await ensureDatabase(req.postgresDb);
  await ensurePostgisAndSchema(req.postgresDb);

  const flatNode = path.join(FLAT_NODE_DIR, `${slugToFile(req.slug)}.flat`);
  await runOsm2pgsql(req.postgresDb, pbfPath, flatNode);

  await postImportIndexes(req.postgresDb);
  await runAnalyze(req.postgresDb);

  return {
    slug: req.slug,
    postgresDb: req.postgresDb,
    pbfSizeMb: Math.round(pbfBytes / (1024 * 1024)),
    importedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

export async function dropRegion(postgresDb: string): Promise<boolean> {
  // node-pg can't run DROP DATABASE while clients are connected, so we
  // terminate them first via pg_terminate_backend.
  await dropPool(postgresDb);
  const admin = adminPool();
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [postgresDb],
  );
  const res = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [postgresDb],
  );
  if (res.rowCount === 0) return false;
  await admin.query(`DROP DATABASE ${quoteIdent(postgresDb)}`);
  return true;
}

function validateRequest(req: ImportRequest): void {
  if (!req.slug || typeof req.slug !== "string") {
    throw new Error("slug is required");
  }
  if (!req.postgresDb || !/^[a-z0-9_]+$/.test(req.postgresDb)) {
    throw new Error(`postgresDb must match [a-z0-9_]+, got '${req.postgresDb}'`);
  }
  try {
    const u = new URL(req.pbfUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("pbfUrl must be http(s)");
    }
  } catch {
    throw new Error(`pbfUrl is not a valid URL: '${req.pbfUrl}'`);
  }
}

async function downloadPbf(url: string, target: string): Promise<void> {
  if (existsSync(target)) {
    console.log(`[geo] pbf already cached: ${target}`);
    return;
  }
  console.log(`[geo] downloading ${url} → ${target}`);
  // curl over spawn: streams to disk without buffering the full PBF
  // (which can be multiple GB) in memory.
  await execCommand("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    target,
    url,
  ]);
}

async function ensureDatabase(name: string): Promise<void> {
  const admin = adminPool();
  const res = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [name],
  );
  if (res.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  }
}

async function ensurePostgisAndSchema(database: string): Promise<void> {
  const pool = poolFor(database);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
  // osm2pgsql --create blows away existing tables, so we don't pre-
  // create anything here. We do reset the search_path for any future
  // sessions.
}

async function runOsm2pgsql(
  database: string,
  pbfPath: string,
  flatNodePath: string,
): Promise<void> {
  const conn = connectionInfo();
  const args = [
    "--create",
    "--slim",
    "--drop",                  // we re-import full PBF every time, no diff state needed for now
    "--flat-nodes", flatNodePath,
    "--output", "flex",
    "--style", LUA_STYLE,
    "--database", database,
    "--host", conn.host,
    "--port", String(conn.port),
    "--username", conn.user,
    "--cache", String(parseInt(process.env.GEO_OSM2PGSQL_CACHE_MB ?? "2000", 10)),
    "--number-processes", String(parseInt(process.env.GEO_OSM2PGSQL_PROCS ?? "2", 10)),
    pbfPath,
  ];
  console.log(`[geo] running osm2pgsql for db=${database} pbf=${pbfPath}`);
  await execCommand("osm2pgsql", args, { PGPASSWORD: conn.password });
}

async function postImportIndexes(database: string): Promise<void> {
  const pool = poolFor(database);
  // The Flex style emits GIST(geom) automatically when not_null is
  // set, but we want a few extras for the runtime query plans.
  await pool.query(`CREATE INDEX IF NOT EXISTS osm_pois_kind_idx     ON osm_pois (kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS osm_pois_tags_idx     ON osm_pois USING GIN (tags)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS osm_admin_level_idx   ON osm_admin (admin_level)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS osm_highways_name_idx ON osm_highways (name)`);
}

async function runAnalyze(database: string): Promise<void> {
  const pool = poolFor(database);
  await pool.query(`ANALYZE osm_highways`);
  await pool.query(`ANALYZE osm_pois`);
  await pool.query(`ANALYZE osm_admin`);
}

function execCommand(
  cmd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to quote unsafe identifier '${name}'`);
  }
  return `"${name}"`;
}

function slugToFile(slug: string): string {
  return slug.replace(/[\\/]+/g, "_");
}
