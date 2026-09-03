/**
 * Replication updater for the per-region PostGIS databases.
 *
 * Uses osm2pgsql's bundled `osm2pgsql-replication` tool, which stores
 * its high-water sequence inside the database itself. Versions before
 * osm2pgsql 1.9 use `planet_osm_replication_status`; newer versions use
 * replication properties in `osm2pgsql_properties`.
 *
 *   initReplication        ran by the importer after a fresh
 *                           `osm2pgsql --create`. Tells the tool
 *                           which replication base URL to track and
 *                           which sequence to start from (derived
 *                           from the PBF timestamp).
 *
 *   runReplicationUpdate    pulls every diff published since the last
 *                           successful update and applies it with
 *                           `osm2pgsql --append`. Idempotent — a
 *                           re-run when no new diffs are available is
 *                           a cheap no-op.
 *
 *   replicationLoop         setInterval-driven background loop that
 *                           calls runReplicationUpdate on every
 *                           imported region every
 *                           GEO_REPLICATION_INTERVAL_MS (default 1h).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { adminPool, connectionInfo, poolFor } from "./db.ts";
import { refreshFacadeAzimuth } from "./facade-azimuth.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LUA_STYLE = path.join(__dirname, "osm2pgsql.lua");
const REPLICATION_INTERVAL_MS = parseInt(
  process.env.GEO_REPLICATION_INTERVAL_MS ?? String(60 * 60 * 1000),
  10,
);

export interface ReplicationResult {
  postgresDb: string;
  /** Number of diffs applied this run; 0 when already up to date. */
  appliedDiffs: number;
  /** Sequence number reported by osm2pgsql-replication after the run. */
  sequence: number | null;
  /** ISO timestamp of the most recently applied diff. */
  timestamp: string | null;
}

export interface ReplicationStatus {
  postgresDb: string;
  initialized: boolean;
  sequence: number | null;
  timestamp: string | null;
}

export interface ReplicationStatusQuery {
  query<T>(text: string): Promise<{ rows: T[] }>;
}

// A missing status table is actionable only once per process. Repeating the
// same warning every hour hides real failures in otherwise healthy logs. The
// entry is removed as soon as the region becomes initialized.
const warnedUninitialized = new Set<string>();
const warnedNotUpdatable = new Set<string>();

/**
 * Geofabrik publishes its replication state under
 * `<region>-updates/state.txt`. The PBF download lives at
 * `<region>-latest.osm.pbf`. Convert the latter to the former.
 */
export function replicationUrlFor(pbfUrl: string): string {
  return pbfUrl.replace(/-latest\.osm\.pbf$/, "-updates/");
}

/**
 * Initialise replication tracking for a freshly-imported region.
 * Safe to call repeatedly — `osm2pgsql-replication init` is
 * idempotent once the tables are created.
 */
export async function initReplication(
  postgresDb: string,
  pbfUrl: string,
): Promise<void> {
  const url = replicationUrlFor(pbfUrl);
  await execCommand("osm2pgsql-replication", [
    "init",
    "--server", url,
    ...pgArgs(postgresDb),
  ]);
}

/**
 * Pull and apply any new diffs. Returns a summary describing what
 * happened. Caller surfaces non-zero exit codes as failures; an exit
 * of 0 with appliedDiffs === 0 means "nothing new yet".
 *
 * Self-healing: a region whose version-specific replication state is
 * missing was imported but never had replication initialised (e.g. the
 * non-fatal `initReplication` at import time failed, or it predates
 * replication support). Running `osm2pgsql-replication update` against
 * such a DB crashes inside the tool (`'NoneType' has no attribute
 * 'sequence'`). When a `pbfUrl` is supplied we run `init` first to heal
 * it; without one (the background loop has no URL) we skip gracefully
 * so a single uninitialised region doesn't spam the log with crashes.
 */
