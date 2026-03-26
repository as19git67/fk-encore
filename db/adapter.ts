/**
 * Database adapter helpers for PostgreSQL (node-postgres / drizzle).
 *
 * Usage:
 *   import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter'
 *
 *   const user = await dbFirst<User>(db.select().from(users).where(...))
 *   const all  = await dbAll<User>(db.select().from(users))
 *   await dbExec(db.insert(users).values(...))
 *   const row  = await dbInsertReturning<User>(db.insert(users).values(...).returning(...))
 */

/** Returns the first row or undefined. */
export async function dbFirst<T>(q: any): Promise<T | undefined> {
  return (await q)[0] as T | undefined;
}

/** Returns all rows. */
export async function dbAll<T>(q: any): Promise<T[]> {
  return (await q) as T[];
}

/** Executes a write query (insert/update/delete). Returns row count. */
export async function dbExec(q: any): Promise<{ changes: number }> {
  const result = await q;
  return { changes: result?.rowCount ?? 0 };
}

/** Executes an insert with .returning() and returns the first row. */
export async function dbInsertReturning<T>(q: any): Promise<T | undefined> {
  return (await q)[0] as T | undefined;
}
