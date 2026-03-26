import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
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

type DbInstance = BetterSQLite3Database<typeof schema> | ReturnType<typeof drizzlePostgres<typeof schema>>;

async function createDb(): Promise<DbInstance> {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;
  const dbType = process.env.DB_TYPE?.toLowerCase() || "sqlite";

  if (dbType === "postgres") {
    return createPostgresDb(isTest);
  } else {
    return createSqliteDb(isTest);
  }
}

function createSqliteDb(isTest: boolean): BetterSQLite3Database<typeof schema> {
  let sqlite: InstanceType<typeof Database>;

  if (isTest) {
    sqlite = new Database(":memory:");
  } else {
    const dbPath = process.env.SQLITE_DB_PATH || "./data/app.db";
    const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
    const dataDir = path.dirname(resolvedPath);

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    sqlite = new Database(resolvedPath);
    sqlite.pragma("journal_mode = WAL");
  }

  sqlite.pragma("foreign_keys = ON");

  const db = drizzleSqlite(sqlite, { schema });

  // Run migrations
  const migrationsFolder = path.join(process.cwd(), "db", "migrations", "sqlite");
  if (fs.existsSync(migrationsFolder)) {
    migrateSqlite(db, { migrationsFolder });
  }

  return db;
}

async function ensureDatabaseExists(connectionString: string): Promise<void> {
  // Extract target database name from connection string
  const url = new URL(connectionString);
  const targetDb = url.pathname.replace(/^\//, '');
  if (!targetDb || targetDb === 'postgres') return;

  // Connect to the default 'postgres' database to create the target DB
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    await adminPool.query(`CREATE DATABASE "${targetDb}"`);
    console.log(`[db] Created database: ${targetDb}`);
  } catch (err: any) {
    if (err.code !== '42P04') throw err; // 42P04 = duplicate_database, ignore it
  } finally {
    await adminPool.end();
  }
}

async function createPostgresDb(isTest: boolean): Promise<ReturnType<typeof drizzlePostgres<typeof schema>>> {
  let connectionString: string;

  if (isTest) {
    // For tests, use a test database
    connectionString = process.env.POSTGRES_TEST_CONNECTION_STRING ||
      process.env.POSTGRES_CONNECTION_STRING ||
      buildPostgresConnectionString() + "_test";
  } else {
    // Use connection string if provided, otherwise build from individual parameters
    connectionString = process.env.POSTGRES_CONNECTION_STRING || buildPostgresConnectionString();
  }

  await ensureDatabaseExists(connectionString);

  const pool = new Pool({
    connectionString,
  });

  const db = drizzlePostgres(pool, { schema });

  // Run migrations
  const migrationsFolder = path.join(process.cwd(), "db", "migrations", "postgres");
  if (fs.existsSync(migrationsFolder)) {
    await migratePostgres(db, { migrationsFolder });
  }

  return db;
}

function buildPostgresConnectionString(): string {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const database = process.env.POSTGRES_DATABASE || "fk_encore";

  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

let dbInstance: DbInstance | null = null;
let initializationPromise: Promise<DbInstance> | null = null;

/**
 * Initializes the database and runs migrations.
 * This can be called multiple times, but will only initialize once.
 */
export async function initializeDb(): Promise<DbInstance> {
  if (dbInstance) return dbInstance;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const db = await createDb();
      // Seed initial data (roles, admin user)
      await seed(db);
      dbInstance = db;
      return db;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

/**
 * The database instance. 
 * Note: When using this at top-level in other modules, ensure initializeDb() has been called 
 * or that the first access is awaited if it's used inside an async function.
 */
const db = await initializeDb();

export default db;