export async function runReplicationUpdate(
  postgresDb: string,
  pbfUrl?: string,
): Promise<ReplicationResult> {
  const status = await getReplicationStatus(postgresDb);
  if (!status.initialized) {
    if (!pbfUrl) {
      if (!warnedUninitialized.has(postgresDb)) {
        warnedUninitialized.add(postgresDb);
        console.warn(
          `[geo] replication ${postgresDb}: not initialised (no ` +
            `replication state) and no pbfUrl available — ` +
            `skipping while osm-admin schedules automatic healing.`,
        );
      }
      return { postgresDb, appliedDiffs: 0, sequence: null, timestamp: null };
    }
    console.warn(
      `[geo] replication ${postgresDb}: not initialised — running ` +
        `osm2pgsql-replication init before the first update.`,
    );
    await initReplication(postgresDb, pbfUrl);
  }
  warnedUninitialized.delete(postgresDb);

  const updateStorage = await getUpdateStorageStatus(postgresDb);
  if (!updateStorage.updatable) {
    const msg =
      `osm2pgsql slim middle table(s) missing: ${updateStorage.missingTables.join(", ")}. ` +
      `This region was imported without retained slim tables; reimport it to enable replication.`;
    if (pbfUrl) {
      throw new Error(msg);
    }
    if (!warnedNotUpdatable.has(postgresDb)) {
      warnedNotUpdatable.add(postgresDb);
      console.warn(`[geo] replication ${postgresDb}: ${msg} Skipping background update.`);
    }
    return {
      postgresDb,
      appliedDiffs: 0,
      sequence: status.sequence,
      timestamp: status.timestamp,
    };
  }
  warnedNotUpdatable.delete(postgresDb);

  // `osm2pgsql-replication update` prints summary lines we parse for
  // metrics. Capture stdout/stderr instead of inheriting.
  const before = await readState(postgresDb);
  // Argument order matters. The DB connection flags (--database,
  // --host, --port, --username) must come BEFORE the `--` so they
  // configure osm2pgsql-replication's own Postgres connection (it
  // reads/writes the replication-status table). Everything AFTER the
  // `--` is forwarded verbatim to the osm2pgsql append subprocess.
  //
  // Putting the connection flags after `--` leaves osm2pgsql-
  // replication itself with no host/user, so it falls back to a local
  // socket connection as the OS user — which in this container is the
  // unmapped UID 568, giving
  //   psycopg2.OperationalError: local user with ID 568 does not exist
  //
  // The forwarded osm2pgsql flags must still match the import: same
  // flex style and slim mode. No `--flat-nodes` — node coordinates are
  // read from the `planet_osm_nodes` middle table (see import.ts for
  // why the flat-node file is deliberately not used).
  await execCommand("osm2pgsql-replication", [
    "update",
    ...pgArgs(postgresDb),
    "--",
    "--output", "flex",
    "--style", LUA_STYLE,
    "--slim",
    "--cache", String(parseInt(process.env.GEO_OSM2PGSQL_CACHE_MB ?? "2000", 10)),
    "--number-processes", String(parseInt(process.env.GEO_OSM2PGSQL_PROCS ?? "2", 10)),
  ]);
  const after = await readState(postgresDb);

  // An append re-inserts changed POIs through the same table
  // definition, so a rebuilt area POI arrives with an outline and no
  // azimuth. The pass is incremental and does nothing when the diff
  // touched no area POI.
  await refreshFacadeAzimuth(postgresDb).catch((err: unknown) => {
    // A missing azimuth degrades the light hint; it must not fail an
    // otherwise successful replication update.
    console.warn(
      `[geo] facade azimuth refresh after update failed for ${postgresDb}: ` +
        `${(err as Error).message}`,
    );
  });

  return {
    postgresDb,
    appliedDiffs: Math.max(0, (after.sequence ?? 0) - (before.sequence ?? 0)),
    sequence: after.sequence,
    timestamp: after.timestamp,
  };
}

export async function getUpdateStorageStatus(
  postgresDb: string,
  db: ReplicationStatusQuery = poolFor(postgresDb),
): Promise<{ updatable: boolean; missingTables: string[] }> {
  const expected = [
    "planet_osm_nodes",
    "planet_osm_ways",
    "planet_osm_rels",
  ] as const;
  const rows = await db.query<Record<(typeof expected)[number], string | null>>(
    `SELECT to_regclass('public.planet_osm_nodes')::text AS planet_osm_nodes,
            to_regclass('public.planet_osm_ways')::text AS planet_osm_ways,
            to_regclass('public.planet_osm_rels')::text AS planet_osm_rels`,
  );
  const found = rows.rows[0] ?? {};
  const missingTables = expected.filter((name) => !found[name]);
  return { updatable: missingTables.length === 0, missingTables };
}

/**
 * Read replication state across the two storage layouts used by supported
 * osm2pgsql versions. Debian Bookworm ships 1.8 and therefore creates
 * `planet_osm_replication_status` (columns url, sequence, importdate).
 * osm2pgsql >= 1.9 stores replication_* keys in `osm2pgsql_properties`.
 * Connection and read errors deliberately propagate so the caller retries
 * them instead of mistaking an unavailable DB for an uninitialized region.
 */
