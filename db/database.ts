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

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  const migrationsFolder = path.join(process.cwd(), "db", "migrations", "postgres");
  if (fs.existsSync(migrationsFolder)) {
    await migrate(db, { migrationsFolder });
  }

  return db;
}

let dbInstance: DbInstance | null = null;
let initializationPromise: Promise<DbInstance> | null = null;

export async function initializeDb(): Promise<DbInstance> {
  if (dbInstance) return dbInstance;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const db = await createDb();
      await seed(db);
      dbInstance = db;
      return db;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

const db = await initializeDb();

export default db;
