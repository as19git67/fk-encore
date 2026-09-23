/**
 * Pictures from Wikimedia Commons, for a way (§4.7).
 *
 * OpenStreetMap holds no photographs; Commons holds millions, most of
 * them with the place they were taken. Two ways in, both without a key:
 *
 *   - **By item.** A summit or a castle with a Wikidata item usually has
 *     a chosen image (P18) — somebody picked it as *the* picture of that
 *     place, which makes it the best one there is.
 *   - **By place.** Commons' geosearch finds files taken near a point.
 *     That is where pictures of the way itself come from, when anybody
 *     took one.
 *
 * Every file carries its author and licence, and the app shows both:
 * free licences are free on condition of saying whose picture it is.
 *
 * **What leaves the house** is a handful of coordinates along a public
 * way and the ids of public places — never who asked, or when. The
 * pictures themselves the phone loads straight from Wikimedia.
 */

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
/** Wikimedia asks every client to say who it is. */
const USER_AGENT = "fk-encore/trip-planner (https://github.com/as19git67/fk-encore) Node.js";
const TIMEOUT_MS = 8_000;
/** Wide enough for a phone's strip at 3×, small enough to load quickly. */
export const THUMB_WIDTH = 640;
/** Smaller originals are icons, scans of stamps, crops. */
const MIN_ORIGINAL_WIDTH = 800;

export interface CommonsPhoto {
  /** "File:Name.jpg" — the key two answers are deduplicated on. */
  title: string;
  thumbUrl: string;
  thumbWidth: number;
  thumbHeight: number;
  /** The file's page on Commons, where the full picture and licence are. */
  pageUrl: string;
  /** Plain text, markup removed. Null when Commons does not say. */
  author: string | null;
  /** "CC BY-SA 4.0", "Public domain". */
  license: string | null;
}

export interface CommonsClient {
  /** The chosen image (P18) of each item that has one: QID → "File:…". */
  imagesOf(qids: readonly string[]): Promise<Map<string, string>>;
  /** What Commons knows about these files, usable ones only. */
  files(titles: readonly string[]): Promise<CommonsPhoto[]>;
  /** Pictures taken within `radiusM` of a point, usable ones only. */
  nearby(point: { lat: number; lon: number }, radiusM: number, limit: number): Promise<CommonsPhoto[]>;
}

/** Commons or Wikidata did not answer. The caller shows no pictures. */
export class CommonsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonsUnavailableError";
  }
}

export class HttpCommonsClient implements CommonsClient {
  async imagesOf(qids: readonly string[]): Promise<Map<string, string>> {
    const wanted = qids.filter((q) => /^Q\d+$/.test(q));
    const out = new Map<string, string>();
    if (wanted.length === 0) return out;
    const url = new URL(WIKIDATA_API);
    url.searchParams.set("action", "wbgetentities");
    url.searchParams.set("ids", wanted.slice(0, 50).join("|"));
    url.searchParams.set("props", "claims");
    url.searchParams.set("format", "json");
    const body = await getJson(url);
    return parseImageClaims(body);
  }

  async files(titles: readonly string[]): Promise<CommonsPhoto[]> {
    if (titles.length === 0) return [];
    const url = commonsQuery();
    url.searchParams.set("titles", titles.slice(0, 50).join("|"));
    return parseImageInfo(await getJson(url), titles);
  }

  async nearby(
    point: { lat: number; lon: number },
    radiusM: number,
    limit: number,
  ): Promise<CommonsPhoto[]> {
    const url = commonsQuery();
    url.searchParams.set("generator", "geosearch");
    url.searchParams.set("ggscoord", `${point.lat.toFixed(5)}|${point.lon.toFixed(5)}`);
    // Commons caps the radius at ten kilometres.
    url.searchParams.set("ggsradius", String(Math.min(Math.max(Math.round(radiusM), 10), 10_000)));
    url.searchParams.set("ggsnamespace", "6");
    url.searchParams.set("ggslimit", String(Math.min(Math.max(limit, 1), 50)));
    return parseImageInfo(await getJson(url));
  }
}

function commonsQuery(): URL {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", String(THUMB_WIDTH));
  url.searchParams.set("iiextmetadatafilter", "Artist|LicenseShortName");
  return url;
}

async function getJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CommonsUnavailableError(`${url.host} answered ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof CommonsUnavailableError) throw err;
    throw new CommonsUnavailableError(err instanceof Error ? err.message : "commons unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/** QID → "File:…" out of a `wbgetentities` answer's P18 claims. */
export function parseImageClaims(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entities = (body as { entities?: Record<string, unknown> } | null)?.entities ?? {};
  for (const [qid, entity] of Object.entries(entities)) {
    const claims = (entity as { claims?: Record<string, unknown[]> }).claims ?? {};
    const first = claims.P18?.[0] as
      | { mainsnak?: { datavalue?: { value?: unknown } } }
      | undefined;
    const value = first?.mainsnak?.datavalue?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      out.set(qid, `File:${value.trim()}`);
    }
  }
  return out;
}

interface ImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  descriptionurl?: string;
  width?: number;
  mime?: string;
  extmetadata?: Record<string, { value?: unknown } | undefined>;
}

/**
 * The usable files of a `prop=imageinfo` answer.
 *
 * Usable means a photograph: JPEG or WebP, and not tiny. PNG and SVG
 * on Commons are maps, diagrams, coats of arms and logos far more often
 * than pictures, and none of those shows what a walk looks like.
 *
 * Given `order`, the answer follows it — the API returns pages in its
 * own order, and the caller's (most striking subject first) is the one
 * that matters.
 */
export function parseImageInfo(body: unknown, order?: readonly string[]): CommonsPhoto[] {
  const pages = (body as { query?: { pages?: unknown[] } } | null)?.query?.pages ?? [];
  const photos: CommonsPhoto[] = [];
  for (const raw of pages) {
    const page = raw as { title?: string; imageinfo?: ImageInfo[] };
    const info = page.imageinfo?.[0];
    if (!page.title || !info?.thumburl || !info.descriptionurl) continue;
    if (info.mime !== "image/jpeg" && info.mime !== "image/webp") continue;
    if ((info.width ?? 0) < MIN_ORIGINAL_WIDTH) continue;
    photos.push({
      title: page.title,
      thumbUrl: info.thumburl,
      thumbWidth: info.thumbwidth ?? THUMB_WIDTH,
      thumbHeight: info.thumbheight ?? Math.round(THUMB_WIDTH * 0.75),
      pageUrl: info.descriptionurl,
      author: plainText(info.extmetadata?.Artist?.value),
      license: plainText(info.extmetadata?.LicenseShortName?.value),
    });
  }
  if (!order) return photos;
  // The API normalises titles (underscores to spaces), so compare them
  // the way it does.
  const norm = (t: string) => t.replace(/_/g, " ");
  const rank = new Map(order.map((t, i) => [norm(t), i]));
  return photos.sort((a, b) =>
    (rank.get(norm(a.title)) ?? order.length) - (rank.get(norm(b.title)) ?? order.length));
}

/**
 * Commons metadata is HTML ("<a href=…>Name</a>"). The app shows text,
 * so the markup goes and the common entities come back as characters.
 */
export function plainText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

let active: CommonsClient = new HttpCommonsClient();

export function getCommonsClient(): CommonsClient {
  return active;
}

export function setCommonsClient(client: CommonsClient): void {
  active = client;
}

export function resetCommonsClient(): void {
  active = new HttpCommonsClient();
}
