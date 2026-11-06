/**
 * The open sources of a place's prominence (candidate ranking plan,
 * stage 1): Wikidata, the Wikimedia page view statistics, Commons and
 * Wikivoyage. None needs a key, all are cacheable, and none is a
 * rating service (§10.7): they count readers, editions, pictures and a
 * travel writer's listing, not opinions.
 *
 * **What leaves the house** is the id or title of a public place and,
 * for Wikivoyage, the stay's anchor as a coordinate — never who asked,
 * the group, or the trip.
 */

import { parseListings, type VoyageListing } from "./wikivoyage";
import { getCommonsClient, type CommonsPhoto } from "./commons-client";
import { monthlyAverage } from "./prominence";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";
/** Wikimedia asks every client to say who it is. */
const USER_AGENT = "fk-encore/trip-planner (https://github.com/as19git67/fk-encore) Node.js";
const TIMEOUT_MS = 6_000;

/** What Wikidata says about one item. */
export interface ItemFacts {
  /** Wikipedia editions with an article on it. */
  languages: number;
  /** Its Commons category (P373), without the "Category:" prefix. */
  commonsCategory: string | null;
  /** Its chosen image (P18), as "File:…". */
  image: string | null;
}

export interface FameClient {
  items(qids: readonly string[]): Promise<Map<string, ItemFacts>>;
  /** Monthly average over the last twelve full months, or null for no such article. */
  pageviews(lang: string, title: string): Promise<number | null>;
  /** Files per Commons category, for the categories that exist. */
  categorySizes(categories: readonly string[]): Promise<Map<string, number>>;
  /** The main picture of each article, as "File:…" by title (Wikipedia's `pageimages`). */
  pageImages(lang: string, titles: readonly string[]): Promise<Map<string, string>>;
  /** Thumbnail, author and licence of these files, photographs only (Commons). */
  photos(titles: readonly string[]): Promise<CommonsPhoto[]>;
  /** Photographs taken within `radiusM` of a point (Commons geosearch). */
  photosNear(point: { lat: number; lon: number }, radiusM: number): Promise<CommonsPhoto[]>;
  /** The sight listings of the Wikivoyage city article nearest to a point. */
  voyageListings(point: { lat: number; lon: number }): Promise<{ page: string; listings: VoyageListing[] } | null>;
}

export class FameUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FameUnavailableError";
  }
}

export class HttpFameClient implements FameClient {
  async items(qids: readonly string[]): Promise<Map<string, ItemFacts>> {
    const wanted = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
    const out = new Map<string, ItemFacts>();
    for (let i = 0; i < wanted.length; i += 50) {
      const url = new URL(WIKIDATA_API);
      url.searchParams.set("action", "wbgetentities");
      url.searchParams.set("ids", wanted.slice(i, i + 50).join("|"));
      url.searchParams.set("props", "sitelinks|claims");
      url.searchParams.set("format", "json");
      for (const [qid, facts] of parseItems(await getJson(url))) out.set(qid, facts);
    }
    return out;
  }

  async pageviews(lang: string, title: string): Promise<number | null> {
    const { start, end } = lastTwelveMonths(new Date());
    const article = encodeURIComponent(title.replace(/ /g, "_"));
    const url = new URL(`${PAGEVIEWS_API}/${lang}.wikipedia.org/all-access/user/${article}/monthly/${start}/${end}`);
    const body = await getJson(url, true);
    return body === null ? null : parsePageviews(body);
  }

  async categorySizes(categories: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const wanted = [...new Set(categories.filter((c) => c.trim().length > 0))];
    for (let i = 0; i < wanted.length; i += 50) {
      const url = new URL(COMMONS_API);
      url.searchParams.set("action", "query");
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
      url.searchParams.set("prop", "categoryinfo");
      url.searchParams.set("titles", wanted.slice(i, i + 50).map((c) => `Category:${c}`).join("|"));
      for (const [name, files] of parseCategorySizes(await getJson(url))) out.set(name, files);
    }
    return out;
  }