export async function getReplicationStatus(
  postgresDb: string,
  queryOverride?: ReplicationStatusQuery,
): Promise<ReplicationStatus> {
  const pool = queryOverride ?? await (async () => {
    const { poolFor } = await import("./db.ts");
    return poolFor(postgresDb) as unknown as ReplicationStatusQuery;
  })();
  const tables = await pool.query<{
    properties_table: string | null;
    legacy_table: string | null;
  }>(
    `SELECT to_regclass('public.osm2pgsql_properties')::text AS properties_table,
            to_regclass('public.planet_osm_replication_status')::text AS legacy_table`,
  );
  const available = tables.rows[0];

  if (available?.properties_table) {
    const properties = await pool.query<{ property: string; value: string }>(
      `SELECT property, value
         FROM osm2pgsql_properties
        WHERE property IN (
          'replication_base_url',
          'replication_sequence_number',
          'replication_timestamp'
        )`,
    );
    const values = new Map(properties.rows.map((row) => [row.property, row.value]));
    const baseUrl = values.get("replication_base_url");
    const rawSequence = values.get("replication_sequence_number");
    if (baseUrl && rawSequence) {
      warnedUninitialized.delete(postgresDb);
      return {
        postgresDb,
        initialized: true,
        sequence: parseSequence(rawSequence),
        timestamp: values.get("replication_timestamp") ?? null,
      };
    }
  }

  if (available?.legacy_table) {
    const legacy = await pool.query<{ sequence: string | number | null; timestamp: string | null }>(
      `SELECT sequence, importdate::text AS timestamp
         FROM planet_osm_replication_status
        LIMIT 1`,
    );
    const row = legacy.rows[0];
    if (row) {
      warnedUninitialized.delete(postgresDb);
      return {
        postgresDb,
        initialized: true,
        sequence: parseSequence(row.sequence),
        timestamp: row.timestamp,
      };
    }
  }

  return { postgresDb, initialized: false, sequence: null, timestamp: null };
}

interface ReplicationStateRow {
  sequence: number | null;
  timestamp: string | null;
}

async function readState(postgresDb: string): Promise<ReplicationStateRow> {
  const status = await getReplicationStatus(postgresDb);
  if (!status.initialized) {
    throw new Error(`replication state disappeared for ${postgresDb}`);
  }
  return { sequence: status.sequence, timestamp: status.timestamp };
}

function parseSequence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function pgArgs(database: string): string[] {
  const c = connectionInfo();
  return [
    "--database", database,
    "--host", c.host,
    "--port", String(c.port),
    "--username", c.user,
  ];
}

function execCommand(cmd: string, args: string[]): Promise<void> {
  const c = connectionInfo();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PGPASSWORD: c.password },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// ── Periodic loop ───────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * Start the background replication loop. Invoked once at server boot
 * (see server.ts). Safe to call multiple times — idempotent.
 */
export function startReplicationLoop(): void {
  if (timer) return;
  console.log(`[geo] replication loop armed (interval=${REPLICATION_INTERVAL_MS}ms)`);
  timer = setInterval(() => {
    void tickReplication().catch((err) => {
      console.error("[geo] replication tick failed:", err);
    });
  }, REPLICATION_INTERVAL_MS);
  // Unref the timer so it doesn't keep the process alive on shutdown.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopReplicationLoop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Run one replication pass across every region database (those whose
 * datname starts with `nom_`). Errors per region are logged and do
 * not abort the loop — a single broken region doesn't starve the
 * others.
 */
export async function tickReplication(): Promise<{
  attempted: string[];
  succeeded: string[];
  failed: Array<{ postgresDb: string; error: string }>;
}> {
  const admin = adminPool();
  const res = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE 'nom\\_%' ESCAPE '\\' ORDER BY datname`,
  );
  const dbs = res.rows.map((r) => r.datname);
  const succeeded: string[] = [];
  const failed: Array<{ postgresDb: string; error: string }> = [];
  for (const db of dbs) {
    try {
      const r = await runReplicationUpdate(db);
      if (r.appliedDiffs > 0) {
        console.log(`[geo] replication ${db}: +${r.appliedDiffs} diffs (seq=${r.sequence})`);
      }
      succeeded.push(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ postgresDb: db, error: msg });
      console.warn(`[geo] replication ${db} failed: ${msg}`);
    }
  }
  return { attempted: dbs, succeeded, failed };
}
