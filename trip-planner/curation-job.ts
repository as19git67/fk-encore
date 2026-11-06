/**
 * Asking the local model for a stay's order, in the background (plan
 * `kandidaten-ranking.md`, stage 3).
 *
 * Never on a request path. A pool write marks the leg as due
 * (`markCurationDue`) when its places or the interests changed by more
 * than a handful; the timer (`tickCuration`, every five minutes) asks
 * the model one stay at a time, passes the answer through the gate in
 * `curation.ts`, keeps the order per leg and moves the pool rows into
 * it without re-planning a single day — voting does not re-plan
 * either (§6.1). The next re-plan builds the days out of the new
 * order, because `toCandidates` reads it (`curatedOfLeg`).
 *
 * On the CPU twin one stay takes minutes, which is why the app shows
 * "wird noch sortiert" while a leg is `pending` or `running` rather
 * than waiting for it.
 *
 * What goes to the model is the pool (names, categories, the open-data
 * reasons, a Wikivoyage line or the Wikipedia lead), the interests and
 * the group in the abstract. Never a traveller's name — the vote
 * reasons carry names and are left behind — never the lodging and
 * never a document (§11.5).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import log from "encore.dev/log";
import dbDefault from "../db/database";
import {
  tripLegCuration,
  tripPlanDays,
  tripPlanLegs,
  tripPlanPool,
  tripPlans,
  tripPlanTravellers,
  tripSpotFame,
} from "../db/schema";
import { curatedScore, MANUAL_REASON, type CuratedPlace } from "./candidates";
import {
  buildCurationPrompt,
  curationDue,
  gateCuration,
  groupLine,
  MAX_CURATION_ENTRIES,
  MIN_CURATION_ENTRIES,
  signatureOf,
  type CuratedPick,
  type CurationEntry,
  type CurationSignature,
} from "./curation";
import { getFameClient } from "./fame-client";
import { interestLabel } from "./interests";
import { askForJson, LlmServiceUnavailableError } from "./llm-client";
import { parseArticleUrl } from "./wikipedia-client";

type Db = typeof dbDefault;

export type CurationStatus = "pending" | "running" | "done" | "failed";

/** Minutes, not seconds: on the CPU twin a stay of sixty places takes a while. */
const CURATION_TIMEOUT_MS = 10 * 60_000;
/** A run that started this long ago and never finished is taken again. */
const STALE_RUN_MINUTES = 30;
/** A failed stay is tried again after an hour, at most this often. */
const MAX_ATTEMPTS = 3;
/** Stays per timer tick; the model works one at a time anyway. */
const STAYS_PER_TICK = 3;

/**
 * The open-data reasons the model may read. Everything else on a pool
 * row stays home: the vote reasons ("Herzenswunsch von …") carry a
 * person's name.
 */
const SHAREABLE_REASON = /Aufrufe im Monat|Artikel in \d+ Sprachen|Wikivoyage|Bilder auf Commons|Sehenswürdigkeit|Wikidata|Wikipedia-Artikel|^ihr wolltet:/;

export type CurationAsker = (prompt: string) => Promise<unknown>;

const defaultAsker: CurationAsker = (prompt) =>
  askForJson(prompt, CURATION_TIMEOUT_MS, { maxTokens: 4096 });
let asker: CurationAsker = defaultAsker;

/** For tests: answer instead of the model. */
export function setCurationAsker(next: CurationAsker): void {
  asker = next;
}

export function resetCurationAsker(): void {
  asker = defaultAsker;
}

/**
 * Mark the leg as due when its pool or interests changed enough.
 * Cheap — two reads and at most one write — so every pool write calls it.
 */
export async function markCurationDue(legId: number, db: Db = dbDefault): Promise<boolean> {
  const current = await signatureNow(legId, db);
  if (!current) return false;
  const [stored] = await db
    .select({ signature: tripLegCuration.signature, status: tripLegCuration.status })
    .from(tripLegCuration)
    .where(eq(tripLegCuration.leg_id, legId));
  if (stored?.status === "pending") return false;
  if (!curationDue((stored?.signature as CurationSignature | null) ?? null, current)) return false;
  await db
    .insert(tripLegCuration)
    .values({ leg_id: legId, status: "pending" })
    .onConflictDoUpdate({
      target: tripLegCuration.leg_id,
      set: { status: "pending", requested_at: sql`now()`, attempts: 0, error: null },
    });
  return true;
}

/** The model's order of this leg, for `toCandidates` on a re-plan. */
export async function curatedOfLeg(legId: number, db: Db = dbDefault): Promise<Map<string, CuratedPlace>> {
  const [row] = await db
    .select({ picks: tripLegCuration.picks })
    .from(tripLegCuration)
    .where(eq(tripLegCuration.leg_id, legId));
  return placesOf((row?.picks as CuratedPick[] | null) ?? []);
}

