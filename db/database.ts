import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { config } from "dotenv";
import path from "path";
import fs from "fs";

// Load .env from project root
const rootDir = process.cwd();
const envPath = path.resolve(rootDir, ".env");
if (fs.existsSync(envPath)) {
  config({ path: envPath });
} else {
  // Try one level up if we are inside a subdirectory (e.g. during build/test)
  const altEnvPath = path.resolve(rootDir, "..", ".env");
  if (fs.existsSync(altEnvPath)) {
    config({ path: altEnvPath });
  }
}

import * as schema from "./schema";
import { seed } from "./seed";
import { seedDemo } from "./seed-demo";

type DbInstance = ReturnType<typeof drizzle<typeof schema>>;

function buildConnectionString(): string {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const database = process.env.POSTGRES_DATABASE || "fk_encore";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const targetDb = url.pathname.replace(/^\//, '');
  if (!targetDb || targetDb === 'postgres') return;

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    await adminPool.query(`CREATE DATABASE "${targetDb}"`);
    console.log(`[db] Created database: ${targetDb}`);
  } catch (err: any) {
    if (err.code !== '42P04') throw err; // 42P04 = duplicate_database, ignore
  } finally {
    await adminPool.end();
  }
}

async function createDb(): Promise<DbInstance> {
  const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

  const connectionString = isTest
    ? (process.env.POSTGRES_TEST_CONNECTION_STRING ||
       process.env.POSTGRES_CONNECTION_STRING ||
       buildConnectionString() + "_test")
    : (process.env.POSTGRES_CONNECTION_STRING || buildConnectionString());

  // In test mode the DB is created/dropped by vitest.globalsetup.ts
  if (!isTest) {
    await ensureDatabaseExists(connectionString);
  }

  // Pool size is configurable so the scan-worker semaphore (see
  // photo/worker-db-slots.ts) and the HTTP request handlers can share the
  // pool without starving each other. Default: 20 (pg default is 10, which
  // is too tight once scan workers hold connections across RPC waits).
  const poolMax = Math.max(
    2,
    parseInt(process.env.POSTGRES_POOL_MAX ?? (isTest ? "10" : "20"), 10),
  );
  const pool = new Pool({ connectionString, max: poolMax });
  const db = drizzle(pool, { schema });
  if (!isTest) {
    console.log(`[db] pool max=${poolMax}`);
  }

  const migrationsFolder = path.join(process.cwd(), "db", "migrations", "postgres");
  if (fs.existsSync(migrationsFolder)) {
    await migrate(db, { migrationsFolder });
  }

  // Post-migration seeds. These exist for cases where Postgres forbids
  // referencing a value in the same transaction that introduces it —
  // e.g. ALTER TYPE … ADD VALUE followed by an INSERT using the new
  // enum literal (PG error 55P04). Drizzle's migrator wraps all
  // pending migrations in a single transaction, so a seed-INSERT in a
  // sibling migration would still see the freshly-added value as
  // uncommitted. Running the seed here, after migrate() returns, lets
  // the value be visible. Every statement is idempotent so re-runs
  // are safe.
  await pool.query(`
    INSERT INTO finance_account_type (kind, label)
    VALUES ('bargeld', 'Bargeld')
    ON CONFLICT (kind) DO NOTHING
  `);

  return db;
}

const DB_RETRY_INITIAL_DELAY_MS = 2_000;
const DB_RETRY_MAX_DELAY_MS = 30_000;

// Only these errors are treated as transient. Anything else (failed
// migration, missing extension, bad credentials, syntax error…) is a
// programming/environment problem and should surface immediately rather
// than be retried.
//
// The error is unwrapped along its `cause` chain: query-layer wrappers
// such as Drizzle's DrizzleQueryError bury the driver's pg error — and
// its SQLSTATE `code` — one or more levels deep.
export function isTransientConnectionError(err: unknown): boolean {
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++, cur = cur.cause) {
    const code = cur.code;
    if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      return true;
    }
    // Postgres SQLSTATE class 08 (connection_exception) and the
    // operator-intervention codes 57P01 (admin shutdown), 57P02 (crash
    // shutdown) and 57P03 (cannot_connect_now — "the database system is
    // in recovery mode" / "is starting up"). All mean the cluster is
    // bouncing and the call should be retried, not failed.
    if (
      typeof code === "string" &&
      (code.startsWith("08") ||
        code === "57P01" ||
        code === "57P02" ||
        code === "57P03")
    ) {
      return true;
    }
  }
  return false;
}

let dbInstance: DbInstance | null = null;

export async function initializeDb(): Promise<DbInstance> {
  if (dbInstance) return dbInstance;

  let delay = DB_RETRY_INITIAL_DELAY_MS;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const db = await createDb();
      await seed(db);
      // Optional E2E demo data (Issue #401). Runs after the main seed so
      // the admin user, roles and document categories are guaranteed to
      // exist by the time we start inserting demo rows. Gated by
      // E2E_SEED_DEMO and a no-op under NODE_ENV=test / VITEST.
      if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
        await seedDemo(db);
      }
      // Run backup-related startup housekeeping exactly once. The only
      // piece that blocks boot here is the pending-restore check — if a
      // `restore-*.dump` trigger sits in $BACKUP_DIR the cluster will be
      // rolled back before the app serves traffic. Defensive pg_backup_stop
      // and host-script seeding run in the background inside
      // runStartupHousekeeping; see backup/startup.ts.
      // Loaded lazily so tests (which mock encore.dev/api but not /log)
      // never pull in the backup module's encore.dev/log dependency.
      if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
        try {
          const { runStartupHousekeeping } = await import("../backup/startup");
          // Hard cap on the boot-critical part of housekeeping (currently
          // only the pending-restore check). Defensive pg_backup_stop and
          // host-script seeding fire in the background inside
          // runStartupHousekeeping so a stuck WAL archiver, a slow backup
          // volume, or a broken PG socket can never block the boot.
          const HOUSEKEEPING_TIMEOUT_MS = 60_000;
          console.log("[db] backup housekeeping: start");
          await Promise.race([
            runStartupHousekeeping(),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`backup housekeeping timed out after ${HOUSEKEEPING_TIMEOUT_MS}ms`)),
                HOUSEKEEPING_TIMEOUT_MS,
              ).unref?.(),
            ),
          ]);
          console.log("[db] backup housekeeping: done");
        } catch (err: any) {
          console.error(`[db] backup housekeeping failed: ${err?.message ?? err}`);
        }
      }
      dbInstance = db;
      if (attempt > 1) {
        console.log(`[db] Connected successfully after ${attempt} attempt(s).`);
      }
      console.log("[db] initializeDb complete");
      return db;
    } catch (err: any) {
      if (!isTransientConnectionError(err)) {
        // Schema / migration / configuration errors: fail fast so the
        // real cause is visible instead of looping silently.
        console.error(`[db] Non-transient error during init — aborting:`, err);
        throw err;
      }
      const msg = err?.message ?? String(err);
      console.error(`[db] Connection failed (attempt ${attempt}): ${msg}`);
      console.log(`[db] Retrying in ${delay / 1000}s…`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, DB_RETRY_MAX_DELAY_MS);
    }
  }
}

// Top-level await: blocks module load until DB is ready.
// The process will NOT crash on ECONNREFUSED — it retries until the DB is up.
const db = await initializeDb();
console.log("[db] module load complete — Encore services can now boot");

export default db;
