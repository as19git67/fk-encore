/**
 * DB-backed loading of the household's sender → category rule overrides,
 * kept apart from the pure `sender-rules.ts` matcher so that module stays
 * DB-free. See migration 0141.
 *
 * A short TTL cache avoids a per-document query during classification.
 * Writes call `invalidateSenderRuleOverridesCache` for immediate effect in
 * the same process; other worker processes pick up the change within the TTL.
 */

import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documentSenderRuleOverrides } from "../db/schema";
import { asc } from "drizzle-orm";
import type { SenderRule } from "./sender-rules";

console.log("[boot] documents/sender-rule-overrides.ts: all imports resolved");

const TTL_MS = 30_000;
let cache: { at: number; data: SenderRule[] } | null = null;

export async function loadSenderRuleOverrides(): Promise<SenderRule[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const rows = await dbAll<{
    note: string | null;
    sender_pattern: string;
    require_any: string[] | null;
    exclude_any: string[] | null;
    category: string;
  }>(
    db
      .select({
        note: documentSenderRuleOverrides.note,
        sender_pattern: documentSenderRuleOverrides.sender_pattern,
        require_any: documentSenderRuleOverrides.require_any,
        exclude_any: documentSenderRuleOverrides.exclude_any,
        category: documentSenderRuleOverrides.category,
      })
      .from(documentSenderRuleOverrides)
      .orderBy(asc(documentSenderRuleOverrides.sort_order), asc(documentSenderRuleOverrides.id)),
  );

  const data: SenderRule[] = rows.map((r) => ({
    note: r.note ?? "",
    senders: [r.sender_pattern],
    requireAny: r.require_any ?? undefined,
    excludeAny: r.exclude_any ?? undefined,
    category: r.category,
  }));
  cache = { at: now, data };
  return data;
}

/** Drop the cache so the next `loadSenderRuleOverrides` re-reads the DB. */
export function invalidateSenderRuleOverridesCache(): void {
  cache = null;
}
