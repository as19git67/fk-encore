/**
 * The prominence of a pool's places, cached per place (candidate
 * ranking plan, stage 1).
 *
 * Asked when a stay's pool is built, because that is when it matters:
 * the days are planned out of the pool in the same request, and a
 * ranking that arrived afterwards would re-sort a list whose best
 * entries were already chosen by the old tag sum. So the lookup runs
 * there, against a cache that answers most places from the last trip
 * to the same city, and within a time budget (`LOOKUP_BUDGET_MS`): what
 * Wikimedia has not answered by then is ranked the old way this once,
 * marked as waiting, and filled in by the background refill
 * (`refillSpotFame`, every 30 minutes) for the next build.
 */

import { inArray, isNull, lt, or, sql } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { tripSpotFame } from "../db/schema";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { getFameClient, type FameClient } from "./fame-client";
import { prominenceOf, type Prominence, type SpotFame } from "./prominence";
import { listingFor } from "./wikivoyage";

/** How long an answer holds. Page views drift slowly; a renamed category does not matter for a quarter. */
export const FAME_VALID_DAYS = 90;
/** How long a pool build waits for Wikimedia before ranking the rest the old way. */
export const LOOKUP_BUDGET_MS = 8_000;
/** Page-view requests in flight at once: one article per request. */
const PAGEVIEW_CONCURRENCY = 8;
/** Places one background tick looks up. */
const REFILL_BATCH = 120;

export type FameSpot = Pick<GeoPoiSearchSpot, "osmRef" | "name" | "lat" | "lon" | "wikidataQid" | "wikipedia">;

/**
 * The prominence of the places around a stay that could be a
 * candidate at all, relative to each other. Never fails a pool build:
 * without an answer the old tag sum ranks as it did.
 */
