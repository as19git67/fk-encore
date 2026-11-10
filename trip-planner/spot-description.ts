/**
 * Text for a card where Wikipedia is thin (plan `kandidaten-ranking.md`,
 * stage 4).
 *
 * One description per place, always with its source said on screen:
 *
 *   1. the Wikivoyage listing line, which a travel guide wrote to say
 *      exactly this (CC BY-SA, with attribution);
 *   2. else the lead of the Wikipedia article;
 *   3. else the place's own website — the map's `website` tag —
 *      fetched with the guards of §9.3 (`page-fetch.ts`), summarised by
 *      the local model in two sentences, and kept only when the quote
 *      the model gives for it is really on the page and the summary
 *      names no number the page did not. The mechanism of
 *      `extract-places.ts`, for one place instead of an article's many.
 *      A failed check stores nothing.
 *
 * Kept per place in `trip_spot_fame`, like the picture, and looked for
 * in the background (`describeSpots`, every 30 minutes) for the places
 * that sit in a pool or on a day, or among highlights looked at lately. Never on a request path, and never a
 * search: a blog comes in the way §9.3 built, shared from the phone.
 */

import { and, inArray, isNull, lt, or, sql } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { tripPlanPool, tripPlanStops, tripSpotFame } from "../db/schema";
import { articleTextFromHtml, prepareArticleText, quoteAppearsIn } from "./article";
import { namesUnknownFact } from "./curation";
import { getFameClient } from "./fame-client";
import { askForJson, LlmServiceUnavailableError } from "./llm-client";
import { fetchSharedPage } from "./page-fetch";
import { articleOf } from "./spot-fame";
import { RECENT_DAYS } from "./spot-summary";

export type DescriptionSource = "wikivoyage" | "wikipedia" | "website";

export interface SpotDescription {
  text: string;
  source: DescriptionSource;
  /** Where it came from, for the attribution link. */
  url: string | null;
}

/** A lead shorter than this is a stub: the website gets asked instead. */
export const MIN_LEAD_CHARS = 60;
/** How much of a website the model reads. The top of a page says what the place is. */
export const MAX_SITE_CHARS = 6_000;
/** Looked for again after a quarter, found or not. */
const DESCRIBE_VALID_DAYS = 90;
/** Places per timer tick. */
const DESCRIBE_BATCH = 40;
/** Websites per tick: each is a fetch and a model call. */
const SITES_PER_TICK = 5;
const SUMMARY_CHARS = 400;

/** The order of the sources, for one place: first one that has something. */
export function chooseDescription(input: {
  wikivoyage: string | null;
  wikivoyagePage: string | null;
  lead: string | null;
  leadUrl: string | null;
}): SpotDescription | null {
  const voyage = input.wikivoyage?.trim();
  if (voyage) return { text: voyage, source: "wikivoyage", url: input.wikivoyagePage };
  const lead = input.lead?.trim();
  if (lead && lead.length >= MIN_LEAD_CHARS) return { text: lead, source: "wikipedia", url: input.leadUrl };
  return null;
}

export function buildSitePrompt(name: string | null, pageText: string): string {
  return [
    `Hier ist der Text der Website von ${name ? `„${name}“` : "einem Ort"}.`,
    "Sag in höchstens zwei Sätzen, was dieser Ort ist und warum man hingeht —",
    "nur mit dem, was im Text steht. Keine Öffnungszeiten, keine Preise.",
    "Gib dazu ein wörtliches Zitat aus dem Text, das deine Zusammenfassung trägt.",
    "",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Markdown:",
    '  { "summary": "…", "quote": "…" }',
    "",
    "Text:",
    pageText,
  ].join("\n");
}

/**
 * The model's summary of a website, or null when it does not hold.
 *
 * Kept only when its quote is on the page — a summary of a page the
 * model did not read cannot bring a sentence that is in it — and when
 * the summary names no number and no opening-hours or price word the
 * page did not.
 */
export function checkSiteSummary(raw: unknown, pageText: string): string | null {
  const record = raw as { summary?: unknown; quote?: unknown } | null;
  const summary = typeof record?.summary === "string" ? record.summary.replace(/\s+/g, " ").trim() : "";
  const quote = typeof record?.quote === "string" ? record.quote.trim() : "";
  if (!summary || !quote) return null;
  if (!quoteAppearsIn(quote, pageText)) return null;
  if (namesUnknownFact(summary, pageText)) return null;
  return summary.length <= SUMMARY_CHARS ? summary : `${summary.slice(0, SUMMARY_CHARS).trimEnd()} …`;
}

