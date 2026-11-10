/**
 * The local model's order of a stay's highlights, in the background
 * (ideas plan, stage 2).
 *
 * The highlights are the best-known places around a stay, the list the
 * travellers pick their ideas from. They are not the trip: nothing in
 * them is planned and nothing is written to the pool. What is kept per
 * stay is only what the model was told and what it answered, so the
 * model is asked once per stay rather than once per look at the list.
 *
 * The request that shows the list (`highlights.ts`) writes what the
 * model is to be told and marks the stay as due; the curation timer
 * asks one stay at a time through the same prompt and gate as the
 * candidate order (`curation.ts`). Until it has answered, the list is
 * ordered by fame alone and says "wird noch sortiert".
 */

import { and, eq, sql } from "drizzle-orm";
import log from "encore.dev/log";
import dbDefault from "../db/database";
import { tripLegHighlights } from "../db/schema";
import {
  buildCurationPrompt,
  curationDue,
  gateCuration,
  MIN_CURATION_ENTRIES,
  type CuratedPick,
  type CurationContext,
  type CurationEntry,
  type CurationSignature,
} from "./curation";
import { askCurationModel, leadsFor } from "./highlights-model";
import { LlmServiceUnavailableError } from "./llm-client";
import { parseArticleUrl } from "./wikipedia-client";

type Db = typeof dbDefault;

export type HighlightsStatus = "pending" | "running" | "done" | "failed";

/** An entry as the request saw it, with the article for a lead if it has no text. */
export interface HighlightEntry extends CurationEntry {
  wikipediaUrl?: string | null;
}

const STALE_RUN_MINUTES = 30;
const MAX_ATTEMPTS = 3;
const STAYS_PER_TICK = 3;

export interface StoredHighlights {
  status: HighlightsStatus;
  picks: CuratedPick[] | null;
  signature: CurationSignature | null;
}

export async function storedHighlights(legId: number, db: Db = dbDefault): Promise<StoredHighlights | null> {
  const [row] = await db
    .select({ status: tripLegHighlights.status, picks: tripLegHighlights.picks, signature: tripLegHighlights.signature })
    .from(tripLegHighlights)
    .where(eq(tripLegHighlights.leg_id, legId));
  if (!row) return null;
  return {
    status: row.status as HighlightsStatus,
    picks: (row.picks as CuratedPick[] | null) ?? null,
    signature: (row.signature as CurationSignature | null) ?? null,
  };
}

/**
 * Ask for the order when there is none or the places changed by more
 * than a handful. Returns the status the list should show.
 */
export async function requestHighlightsOrder(
  legId: number,
  asked: { entries: HighlightEntry[]; context: CurationContext; signature: CurationSignature },
  stored: StoredHighlights | null,
  db: Db = dbDefault,
): Promise<HighlightsStatus | null> {
  if (asked.entries.length < MIN_CURATION_ENTRIES) return stored?.status ?? null;
  const running = stored?.status === "pending" || stored?.status === "running";
  if (running) return stored!.status;
  if (stored && !curationDue(stored.signature, asked.signature)) return stored.status;
  await db
    .insert(tripLegHighlights)
    .values({
      leg_id: legId,
      status: "pending",
      signature: asked.signature,
      entries: asked.entries,
      context: asked.context as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: tripLegHighlights.leg_id,
      set: {
        status: "pending",
        signature: asked.signature,
        entries: asked.entries,
        context: asked.context as unknown as Record<string, unknown>,
        requested_at: sql`now()`,
        attempts: 0,
        error: null,
      },
    });
  return "pending";
}

/** The timer: up to `STAYS_PER_TICK` stays, oldest request first. */
export async function tickHighlights(db: Db = dbDefault): Promise<number> {
  let done = 0;
  for (let i = 0; i < STAYS_PER_TICK; i += 1) {
    const legId = await claimNext(db);
    if (legId === null) break;
    const outcome = await runHighlights(legId, db);
    if (outcome === "unavailable") break;
    done += 1;
  }
  return done;
}

async function claimNext(db: Db): Promise<number | null> {
  const result = await db.execute(sql`
    UPDATE trip_leg_highlights
       SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE leg_id = (
       SELECT leg_id FROM trip_leg_highlights
        WHERE status = 'pending'
           OR (status = 'running' AND started_at < now() - make_interval(mins => ${STALE_RUN_MINUTES}))
           OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS}
               AND finished_at < now() - interval '1 hour')
        ORDER BY requested_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING leg_id`);
  const rows = (result as unknown as { rows?: Array<{ leg_id: number }> }).rows ?? [];
  return rows[0]?.leg_id ?? null;
}

export async function runHighlights(
  legId: number,
  db: Db = dbDefault,
): Promise<"done" | "failed" | "skipped" | "unavailable"> {
  try {
    const [row] = await db
      .select({ entries: tripLegHighlights.entries, context: tripLegHighlights.context })
      .from(tripLegHighlights)
      .where(eq(tripLegHighlights.leg_id, legId));
    const stored = ((row?.entries ?? []) as HighlightEntry[]);
    const context = row?.context as unknown as CurationContext | undefined;
    if (!context || stored.length < MIN_CURATION_ENTRIES) {
      await finish(legId, { status: "done", picks: null }, db);
      return "skipped";
    }
    const entries = await withLeads(stored);
    const signature = {
      refs: [...new Set(entries.map((e) => e.osmRef))].sort(),
      interests: [...new Set(context.interests)].sort(),
    };
    await db.update(tripLegHighlights).set({ signature }).where(eq(tripLegHighlights.leg_id, legId));

    const raw = await askCurationModel(buildCurationPrompt(entries, context));
    const gated = gateCuration(raw, entries, context);
    if (gated.picks.length === 0) {
      await finish(legId, { status: "failed", error: "the answer named no place of the list" }, db);
      return "failed";
    }
    await finish(legId, { status: "done", picks: gated.picks }, db);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmServiceUnavailableError) {
      await db.update(tripLegHighlights)
        .set({ status: "pending", attempts: sql`greatest(${tripLegHighlights.attempts} - 1, 0)`, error: message })
        .where(and(eq(tripLegHighlights.leg_id, legId), eq(tripLegHighlights.status, "running")));
      return "unavailable";
    }
    log.warn("trip highlights order failed", { legId, error: message });
    await finish(legId, { status: "failed", error: message }, db);
    return "failed";
  }
}

/** The Wikipedia intro for an entry the request had no text for. */
async function withLeads(entries: readonly HighlightEntry[]): Promise<CurationEntry[]> {
  const leads = await leadsFor(entries.filter((e) => !e.text).map((e) => e.wikipediaUrl ?? null));
  return entries.map(({ wikipediaUrl, ...entry }) => {
    if (entry.text || !wikipediaUrl) return entry;
    const article = parseArticleUrl(wikipediaUrl);
    return { ...entry, text: article ? leads.get(`${article.lang}:${article.title}`) ?? null : null };
  });
}

async function finish(
  legId: number,
  outcome: { status: "done" | "failed"; picks?: CuratedPick[] | null; error?: string },
  db: Db,
): Promise<void> {
  await db.update(tripLegHighlights)
    .set({
      status: outcome.status,
      finished_at: sql`now()`,
      error: outcome.error ?? null,
      ...(outcome.picks !== undefined ? { picks: outcome.picks } : {}),
    })
    .where(and(eq(tripLegHighlights.leg_id, legId), eq(tripLegHighlights.status, "running")));
}
