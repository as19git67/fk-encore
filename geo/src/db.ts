/**
 * Postgres connection management.
 *
 * One pool per region database, lazily created and cached. The admin
 * pool (`postgres` database) is used for CREATE/DROP DATABASE and
 * lifecycle work in /import.
 */

import pg from "pg";

const HOST = process.env.GEO_DB_HOST ?? "geo-db";
const PORT = parseInt(process.env.GEO_DB_PORT ?? "5432", 10);
const USER = process.env.GEO_DB_USER ?? "postgres";
const PASSWORD = process.env.GEO_DB_PASSWORD ?? "postgres";
const ADMIN_DB = process.env.GEO_DB_ADMIN_DB ?? "postgres";

const pools = new Map<string, pg.Pool>();

export function poolFor(database: string): pg.Pool {
  let pool = pools.get(database);
  if (!pool) {
    pool = new pg.Pool({
      host: HOST,
      port: PORT,
      user: USER,
      password: PASSWORD,
      database,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => {
      console.error(`[geo] pool error db=${database}:`, err);
    });
    pools.set(database, pool);
  }
  return pool;
}

export function adminPool(): pg.Pool {
  return poolFor(ADMIN_DB);
}

export async function closeAllPools(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}

/**
 * Drop the cached pool for a database and end its connections — used
 * after DROP DATABASE so the pool doesn't keep handing out broken
 * clients.
 */
export async function dropPool(database: string): Promise<void> {
  const p = pools.get(database);
  if (!p) return;
  pools.delete(database);
  await p.end().catch(() => {});
}

export interface DbConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

export function connectionInfo(): DbConnectionInfo {
  return { host: HOST, port: PORT, user: USER, password: PASSWORD };
}
