/**
 * Database adapter helpers that work with both SQLite (better-sqlite3, sync)
 * and PostgreSQL (node-postgres, async) drizzle instances.
 *
 * Usage:
 *   import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter'
 *
 *   const user = await dbFirst<User>(db.select().from(users).where(...))
 *   const all  = await dbAll<User>(db.select().from(users))
 *   await dbExec(db.insert(users).values(...))
 *   const row  = await dbInsertReturning<User>(db.insert(users).values(...).returning(...))
 */

const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres'

/** Returns the first row or undefined. Replaces .get() */
export async function dbFirst<T>(q: any): Promise<T | undefined> {
  if (isPg) return (await q)[0] as T | undefined
  return q.get() as T | undefined
}

/** Returns all rows. Replaces .all() */
export async function dbAll<T>(q: any): Promise<T[]> {
  if (isPg) return (await q) as T[]
  return q.all() as T[]
}

/** Executes a write query (insert/update/delete). Returns row count. Replaces .run() */
export async function dbExec(q: any): Promise<{ changes: number }> {
  if (isPg) {
    const result = await q
    return { changes: result?.rowCount ?? 0 }
  } else {
    const result = q.run()
    return { changes: result.changes }
  }
}

/** Executes an insert with .returning() and returns the first row. Replaces .returning(...).get() */
export async function dbInsertReturning<T>(q: any): Promise<T | undefined> {
  if (isPg) return (await q)[0] as T | undefined
  return q.get() as T | undefined
}
