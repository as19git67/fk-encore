/**
 * One short German sentence about a place, for the row in the spot
 * picker and the card on a day of the stay.
 *
 * Made from the description the place already has (`spot-description.ts`:
 * the Wikivoyage line, else the Wikipedia lead, else the summary of its
 * own website) and nothing else. A German text that is already short is
 * taken as it is; anything longer, or in another language, goes to the
 * local model, which says in one sentence what the place is. The model
 * only shortens and translates: a sentence that names a number, an hour
 * or a price the text did not is dropped (`namesUnknownFact`), and so is
 * one that is too long to sit under a name.
 *
 * Kept per place in `trip_spot_fame.summary` with a key of the text it
 * was made from, so a new description gets a new sentence and an old one
 * is never shown for it. A sentence that did not hold is kept as `null`
 * under the same key: the model is not asked again until the text changes.
 * Made in the background (`summariseSpots`, every ten minutes), never on
 * a request path.
 */

import { createHash } from "node:crypto";
import { and, inArray, or, sql } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { tripPlanPool, tripPlanStops, tripSpotFame } from "../db/schema";
import { namesUnknownFact } from "./curation";
import { askForJson, LlmServiceUnavailableError } from "./llm-client";
import type { SpotDescription } from "./spot-description";

/** Longest sentence that still sits under a name in two lines. */
export const SUMMARY_MAX_CHARS = 160;
/** Shorter than this says nothing. */
const SUMMARY_MIN_CHARS = 15;
/** Model calls per tick: each is a short answer, but the GPU has other work. */
const SUMMARIES_PER_TICK = 20;
/** A highlight someone looked at this recently gets its sentence too. */
export const RECENT_DAYS = 14;

interface StoredSummary {
  text: string | null;
  key: string;
}

/** The text a sentence is made from, and whether it is German already. */
export function summarySource(row: {
  wikivoyage: string | null;
  wikivoyagePage: string | null;
  description: SpotDescription | null;
}): { text: string; german: boolean } | null {
  const voyage = row.wikivoyage?.trim();
  if (voyage) return { text: voyage, german: isGermanSite(row.wikivoyagePage) };
  const described = row.description;
  if (!described?.text?.trim()) return null;
  // The website summary is the model's, asked in German.
  return { text: described.text.trim(), german: described.source === "website" || isGermanSite(described.url) };
}

function isGermanSite(url: string | null | undefined): boolean {
  return /^https?:\/\/de\.(m\.)?wiki(pedia|voyage)\.org\//.test(url ?? "");
}

export function summaryKey(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** A German text short enough is its own summary. */
export function takenAsIs(source: { text: string; german: boolean }): string | null {
  const text = source.text.replace(/\s+/g, " ").trim();
  return source.german && text.length <= SUMMARY_MAX_CHARS ? text : null;
}

export function buildSummaryPrompt(name: string | null, text: string): string {
  return [
    `Hier ist ein Text über ${name ? `„${name}“` : "einen Ort"}.`,
    "Sag in einem kurzen deutschen Satz (höchstens 140 Zeichen), was dieser Ort ist",
    "und was ihn ausmacht — nur mit dem, was im Text steht.",
    "Keine Öffnungszeiten, keine Preise, keine Zahlen, die nicht im Text stehen.",
    "Beginne nicht mit dem Namen des Orts.",
    "",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Markdown:",
    '  { "summary": "…" }',
    "",
    "Text:",
    text,
  ].join("\n");
}

/** The model's sentence, or null when it does not hold. */
export function checkSummary(raw: unknown, source: string): string | null {
  const record = raw as { summary?: unknown } | null;
  const summary = typeof record?.summary === "string" ? record.summary.replace(/\s+/g, " ").trim() : "";
  if (summary.length < SUMMARY_MIN_CHARS || summary.length > SUMMARY_MAX_CHARS) return null;
  if (namesUnknownFact(summary, source)) return null;
  return summary;
}

/** The sentences of these places, for `loadPlan` and the highlights. */
export async function summariesFor(osmRefs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (osmRefs.length === 0) return out;
  const rows = await db
    .select({
      osmRef: tripSpotFame.osm_ref,
      wikivoyage: tripSpotFame.wikivoyage,
      wikivoyagePage: tripSpotFame.wikivoyage_page,
      description: tripSpotFame.description,
      summary: tripSpotFame.summary,
    })
    .from(tripSpotFame)
    .where(inArray(tripSpotFame.osm_ref, [...new Set(osmRefs)]));
  for (const row of rows) {
    const stored = row.summary as StoredSummary | null;
    if (!stored?.text) continue;
    const source = summarySource({
      wikivoyage: row.wikivoyage, wikivoyagePage: row.wikivoyagePage,
      description: row.description as SpotDescription | null,
    });
    // Made from another text than the one the place has now: not shown.
    if (source && stored.key === summaryKey(source.text)) out.set(row.osmRef, stored.text);
  }
  return out;
}

/**
 * The background half: places in a pool, on a day, or among highlights
 * looked at lately whose description has no sentence yet, or a sentence
 * of an older text.
 */
export async function summariseSpots(
  opts: { ask?: (prompt: string) => Promise<unknown>; now?: Date } = {},
): Promise<number> {
  const ask = opts.ask ?? ((prompt: string) => askForJson(prompt, 2 * 60_000, { maxTokens: 200 }));
  const now = opts.now ?? new Date();
  const recent = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const rows = await db
    .select({
      osmRef: tripSpotFame.osm_ref,
      name: tripSpotFame.name,
      wikivoyage: tripSpotFame.wikivoyage,
      wikivoyagePage: tripSpotFame.wikivoyage_page,
      description: tripSpotFame.description,
      summary: tripSpotFame.summary,
    })
    .from(tripSpotFame)
    .where(and(
      or(sql`coalesce(${tripSpotFame.wikivoyage}, '') <> ''`, sql`${tripSpotFame.description} IS NOT NULL`),
      or(
        sql`${tripSpotFame.osm_ref} IN (SELECT ${tripPlanPool.osm_ref} FROM ${tripPlanPool})`,
        sql`${tripSpotFame.osm_ref} IN (SELECT ${tripPlanStops.osm_ref} FROM ${tripPlanStops})`,
        sql`${tripSpotFame.requested_at} > ${recent}`,
      ),
    ))
    .orderBy(sql`${tripSpotFame.requested_at} DESC`);

  let made = 0;
  let asked = 0;
  for (const row of rows) {
    const source = summarySource({
      wikivoyage: row.wikivoyage, wikivoyagePage: row.wikivoyagePage,
      description: row.description as SpotDescription | null,
    });
    if (!source) continue;
    const key = summaryKey(source.text);
    if ((row.summary as StoredSummary | null)?.key === key) continue;

    let text = takenAsIs(source);
    if (text === null) {
      if (asked >= SUMMARIES_PER_TICK) break;
      asked += 1;
      try {
        text = checkSummary(await ask(buildSummaryPrompt(row.name, source.text)), source.text);
      } catch (err) {
        if (err instanceof LlmServiceUnavailableError) break; // tried again next tick
        log.info("trip spot summary: no sentence", {
          osmRef: row.osmRef, error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    const stored: StoredSummary = { text, key };
    await db.update(tripSpotFame).set({ summary: stored }).where(sql`${tripSpotFame.osm_ref} = ${row.osmRef}`);
    if (text) made += 1;
  }
  return made;
}
