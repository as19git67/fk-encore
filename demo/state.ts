/**
 * Whether the system is untouched (documentation/plans/demodaten.md): the
 * demo may only be loaded where nobody has put anything in yet, so it never
 * mixes with real data.
 *
 * "Untouched" is counted, not guessed from the boot: no photos, documents,
 * bookings, depot transactions, meter readings or trip plans, and no users
 * besides administrators and the system accounts (`…@system.local`: the AI
 * user, the benchmark account). What a demo run or the assistant's
 * synthetic benchmark wrote is registered and does not count — removing the
 * demo makes the system untouched again.
 */

import { desc, inArray, not, sql } from "drizzle-orm";
import db from "../db/database";
import { demoRun } from "../db/schema";

export interface ContentCounts {
  users: number;
  photos: number;
  documents: number;
  transactions: number;
  depot_transactions: number;
  meter_readings: number;
  trip_plans: number;
}

const SYSTEM_USERS = sql`(SELECT id FROM users WHERE email LIKE '%@system.local')`;
const demoRows = (table: string) => sql`(SELECT row_id FROM demo_item WHERE table_name = ${table})`;
const benchRows = (table: string) => sql`(SELECT row_id FROM assistant_benchmark_seed WHERE table_name = ${table})`;

/** What the system holds that someone put in, per kind. */
export async function contentCounts(): Promise<ContentCounts> {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM users u
         WHERE u.email NOT LIKE '%@system.local'
           AND u.id NOT IN ${demoRows("users")}
           AND NOT EXISTS (
             SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id AND r.name = 'Admin'
           )) AS users,
      (SELECT count(*) FROM photos
         WHERE user_id NOT IN ${SYSTEM_USERS} AND id NOT IN ${demoRows("photos")}) AS photos,
      (SELECT count(*) FROM documents
         WHERE user_id NOT IN ${SYSTEM_USERS} AND id NOT IN ${demoRows("documents")}
           AND id NOT IN ${benchRows("documents")}) AS documents,
      (SELECT count(*) FROM finance_transaction
         WHERE account_id NOT IN ${demoRows("finance_account")}
           AND account_id NOT IN ${benchRows("finance_account")}) AS transactions,
      (SELECT count(*) FROM finance_depot_transaction
         WHERE account_id NOT IN ${demoRows("finance_account")}) AS depot_transactions,
      (SELECT count(*) FROM meter_readings mr
         JOIN meter_devices d ON d.id = mr.device_id
         WHERE d.meter_id NOT IN ${demoRows("meters")}
           AND d.meter_id NOT IN ${benchRows("meters")}) AS meter_readings,
      (SELECT count(*) FROM trip_plans
         WHERE owner_id NOT IN ${SYSTEM_USERS} AND id NOT IN ${demoRows("trip_plans")}) AS trip_plans
  `);
  const row = (result as unknown as { rows: Array<Record<keyof ContentCounts, string | number>> }).rows[0];
  return {
    users: Number(row.users),
    photos: Number(row.photos),
    documents: Number(row.documents),
    transactions: Number(row.transactions),
    depot_transactions: Number(row.depot_transactions),
    meter_readings: Number(row.meter_readings),
    trip_plans: Number(row.trip_plans),
  };
}

export function isEmpty(counts: ContentCounts): boolean {
  return Object.values(counts).every((n) => n === 0);
}

/** True when nobody has put anything into the system yet. */
export async function isUntouched(): Promise<boolean> {
  return isEmpty(await contentCounts());
}

export type DemoRunRow = typeof demoRun.$inferSelect;

/** The newest run that has not been removed: the demo the system holds, or the one being loaded. */
export async function currentRun(): Promise<DemoRunRow | null> {
  const [row] = await db
    .select()
    .from(demoRun)
    .where(not(inArray(demoRun.status, ["removed"])))
    .orderBy(desc(demoRun.id))
    .limit(1);
  return row ?? null;
}