  async pageImages(lang: string, titles: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted = [...new Set(titles)];
    for (let i = 0; i < wanted.length; i += 50) {
      const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
      url.searchParams.set("prop", "pageimages");
      url.searchParams.set("piprop", "name");
      url.searchParams.set("titles", wanted.slice(i, i + 50).join("|"));
      for (const [title, file] of parsePageImages(await getJson(url))) out.set(title, file);
    }
    return out;
  }

  async photos(titles: readonly string[]): Promise<CommonsPhoto[]> {
    const out: CommonsPhoto[] = [];
    for (let i = 0; i < titles.length; i += 50) out.push(...await getCommonsClient().files(titles.slice(i, i + 50)));
    return out;
  }

  async photosNear(point: { lat: number; lon: number }, radiusM: number): Promise<CommonsPhoto[]> {
    return getCommonsClient().nearby(point, radiusM, 5);
  }

  async voyageListings(point: { lat: number; lon: number }) {
    // The German guide first, the English one where the German has no
    // article nearby: the card is read in German, and the English
    // edition is several times larger.
    for (const lang of ["de", "en"]) {
      const api = `https://${lang}.wikivoyage.org/w/api.php`;
      const search = new URL(api);
      search.searchParams.set("action", "query");
      search.searchParams.set("format", "json");
      search.searchParams.set("formatversion", "2");
      search.searchParams.set("list", "geosearch");
      search.searchParams.set("gscoord", `${point.lat.toFixed(5)}|${point.lon.toFixed(5)}`);
      search.searchParams.set("gsradius", "10000");
      search.searchParams.set("gslimit", "3");
      search.searchParams.set("gsnamespace", "0");
      const titles = parseGeosearchTitles(await getJson(search));
      for (const title of titles) {
        const page = new URL(api);
        page.searchParams.set("action", "query");
        page.searchParams.set("format", "json");
        page.searchParams.set("formatversion", "2");
        page.searchParams.set("prop", "revisions");
        page.searchParams.set("rvprop", "content");
        page.searchParams.set("rvslots", "main");
        page.searchParams.set("titles", title);
        const listings = parseListings(parseWikitext(await getJson(page)) ?? "");
        if (listings.length > 0) return { page: `https://${lang}.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, listings };
      }
    }
    return null;
  }
}

async function getJson(url: URL, notFoundIsNull = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (notFoundIsNull && response.status === 404) return null;
    if (!response.ok) throw new FameUnavailableError(`${url.host} answered ${response.status}`);
    return await response.json();
  } catch (err) {
    if (err instanceof FameUnavailableError) throw err;
    throw new FameUnavailableError(err instanceof Error ? err.message : "unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/** "20251101", "20261031" — the twelve full months before `now`. */
export function lastTwelveMonths(now: Date): { start: string; end: string } {
  const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const startMonth = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - 11, 1));
  const day = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { start: day(startMonth), end: day(endMonth) };
}

/** Sites that are not a Wikipedia although their key ends in "wiki". */
const NOT_A_WIKIPEDIA = new Set([
  "commonswiki", "wikidatawiki", "specieswiki", "metawiki", "mediawikiwiki",
  "sourceswiki", "outreachwiki", "incubatorwiki", "wikimaniawiki", "foundationwiki",
]);

export function parseItems(body: unknown): Map<string, ItemFacts> {
  const out = new Map<string, ItemFacts>();
  const entities = (body as { entities?: Record<string, unknown> } | null)?.entities ?? {};
  for (const [qid, raw] of Object.entries(entities)) {
    const entity = raw as { missing?: unknown; sitelinks?: Record<string, unknown>; claims?: Record<string, unknown[]> };
    if (entity.missing !== undefined) continue;
    const languages = Object.keys(entity.sitelinks ?? {})
      .filter((site) => /^[a-z_]+wiki$/.test(site) && !NOT_A_WIKIPEDIA.has(site)).length;
    out.set(qid, {
      languages,
      commonsCategory: claimString(entity.claims, "P373"),
      image: ((v) => (v ? `File:${v}` : null))(claimString(entity.claims, "P18")),
    });
  }
  return out;
}

function claimString(claims: Record<string, unknown[]> | undefined, property: string): string | null {
  const first = claims?.[property]?.[0] as { mainsnak?: { datavalue?: { value?: unknown } } } | undefined;
  const value = first?.mainsnak?.datavalue?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parsePageviews(body: unknown): number | null {
  const items = (body as { items?: Array<{ views?: unknown }> } | null)?.items ?? [];
  return monthlyAverage(items.map((i) => (typeof i.views === "number" ? i.views : 0)));
}

export function parseCategorySizes(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const pages = (body as { query?: { pages?: unknown[] } } | null)?.query?.pages ?? [];
  for (const raw of pages) {
    const page = raw as { title?: string; missing?: unknown; categoryinfo?: { files?: unknown } };
    if (!page.title || typeof page.categoryinfo?.files !== "number") continue;
    out.set(page.title.replace(/^Category:/, ""), page.categoryinfo.files);
  }
  return out;
}

/**
 * Title → "File:…" out of a `prop=pageimages` answer, keyed by the
 * title as it was *asked*: the API answers under the normalised title
 * ("Duomo_di_X" asked, "Duomo di X" answered) and says which was which.
 */
export function parsePageImages(body: unknown): Map<string, string> {
  const query = (body as { query?: { normalized?: Array<{ from?: string; to?: string }>; pages?: unknown[] } } | null)?.query;
  const asked = new Map<string, string>();
  for (const n of query?.normalized ?? []) if (n.from && n.to) asked.set(n.to, n.from);
  const out = new Map<string, string>();
  for (const raw of query?.pages ?? []) {
    const page = raw as { title?: string; pageimage?: unknown };
    if (!page.title || typeof page.pageimage !== "string" || !page.pageimage) continue;
    const file = `File:${page.pageimage.replace(/_/g, " ")}`;
    out.set(page.title, file);
    const original = asked.get(page.title);
    if (original) out.set(original, file);
  }
  return out;
}

export function parseGeosearchTitles(body: unknown): string[] {
  const hits = (body as { query?: { geosearch?: Array<{ title?: unknown }> } } | null)?.query?.geosearch ?? [];
  return hits.map((h) => h.title).filter((t): t is string => typeof t === "string");
}

export function parseWikitext(body: unknown): string | null {
  const pages = (body as { query?: { pages?: unknown[] } } | null)?.query?.pages ?? [];
  const page = pages[0] as { revisions?: Array<{ slots?: { main?: { content?: unknown } } }> } | undefined;
  const content = page?.revisions?.[0]?.slots?.main?.content;
  return typeof content === "string" ? content : null;
}

/** Answers nothing: what the test suite runs with unless a test sets its own. */
export class SilentFameClient implements FameClient {
  async items() { return new Map<string, ItemFacts>(); }
  async pageviews() { return null; }
  async categorySizes() { return new Map<string, number>(); }
  async pageImages() { return new Map<string, string>(); }
  async photos() { return []; }
  async photosNear() { return []; }
  async voyageListings() { return null; }
}

function defaultClient(): FameClient {
  // Off in the test suite (vitest.config.ts): a plan built in a test
  // must not reach Wikimedia.
  return process.env.TRIP_SPOT_FAME === "0" ? new SilentFameClient() : new HttpFameClient();
}

let active: FameClient = defaultClient();

export function getFameClient(): FameClient {
  return active;
}

export function setFameClient(client: FameClient): void {
  active = client;
}

export function resetFameClient(): void {
  active = defaultClient();
}
