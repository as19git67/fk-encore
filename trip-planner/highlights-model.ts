/**
 * The local model that orders a stay's highlights (ideas plan, stage 2;
 * `highlights-job.ts`): who answers, what of a place it may read, how
 * the stay is described to it, and the Wikipedia intros it reads where a
 * place has no text of its own.
 *
 * What goes to the model is the place (name, category, the open-data
 * reasons, a Wikivoyage line or the Wikipedia lead), the interests and
 * the group in the abstract. Never a traveller's name, never the lodging
 * and never a document (§11.5).
 *
 * The candidates' own order by the same model (ranking plan, stage 3)
 * is gone with the searched pool (reise-planen-und-unterwegs.md,
 * stage 7); the highlights are what is left of it.
 */

import { eq, sql } from "drizzle-orm";
import log from "encore.dev/log";
import dbDefault from "../db/database";
import { tripPlanDays, tripPlanLegs, tripPlans, tripPlanTravellers } from "../db/schema";
import { buildCurationPrompt, groupLine } from "./curation";
import { getFameClient } from "./fame-client";
import { interestLabel } from "./interests";
import { askForJson } from "./llm-client";
import { parseArticleUrl } from "./wikipedia-client";

type Db = typeof dbDefault;

/** Minutes, not seconds: on the CPU twin a stay of sixty places takes a while. */
const MODEL_TIMEOUT_MS = 10 * 60_000;

/**
 * The open-data reasons the model may read. Everything else on a pool
 * row stays home: the vote reasons ("Herzenswunsch von …") carry a
 * person's name.
 */
export const SHAREABLE_REASON = /Aufrufe im Monat|Artikel in \d+ Sprachen|Wikivoyage|Bilder auf Commons|Sehenswürdigkeit|Wikidata|Wikipedia-Artikel|^ihr wolltet:/;

export type CurationAsker = (prompt: string) => Promise<unknown>;

const defaultAsker: CurationAsker = (prompt) =>
  askForJson(prompt, MODEL_TIMEOUT_MS, { maxTokens: 4096 });
let asker: CurationAsker = defaultAsker;

/** The model, or whatever a test put in its place. */
export function askCurationModel(prompt: string): Promise<unknown> {
  return asker(prompt);
}

/** For tests: answer instead of the model. */
export function setCurationAsker(next: CurationAsker): void {
  asker = next;
}

export function resetCurationAsker(): void {
  asker = defaultAsker;
}

/**
 * The stay as the model hears of it: the town, how long, what the group
 * wants and who it is in the abstract — never a name.
 */
export async function curationContextOf(legId: number, db: Db = dbDefault): Promise<{
  context: Parameters<typeof buildCurationPrompt>[1];
  interests: string[];
} | null> {
  const [leg] = await db
    .select({
      title: tripPlanLegs.title,
      planId: tripPlanLegs.plan_id,
      startDate: tripPlanLegs.start_date,
      constraints: tripPlans.constraints,
    })
    .from(tripPlanLegs)
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(eq(tripPlanLegs.id, legId));
  if (!leg) return null;
  const interests = interestsOf(leg.constraints);
  return { context: await contextFor({ legId, ...leg, interests }, db), interests };
}

async function contextFor(
  leg: { legId: number; title: string | null; planId: number; startDate: string | null; interests: string[] },
  db: Db,
): Promise<Parameters<typeof buildCurationPrompt>[1]> {
  const days = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tripPlanDays)
    .where(eq(tripPlanDays.leg_id, leg.legId));
  const travellers = await db
    .select({ birth: tripPlanTravellers.birth_date })
    .from(tripPlanTravellers)
    .where(eq(tripPlanTravellers.plan_id, leg.planId));
  return {
    town: leg.title,
    days: days[0]?.n ?? 1,
    interests: leg.interests.map(interestLabel),
    group: groupLine(travellers.map((t) => t.birth), leg.startDate),
  };
}

/** Wikipedia intros, keyed "lang:Title"; whatever does not answer is left out. */
export async function leadsFor(urls: ReadonlyArray<string | null>): Promise<Map<string, string>> {
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
      log.warn("trip highlights: no Wikipedia intros", { lang, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

function interestsOf(constraints: unknown): string[] {
  const value = (constraints as { interests?: unknown } | null)?.interests;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
