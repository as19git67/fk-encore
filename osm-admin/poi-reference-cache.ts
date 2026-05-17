/**
 * Cache layer for `poi_references` (Epic #383).
 *
 * Looks up metadata (label, German label, Commons image URL,
 * Wikipedia URL) for a list of Wikidata QIDs and persists rows on
 * first encounter. Subsequent calls are pure DB hits.
 *
 * The vector(768) embedding column stays NULL at this stage; it gets
 * populated by the upcoming embedder (Etappe 4c) once the embedding
 * service exposes a raw-DINOv2 endpoint. Until then the matcher will
 * skip rows whose `embedded_at` is null.
 */

import { inArray } from "drizzle-orm";
import dbDefault from "../db/database";
import { poiReferences } from "../db/schema";
import {
  commonsImageUrl,
  fetchGermanWikipediaUrl,
  fetchPoi,
  type ClientOptions,
} from "./wikidata-client";

export interface CachedPoi {
  qid: string;
  name: string;
  nameDe: string | null;
  wikipediaUrl: string | null;
  commonsImageUrl: string | null;
}

export interface EnsureDeps {
  db?: typeof dbDefault;
  wikidata?: ClientOptions;
}

/**
 * For each QID in `qids`, ensure a row exists in `poi_references`.
 * Newly-seen QIDs are looked up via Wikidata (label + P18 + dewiki
 * sitelink). Already-cached QIDs are returned untouched.
 */
export async function ensurePoiReferences(
  qids: string[],
  deps: EnsureDeps = {},
): Promise<CachedPoi[]> {
  const db = deps.db ?? dbDefault;
  const wiki = deps.wikidata ?? {};

  const unique = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
  if (unique.length === 0) return [];

  const existing = await db
    .select()
    .from(poiReferences)
    .where(inArray(poiReferences.qid, unique));
  const known = new Map(existing.map((r) => [r.qid, r]));

  const missing = unique.filter((q) => !known.has(q));
  for (const qid of missing) {
    const poi = await fetchPoi(qid, wiki);
    if (!poi) continue;
    const wikipediaUrl = await fetchGermanWikipediaUrl(qid, wiki);
    const imageUrl = poi.imageFilename ? commonsImageUrl(poi.imageFilename) : null;
    await db
      .insert(poiReferences)
      .values({
        qid: poi.qid,
        name: poi.name,
        name_de: poi.nameDe,
        wikipedia_url: wikipediaUrl,
        commons_image_url: imageUrl,
      })
      .onConflictDoNothing();
    // Add to in-memory map so the result list reflects the insert.
    known.set(poi.qid, {
      qid: poi.qid,
      name: poi.name,
      name_de: poi.nameDe,
      wikipedia_url: wikipediaUrl,
      commons_image_url: imageUrl,
      embedded_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  const out: CachedPoi[] = [];
  for (const qid of unique) {
    const row = known.get(qid);
    if (!row) continue;
    out.push({
      qid: row.qid,
      name: row.name,
      nameDe: row.name_de,
      wikipediaUrl: row.wikipedia_url,
      commonsImageUrl: row.commons_image_url,
    });
  }
  return out;
}
