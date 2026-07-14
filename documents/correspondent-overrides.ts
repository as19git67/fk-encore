/**
 * DB-backed loading of the household's correspondent overrides, kept apart
 * from the pure `correspondent.ts` resolver so that module stays DB-free.
 *
 * A short TTL cache avoids a per-document query during the "Dateinamen
 * aktualisieren" backfill (which relocates the whole corpus). Writes call
 * `invalidateCorrespondentOverridesCache` for immediate effect in the same
 * process; other worker processes pick up the change within the TTL.
 */

import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documentCorrespondentOverrides } from "../db/schema";
import type { CorrespondentOverride } from "./correspondent";

console.log("[boot] documents/correspondent-overrides.ts: all imports resolved");

const TTL_MS = 30_000;
let cache: { at: number; data: CorrespondentOverride[] } | null = null;

export async function loadCorrespondentOverrides(): Promise<CorrespondentOverride[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const rows = await dbAll<{
    sender_pattern: string;
    correspondent_slug: string;
    correspondent_display: string;
  }>(
    db
      .select({
        sender_pattern: documentCorrespondentOverrides.sender_pattern,
        correspondent_slug: documentCorrespondentOverrides.correspondent_slug,
        correspondent_display: documentCorrespondentOverrides.correspondent_display,
      })
      .from(documentCorrespondentOverrides),
  );

  const data: CorrespondentOverride[] = rows.map((r) => ({
    pattern: r.sender_pattern,
    slug: r.correspondent_slug,
    display: r.correspondent_display,
  }));
  cache = { at: now, data };
  return data;
}

/** Drop the cache so the next `loadCorrespondentOverrides` re-reads the DB. */
export function invalidateCorrespondentOverridesCache(): void {
  cache = null;
}
