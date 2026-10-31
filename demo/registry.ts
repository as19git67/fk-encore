/**
 * The register of a demo run (documentation/plans/demodaten.md): every row
 * the generator writes is listed in `demo_item`, every file in `demo_file`,
 * so removing the demo takes back exactly that and nothing else.
 */

import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { demoFile, demoItem } from "../db/schema";

/** The tables a run registers rows of, in the order the remover deletes them. */
export const DEMO_TABLES = [
  "finance_account",
  "user_assessment_settings",
  "user_subject_persons",
  "users",
] as const;

export type DemoTable = (typeof DEMO_TABLES)[number];

export async function register(runId: number, table: DemoTable, ids: number[]): Promise<void> {
  if (!ids.length) return;
  // Chunked: a full run registers a few hundred rows at once at most, but
  // later stages (photos, documents) add more.
  for (let i = 0; i < ids.length; i += 500) {
    await db.insert(demoItem).values(ids.slice(i, i + 500).map((row_id) => ({ run_id: runId, table_name: table, row_id })));
  }
}

export async function registered(runId: number, table: DemoTable): Promise<number[]> {
  const rows = await db
    .select({ row_id: demoItem.row_id })
    .from(demoItem)
    .where(and(eq(demoItem.run_id, runId), eq(demoItem.table_name, table)));
  return rows.map((r) => r.row_id);
}

export async function registerFile(runId: number, path: string): Promise<void> {
  await db.insert(demoFile).values({ run_id: runId, path });
}