export async function prominenceAround(
  spots: readonly GeoPoiSearchSpot[],
  anchor: { lat: number; lon: number },
): Promise<Map<string, Prominence>> {
  try {
    return prominenceOf(await fameFor(spots.filter(worthLookingUp), anchor));
  } catch (err) {
    log.warn("trip spot fame: ranking without open data", { error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
}

/**
 * The places worth asking about: those with an item or an article, and
 * those mapped as a sight. A bakery with neither is not going to be a
 * candidate, and caching every one of them would fill the table with
 * nothing.
 */
export function worthLookingUp(spot: Pick<GeoPoiSearchSpot, "wikidataQid" | "wikipedia" | "kind">): boolean {
  return Boolean(spot.wikidataQid || spot.wikipedia || spot.kind?.startsWith("tourism="));
}

/**
 * Fame for every place that has an answer, fresh or just fetched. A
 * place missing from the map is ranked the old way.
 */
export async function fameFor(
  spots: readonly FameSpot[],
  anchor: { lat: number; lon: number },
  opts: { client?: FameClient; budgetMs?: number; now?: Date } = {},
): Promise<Map<string, SpotFame>> {
  const out = new Map<string, SpotFame>();
  if (spots.length === 0) return out;
  const now = opts.now ?? new Date();
  const rows = await db.select().from(tripSpotFame)
    .where(inArray(tripSpotFame.osm_ref, spots.map((s) => s.osmRef)));
  const byRef = new Map(rows.map((r) => [r.osm_ref, r]));
  const stale: FameSpot[] = [];
  for (const spot of spots) {
    const row = byRef.get(spot.osmRef);
    if (row && isFresh(row.fetched_at, now)) out.set(spot.osmRef, fameOfRow(row));
    else stale.push(spot);
  }
  if (stale.length === 0) return out;

  const deadline = Date.now() + (opts.budgetMs ?? LOOKUP_BUDGET_MS);
  const looked = await lookUp(stale, anchor, opts.client ?? getFameClient(), deadline);
  await store(stale, looked, now);
  for (const spot of stale) {
    const fresh = looked.get(spot.osmRef);
    // An old answer beats none: page views of last spring rank a
    // cathedral better than a tag that every chapel also has.
    const old = byRef.get(spot.osmRef);
    if (fresh) out.set(spot.osmRef, fresh);
    else if (old?.fetched_at) out.set(spot.osmRef, fameOfRow(old));
  }
  return out;
}

/**
 * The background half: places a pool build could not finish within its
 * budget, and answers older than `FAME_VALID_DAYS` that a pool still
 * asks for. Grouped by roughly ten-kilometre cells, so one Wikivoyage
 * article serves the places of one city.
 */
export async function refillSpotFame(opts: { client?: FameClient; now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - FAME_VALID_DAYS * 86_400_000).toISOString();
  const rows = await db.select().from(tripSpotFame)
    .where(or(isNull(tripSpotFame.fetched_at), lt(tripSpotFame.fetched_at, staleBefore)))
    .orderBy(tripSpotFame.requested_at)
    .limit(REFILL_BATCH);
  if (rows.length === 0) return 0;
  const cells = new Map<string, FameSpot[]>();
  for (const row of rows) {
    const key = `${Math.round(row.lat * 10)}:${Math.round(row.lon * 10)}`;
    const list = cells.get(key) ?? [];
    list.push({
      osmRef: row.osm_ref, name: row.name, lat: row.lat, lon: row.lon,
      wikidataQid: row.wikidata_qid, wikipedia: row.wikipedia,
    });
    cells.set(key, list);
  }
  let filled = 0;
  for (const spots of cells.values()) {
    const anchor = { lat: spots[0].lat, lon: spots[0].lon };
    const looked = await lookUp(spots, anchor, opts.client ?? getFameClient(), Number.POSITIVE_INFINITY);
    await store(spots, looked, now);
    filled += looked.size;
  }
  return filled;
}

function isFresh(fetchedAt: string | null, now: Date): boolean {
  if (!fetchedAt) return false;
  return now.getTime() - new Date(fetchedAt).getTime() < FAME_VALID_DAYS * 86_400_000;
}

function fameOfRow(row: typeof tripSpotFame.$inferSelect): SpotFame {
  return {
    pageviews: row.pageviews,
    languages: row.languages,
    commonsFiles: row.commons_files,
    wikivoyage: row.wikivoyage,
  };
}

interface Looked extends SpotFame {
  commonsCategory: string | null;
  wikivoyagePage: string | null;
}

/**
 * Ask the sources for these places, stopping at `deadline`. A place
 * counts as answered only when every source it has was asked: a place
 * with half its numbers would be ranked against complete ones as if
 * the missing half were zero.
 */
async function lookUp(
  spots: readonly FameSpot[],
  anchor: { lat: number; lon: number },
  client: FameClient,
  deadline: number,
): Promise<Map<string, Looked>> {
  const out = new Map<string, Looked>();
  const qids = spots.map((s) => s.wikidataQid).filter((q): q is string => Boolean(q));

  // Each source is a step, and a source that fails takes its step out
  // for this round rather than the whole lookup: Wikivoyage being down
  // is no reason to rank without page views.
  const [items, voyage] = await Promise.all([
    within(deadline, () => client.items(qids)),
    within(deadline, () => client.voyageListings(anchor)),
  ]);
  if (items === undefined || voyage === undefined) return out;

  const categories = [...items.values()].map((i) => i.commonsCategory).filter((c): c is string => Boolean(c));
  const sizes = categories.length > 0 ? await within(deadline, () => client.categorySizes(categories)) : new Map<string, number>();
  if (sizes === undefined) return out;

  const views = new Map<string, number | null>();
  const articles = spots.filter((s) => articleOf(s.wikipedia));
  let next = 0;
  const worker = async () => {
    while (next < articles.length && Date.now() < deadline) {
      const spot = articles[next];
      next += 1;
      const ref = articleOf(spot.wikipedia) as { lang: string; title: string };
      const answer = await within(deadline, () => client.pageviews(ref.lang, ref.title));
      if (answer !== undefined) views.set(spot.osmRef, answer);
    }
  };
  await Promise.all(Array.from({ length: PAGEVIEW_CONCURRENCY }, worker));

  for (const spot of spots) {
    if (articleOf(spot.wikipedia) && !views.has(spot.osmRef)) continue;
    const item = spot.wikidataQid ? items.get(spot.wikidataQid) : undefined;
    const listing = voyage ? listingFor({ name: spot.name, qid: spot.wikidataQid, lat: spot.lat, lon: spot.lon }, voyage.listings) : null;
    out.set(spot.osmRef, {
      pageviews: views.get(spot.osmRef) ?? null,
      languages: item?.languages ?? null,
      commonsFiles: item?.commonsCategory ? sizes.get(item.commonsCategory) ?? null : null,
      commonsCategory: item?.commonsCategory ?? null,
      // A listing without a description still says "a travel writer
      // names it"; the empty string is that, without inventing a line.
      wikivoyage: listing ? listing.description ?? "" : null,
      wikivoyagePage: listing && voyage ? voyage.page : null,
    });
  }
  return out;
}

/** The answer, or undefined when it failed or the deadline passed first. */
async function within<T>(deadline: number, ask: () => Promise<T>): Promise<T | undefined> {
  const left = deadline - Date.now();
  if (left <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ask(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left); }),
    ]);
  } catch (err) {
    log.warn("trip spot fame: a source did not answer", { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** "it:Duomo di Esempio" → { it, Duomo di Esempio }. */
export function articleOf(tag: string | null | undefined): { lang: string; title: string } | null {
  const match = /^([a-z]{2,3}(?:-[a-z0-9-]+)?):(.+)$/i.exec((tag ?? "").trim());
  if (!match || /^https?$/i.test(match[1])) return null;
  return { lang: match[1].toLowerCase(), title: match[2].trim() };
}

async function store(spots: readonly FameSpot[], looked: ReadonlyMap<string, Looked>, now: Date): Promise<void> {
  if (spots.length === 0) return;
  const at = now.toISOString();
  await db.insert(tripSpotFame).values(spots.map((spot) => {
    const fame = looked.get(spot.osmRef);
    return {
      osm_ref: spot.osmRef,
      name: spot.name,
      lat: spot.lat,
      lon: spot.lon,
      wikidata_qid: spot.wikidataQid,
      wikipedia: spot.wikipedia,
      pageviews: fame?.pageviews ?? null,
      languages: fame?.languages ?? null,
      commons_category: fame?.commonsCategory ?? null,
      commons_files: fame?.commonsFiles ?? null,
      wikivoyage: fame?.wikivoyage ?? null,
      wikivoyage_page: fame?.wikivoyagePage ?? null,
      fetched_at: fame ? at : null,
      requested_at: at,
    };
  })).onConflictDoUpdate({
    target: tripSpotFame.osm_ref,
    set: {
      name: sql`excluded.name`,
      lat: sql`excluded.lat`,
      lon: sql`excluded.lon`,
      wikidata_qid: sql`excluded.wikidata_qid`,
      wikipedia: sql`excluded.wikipedia`,
      // An answer that did not come this time leaves the last one in
      // place; only a fresh answer replaces the numbers.
      pageviews: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.pageviews} ELSE excluded.pageviews END`,
      languages: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.languages} ELSE excluded.languages END`,
      commons_category: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.commons_category} ELSE excluded.commons_category END`,
      commons_files: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.commons_files} ELSE excluded.commons_files END`,
      wikivoyage: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.wikivoyage} ELSE excluded.wikivoyage END`,
      wikivoyage_page: sql`CASE WHEN excluded.fetched_at IS NULL THEN ${tripSpotFame.wikivoyage_page} ELSE excluded.wikivoyage_page END`,
      fetched_at: sql`COALESCE(excluded.fetched_at, ${tripSpotFame.fetched_at})`,
      requested_at: sql`excluded.requested_at`,
    },
  });
}

