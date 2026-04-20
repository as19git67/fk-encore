/**
 * Dedicated PostgreSQL connection pool for backup/restore operations.
 *
 * Kept separate from the main application pool (db/database.ts) because:
 *   - Backup operations run rarely but hold connections for a long time
 *     (pg_backup_start locks WAL until pg_backup_stop).
 *   - A separate pool makes it trivial to reason about which queries
 *     participate in the backup mode.
 *   - Avoids a circular import between backup/ and db/ (db/database.ts
 *     calls into backup/ at startup to run housekeeping).
 */

import { Pool } from "pg";

console.log("[boot] backup/pool.ts: all imports resolved");

function buildConnectionString(database?: string): string {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const db = database ?? process.env.POSTGRES_DATABASE ?? "fk_encore";
  return `postgres://${user}:${password}@${host}:${port}/${db}`;
}

export function getConnectionString(database?: string): string {
  if (!database && process.env.POSTGRES_CONNECTION_STRING) {
    return process.env.POSTGRES_CONNECTION_STRING;
  }
  return buildConnectionString(database);
}

let pool: Pool | null = null;

export function getBackupPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      // Small pool: backup operations are sequential by design.
      max: 2,
      // Cap connection acquisition so a stuck server can never deadlock the
      // boot-time defensive cleanup path (backup/startup.ts).
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closeBackupPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
