/**
 * Persistence for finds in the pool (§9.2).
 *
 * Small on purpose: the decisions — which leg, already there or not —
 * are in `finds.ts`, and the endpoint has already made them by the time
 * anything here runs.
 */

import { and, eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { tripPlanPool } from "../db/schema";

type Db = typeof dbDefault;

export interface StoredPoolEntry {
  id: number;
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  score: number;
  reasons: string[];
  origin: string;
  note: string | null;
  sourceUrl: string | null;
  addedBy: number | null;
  /** True when no OSM entry could be matched (§9.2, rule 5). */
  unmatched: boolean;
}

export interface AddPoolEntryInput {
  legId: number;
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  score: number;
  reasons: string[];
  origin: string;
  note: string | null;
  sourceUrl: string | null;
  addedBy: number;
  unmatched: boolean;
}

export async function addPoolEntry(
  input: AddPoolEntryInput,
  db: Db = dbDefault,
): Promise<StoredPoolEntry> {
  const [row] = await db
    .insert(tripPlanPool)
    .values({
      leg_id: input.legId,
      osm_ref: input.osmRef,
      name: input.name,
      lat: input.lat,
      lon: input.lon,
      category: input.category,
      dwell_minutes: input.dwellMinutes,
      score: input.score,
      reasons: input.reasons,
      origin: input.origin,
      note: input.note,
      source_url: input.sourceUrl,
      added_by: input.addedBy,
      unmatched: input.unmatched,
    })
    .returning();
  return toStoredPoolEntry(row);
}

export interface MergeIntoPoolEntryInput {
  legId: number;
  osmRef: string;
  note: string | null;
  sourceUrl: string | null;
  addedBy: number;
}

/**
 * Fold a find into the entry that is already in the pool (§9.2, rule 3).
 *
 * Note and source are **appended** rather than replaced: two people
 * finding the same café for different reasons is the case worth
 * handling well, and overwriting would lose the first reason. The
 * contributor is left as it was — whoever put it there first put it
 * there.
 *
 * Returns null when the reference is not in the pool. That is not
 * necessarily an error: it is also what happens when the place is
 * already planned into a day, and the caller says something better
 * about that than this function could.
 */
export async function mergeIntoPoolEntry(
  input: MergeIntoPoolEntryInput,
  db: Db = dbDefault,
): Promise<StoredPoolEntry | null> {
  const [existing] = await db
    .select()
    .from(tripPlanPool)
    .where(and(eq(tripPlanPool.leg_id, input.legId), eq(tripPlanPool.osm_ref, input.osmRef)))
    .limit(1);
  if (!existing) return null;

  const reasons = [...((existing.reasons ?? []) as string[])];
  if (input.note && !reasons.includes(input.note)) reasons.push(input.note);
  const sourceLine = input.sourceUrl ? `Quelle: ${input.sourceUrl}` : null;
  if (sourceLine && !reasons.includes(sourceLine)) reasons.push(sourceLine);

  const [row] = await db
    .update(tripPlanPool)
    .set({
      reasons,
      note: mergeText(existing.note, input.note),
      source_url: existing.source_url ?? input.sourceUrl,
      // A candidate the search produced becomes a find once a person
      // vouches for it: somebody wanted this one.
      origin: "manual",
      added_by: existing.added_by ?? input.addedBy,
    })
    .where(eq(tripPlanPool.id, existing.id))
    .returning();
  return toStoredPoolEntry(row);
}

/** Keep both notes, in the order they arrived. */
function mergeText(existing: string | null, incoming: string | null): string | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.includes(incoming)) return existing;
  return `${existing}\n${incoming}`;
}

function toStoredPoolEntry(row: typeof tripPlanPool.$inferSelect): StoredPoolEntry {
  return {
    id: row.id,
    osmRef: row.osm_ref,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    category: row.category,
    dwellMinutes: row.dwell_minutes,
    score: row.score,
    reasons: (row.reasons ?? []) as string[],
    origin: row.origin,
    note: row.note,
    sourceUrl: row.source_url,
    addedBy: row.added_by,
    unmatched: row.unmatched,
  };
}