/** The descriptions of these places, for `loadPlan`. */
export async function descriptionsFor(osmRefs: readonly string[]): Promise<Map<string, SpotDescription>> {
  const out = new Map<string, SpotDescription>();
  if (osmRefs.length === 0) return out;
  const rows = await db
    .select({
      osmRef: tripSpotFame.osm_ref,
      wikivoyage: tripSpotFame.wikivoyage,
      wikivoyagePage: tripSpotFame.wikivoyage_page,
      description: tripSpotFame.description,
    })
    .from(tripSpotFame)
    .where(inArray(tripSpotFame.osm_ref, [...new Set(osmRefs)]));
  for (const row of rows) {
    // The travel guide's line is read straight from the lookup: no
    // second copy of it to drift.
    const voyage = chooseDescription({
      wikivoyage: row.wikivoyage, wikivoyagePage: row.wikivoyagePage, lead: null, leadUrl: null,
    });
    const found = voyage ?? (row.description as SpotDescription | null);
    if (found) out.set(row.osmRef, found);
  }
  return out;
}

/** What fetches a website and what summarises it; replaced in tests. */
export interface DescribeDeps {
  fetchPage: (url: string) => Promise<string>;
  ask: (prompt: string) => Promise<unknown>;
}

const defaultDeps: DescribeDeps = {
  fetchPage: async (url) => {
    const page = await fetchSharedPage(url);
    const type = page.contentType ?? "";
    if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`not a web page: ${type}`);
    return page.body;
  },
  ask: (prompt) => askForJson(prompt, 5 * 60_000, { maxTokens: 400 }),
};

/**
 * The background half: places in a pool or on a day that have no
 * description yet, or an old one. Wikivoyage needs nothing; Wikipedia
 * leads come in one request per twenty; websites one at a time, a few
 * per tick.
 */
export async function describeSpots(
  opts: { deps?: Partial<DescribeDeps>; now?: Date } = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...opts.deps };
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - DESCRIBE_VALID_DAYS * 86_400_000).toISOString();
  // A highlight looked at lately counts too: its row in the picker
  // shows the short sentence made from this description.
  const recent = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const inUse = sql`(${tripSpotFame.osm_ref} IN (SELECT ${tripPlanPool.osm_ref} FROM ${tripPlanPool})
    OR ${tripSpotFame.osm_ref} IN (SELECT ${tripPlanStops.osm_ref} FROM ${tripPlanStops})
    OR ${tripSpotFame.requested_at} > ${recent})`;
  const rows = await db.select().from(tripSpotFame)
    .where(and(
      // Wikivoyage already says it; a place not looked up yet waits for its lookup.
      or(isNull(tripSpotFame.wikivoyage), sql`${tripSpotFame.wikivoyage} = ''`),
      sql`${tripSpotFame.fetched_at} IS NOT NULL`,
      or(isNull(tripSpotFame.described_at), lt(tripSpotFame.described_at, staleBefore)),
      inUse,
    ))
    .orderBy(tripSpotFame.requested_at)
    .limit(DESCRIBE_BATCH);
  if (rows.length === 0) return 0;

  // Wikipedia leads, grouped by language edition.
  const byLang = new Map<string, Array<{ osmRef: string; title: string }>>();
  for (const row of rows) {
    const article = articleOf(row.wikipedia);
    if (!article) continue;
    byLang.set(article.lang, [...(byLang.get(article.lang) ?? []), { osmRef: row.osm_ref, title: article.title }]);
  }
  const leads = new Map<string, { text: string; url: string }>();
  for (const [lang, list] of byLang) {
    try {
      const answers = await getFameClient().leads(lang, list.map((entry) => entry.title));
      for (const entry of list) {
        const text = answers.get(entry.title);
        if (text) {
          leads.set(entry.osmRef, {
            text,
            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, "_"))}`,
          });
        }
      }
    } catch (err) {
      log.warn("trip spot description: no Wikipedia leads", { lang, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let described = 0;
  let sites = 0;
  for (const row of rows) {
    const lead = leads.get(row.osm_ref);
    let found = chooseDescription({
      wikivoyage: null, wikivoyagePage: null, lead: lead?.text ?? null, leadUrl: lead?.url ?? null,
    });
    if (!found && row.website && sites < SITES_PER_TICK) {
      sites += 1;
      try {
        found = await fromWebsite(row.name, row.website, deps);
      } catch (err) {
        if (err instanceof LlmServiceUnavailableError) break; // tried again next tick
        log.info("trip spot description: website not usable", {
          osmRef: row.osm_ref, error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!found && row.website) {
      continue; // its turn comes in a later tick
    }
    await db.update(tripSpotFame)
      .set({ description: found, described_at: now.toISOString() })
      .where(sql`${tripSpotFame.osm_ref} = ${row.osm_ref}`);
    if (found) described += 1;
  }
  return described;
}

async function fromWebsite(
  name: string | null,
  website: string,
  deps: DescribeDeps,
): Promise<SpotDescription | null> {
  const url = website.startsWith("http") ? website : `https://${website}`;
  const pageText = prepareArticleText(articleTextFromHtml(await deps.fetchPage(url)), MAX_SITE_CHARS);
  if (pageText.length < MIN_LEAD_CHARS) return null;
  const summary = checkSiteSummary(await deps.ask(buildSitePrompt(name, pageText)), pageText);
  return summary ? { text: summary, source: "website", url } : null;
}