/** Where each leg's order stands, for the app's "wird noch sortiert". */
export async function curationStatusOf(
  legIds: readonly number[],
  db: Db = dbDefault,
): Promise<Map<number, CurationStatus>> {
  const out = new Map<number, CurationStatus>();
  if (legIds.length === 0) return out;
  const rows = await db
    .select({ legId: tripLegCuration.leg_id, status: tripLegCuration.status })
    .from(tripLegCuration)
    .where(inArray(tripLegCuration.leg_id, [...legIds]));
  for (const row of rows) out.set(row.legId, row.status as CurationStatus);
  return out;
}

/** The timer: up to `STAYS_PER_TICK` stays, oldest request first. */
export async function tickCuration(db: Db = dbDefault): Promise<number> {
  let done = 0;
  for (let i = 0; i < STAYS_PER_TICK; i += 1) {
    const legId = await claimNext(db);
    if (legId === null) break;
    const outcome = await runCuration(legId, db);
    if (outcome === "unavailable") break;
    done += 1;
  }
  return done;
}

async function claimNext(db: Db): Promise<number | null> {
  const result = await db.execute(sql`
    UPDATE trip_leg_curation
       SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE leg_id = (
       SELECT leg_id FROM trip_leg_curation
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

/**
 * Ask for one leg's order and apply it. The leg must be claimed
 * (`running`); a leg marked due again meanwhile stays `pending` and is
 * asked once more with the newer pool.
 */
export async function runCuration(
  legId: number,
  db: Db = dbDefault,
): Promise<"done" | "failed" | "skipped" | "unavailable"> {
  try {
    const asked = await entriesOf(legId, db);
    if (!asked || asked.entries.length < MIN_CURATION_ENTRIES) {
      await finish(legId, { status: "done", picks: null, signature: asked?.signature ?? null }, db);
      return "skipped";
    }
    // The signature of what was asked, written first: a pool write
    // during the run compares against this and marks the leg again.
    await db.update(tripLegCuration)
      .set({ signature: asked.signature })
      .where(eq(tripLegCuration.leg_id, legId));

    const raw = await asker(buildCurationPrompt(asked.entries, asked.context));
    const gated = gateCuration(raw, asked.entries, asked.context);
    if (gated.picks.length === 0) {
      await finish(legId, { status: "failed", error: "the answer named no place of the pool" }, db);
      return "failed";
    }
    if (gated.invented > 0 || gated.replaced > 0) {
      log.info("trip curation: gate corrected the answer", {
        legId, invented: gated.invented, replaced: gated.replaced,
      });
    }
    await applyCuration(legId, gated.picks, db);
    await finish(legId, { status: "done", picks: gated.picks }, db);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmServiceUnavailableError) {
      // The model is away, not wrong: back in the queue, uncounted.
      await db.update(tripLegCuration)
        .set({ status: "pending", attempts: sql`greatest(${tripLegCuration.attempts} - 1, 0)`, error: message })
        .where(and(eq(tripLegCuration.leg_id, legId), eq(tripLegCuration.status, "running")));
      return "unavailable";
    }
    log.warn("trip curation failed", { legId, error: message });
    await finish(legId, { status: "failed", error: message }, db);
    return "failed";
  }
}

async function finish(
  legId: number,
  outcome: {
    status: "done" | "failed";
    picks?: CuratedPick[] | null;
    signature?: CurationSignature | null;
    error?: string;
  },
  db: Db,
): Promise<void> {
  await db.update(tripLegCuration)
    .set({
      status: outcome.status,
      finished_at: sql`now()`,
      error: outcome.error ?? null,
      ...(outcome.picks !== undefined ? { picks: outcome.picks } : {}),
      ...(outcome.signature !== undefined ? { signature: outcome.signature } : {}),
    })
    // Marked due again while it ran: leave it pending for the next tick.
    .where(and(eq(tripLegCuration.leg_id, legId), eq(tripLegCuration.status, "running")));
}

/**
 * Move the pool rows into the model's order, keeping the votes.
 *
 * A row's score is its base plus what the votes added at the last
 * re-plan; the base is the model's score where it ranked the place,
 * the scoring's otherwise. So the votes are `score − base`, and they
 * ride along unchanged. A manual entry keeps its score — the family's
 * word stands above the model's — and only gets the sentence.
 */
export async function applyCuration(
  legId: number,
  picks: readonly CuratedPick[],
  db: Db = dbDefault,
): Promise<void> {
  const places = placesOf(picks);
  const rows = await db
    .select({
      id: tripPlanPool.id,
      osmRef: tripPlanPool.osm_ref,
      origin: tripPlanPool.origin,
      score: tripPlanPool.score,
      reasons: tripPlanPool.reasons,
      searchScore: tripPlanPool.search_score,
      curatedScore: tripPlanPool.curated_score,
      curatedReason: tripPlanPool.curated_reason,
    })
    .from(tripPlanPool)
    .where(eq(tripPlanPool.leg_id, legId));

  for (const row of rows) {
    const place = places.get(row.osmRef);
    const reason = place?.reason ?? null;
    const reasons = ((row.reasons ?? []) as string[]).filter((r) => r !== row.curatedReason);
    if (reason) reasons.splice(reasons[0] === MANUAL_REASON ? 1 : 0, 0, reason);

    if (row.origin !== "search") {
      await db.update(tripPlanPool)
        .set({ reasons, curated_reason: reason })
        .where(eq(tripPlanPool.id, row.id));
      continue;
    }
    // Rows written before migration 0294 have no base on record: their
    // score is taken as the base, which is exact unless the votes had
    // moved them, and right again after the next re-plan.
    const search = row.searchScore ?? (row.curatedScore === null ? row.score : row.curatedScore);
    const votes = row.score - (row.curatedScore ?? search);
    const fromRank = place ? curatedScore(place.rank, place.of) : null;
    await db.update(tripPlanPool)
      .set({
        score: (fromRank ?? search) + votes,
        search_score: search,
        curated_score: fromRank,
        curated_reason: reason,
        reasons,
      })
      .where(eq(tripPlanPool.id, row.id));
  }
}

function placesOf(picks: readonly CuratedPick[]): Map<string, CuratedPlace> {
  const out = new Map<string, CuratedPlace>();
  picks.forEach((pick, rank) => out.set(pick.osmRef, { rank, of: picks.length, reason: pick.reason ?? null }));
  return out;
}

async function signatureNow(legId: number, db: Db): Promise<CurationSignature | null> {
  const [leg] = await db
    .select({ kind: tripPlanLegs.kind, constraints: tripPlans.constraints })
    .from(tripPlanLegs)
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(eq(tripPlanLegs.id, legId));
  if (!leg || leg.kind !== "stay") return null;
  const refs = await db
    .select({ osmRef: tripPlanPool.osm_ref })
    .from(tripPlanPool)
    .where(eq(tripPlanPool.leg_id, legId));
  return signatureOf(refs.map((r) => r.osmRef), interestsOf(leg.constraints));
}

function interestsOf(constraints: unknown): string[] {
  const value = (constraints as { interests?: unknown } | null)?.interests;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** What the model is told about one leg. */
async function entriesOf(legId: number, db: Db): Promise<{
  entries: CurationEntry[];
  context: Parameters<typeof buildCurationPrompt>[1];
  signature: CurationSignature;
} | null> {
  const [leg] = await db
    .select({
      kind: tripPlanLegs.kind,
      title: tripPlanLegs.title,
      planId: tripPlanLegs.plan_id,
      startDate: tripPlanLegs.start_date,
      constraints: tripPlans.constraints,
    })
    .from(tripPlanLegs)
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(eq(tripPlanLegs.id, legId));
  if (!leg || leg.kind !== "stay") return null;

  const rows = await db
    .select({
      osmRef: tripPlanPool.osm_ref,
      name: tripPlanPool.name,
      category: tripPlanPool.category,
      origin: tripPlanPool.origin,
      score: tripPlanPool.score,
      reasons: tripPlanPool.reasons,
      wikipediaUrl: tripPlanPool.wikipedia_url,
      wikivoyage: tripSpotFame.wikivoyage,
    })
    .from(tripPlanPool)
    .leftJoin(tripSpotFame, eq(tripSpotFame.osm_ref, tripPlanPool.osm_ref))
    .where(eq(tripPlanPool.leg_id, legId));
  const interests = interestsOf(leg.constraints);
  const signature = signatureOf(rows.map((r) => r.osmRef), interests);

  const chosen = [...rows]
    .sort((a, b) => b.score - a.score || a.osmRef.localeCompare(b.osmRef))
    .slice(0, MAX_CURATION_ENTRIES);
  const leads = await leadsFor(chosen.filter((r) => !r.wikivoyage).map((r) => r.wikipediaUrl));

  const entries: CurationEntry[] = chosen.map((row) => {
    const article = row.wikipediaUrl ? parseArticleUrl(row.wikipediaUrl) : null;
    return {
      osmRef: row.osmRef,
      name: row.name,
      category: row.category,
      reasons: ((row.reasons ?? []) as string[]).filter((r) => SHAREABLE_REASON.test(r)),
      text: row.wikivoyage || (article ? leads.get(`${article.lang}:${article.title}`) ?? null : null),
      manual: row.origin !== "search",
    };
  });

  const days = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tripPlanDays)
    .where(eq(tripPlanDays.leg_id, legId));
  const travellers = await db
    .select({ birth: tripPlanTravellers.birth_date })
    .from(tripPlanTravellers)
    .where(eq(tripPlanTravellers.plan_id, leg.planId));

  return {
    entries,
    signature,
    context: {
      town: leg.title,
      days: days[0]?.n ?? 1,
      interests: interests.map(interestLabel),
      group: groupLine(travellers.map((t) => t.birth), leg.startDate),
    },
  };
}

/** Wikipedia intros, keyed "lang:Title"; whatever does not answer is left out. */
async function leadsFor(urls: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const byLang = new Map<string, string[]>();
  for (const url of urls) {
    const article = url ? parseArticleUrl(url) : null;
    if (!article) continue;
    byLang.set(article.lang, [...(byLang.get(article.lang) ?? []), article.title]);
  }
  const out = new Map<string, string>();
  for (const [lang, titles] of byLang) {
    try {
      for (const [title, text] of await getFameClient().leads(lang, titles)) out.set(`${lang}:${title}`, text);
    } catch (err) {
      log.warn("trip curation: no Wikipedia intros", { lang, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
