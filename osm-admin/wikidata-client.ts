/**
 * Wikidata SPARQL client for POI enrichment (Epic #383).
 *
 * Two access patterns:
 *
 *   - `nearbyPois(lat, lon, radiusKm)` — return all Wikidata items
 *     within the geo-circle, with their preferred labels and P18
 *     (image) filename. Used as the second-tier candidate source when
 *     OSM doesn't carry a `wikidata=` tag.
 *
 *   - `fetchPoi(qid)` — look up label, German label and P18 for a
 *     single QID. Used when OSM gives us a `wikidata` tag and we just
 *     want to populate the poi_references cache.
 *
 * Both go against the public SPARQL endpoint at
 * `https://query.wikidata.org/sparql`. We send a descriptive
 * User-Agent (Wikimedia requires one) and treat any error as a soft
 * fail — the caller falls back to OSM-only data so a Wikidata
 * outage doesn't break POI detection.
 */

const DEFAULT_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "fk-encore/POI (https://github.com/as19git67/fk-encore; epic 383) Node.js";

export interface WikidataPoi {
  /** Bare QID, e.g. "Q161819". */
  qid: string;
  /** English-or-fallback label, e.g. "Marienplatz". */
  name: string;
  /** German label when available, otherwise null. */
  nameDe: string | null;
  /**
   * Commons file path (e.g. "Marienplatz_Munich.jpg"). Not a URL —
   * use `commonsImageUrl()` to turn it into one. Null when the item
   * has no P18 (image).
   */
  imageFilename: string | null;
}

export interface ClientOptions {
  fetcher?: typeof fetch;
  endpoint?: string;
  /** Timeout in ms (default 30 000). */
  timeoutMs?: number;
}

/**
 * Find Wikidata items within `radiusKm` of `(lat, lon)`. Returns up
 * to `limit` items, ordered by Wikidata's internal scoring (which
 * roughly correlates with sitelink count, i.e. prominence).
 */
export async function nearbyPois(
  lat: number,
  lon: number,
  opts: ClientOptions & { radiusKm?: number; limit?: number } = {},
): Promise<WikidataPoi[]> {
  const radius = opts.radiusKm ?? 0.2;
  const limit = opts.limit ?? 25;
  // `?image` is OPTIONAL so items without P18 still appear; we filter
  // at the typescript layer if the caller wants pictures only.
  const sparql = `
    SELECT ?item ?itemLabel ?itemLabelDe ?image WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?loc .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radius}" .
      }
      OPTIONAL { ?item wdt:P18 ?image }
      OPTIONAL { ?item rdfs:label ?itemLabel   FILTER(LANG(?itemLabel)   = "en") }
      OPTIONAL { ?item rdfs:label ?itemLabelDe FILTER(LANG(?itemLabelDe) = "de") }
    }
    LIMIT ${limit}`.trim();
  const rows = await runSparql(sparql, opts);
  return rowsToPois(rows);
}

/**
 * Fetch label + P18 for a single Wikidata QID.
 */
export async function fetchPoi(
  qid: string,
  opts: ClientOptions = {},
): Promise<WikidataPoi | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const sparql = `
    SELECT ?item ?itemLabel ?itemLabelDe ?image WHERE {
      VALUES ?item { wd:${qid} }
      OPTIONAL { ?item wdt:P18 ?image }
      OPTIONAL { ?item rdfs:label ?itemLabel   FILTER(LANG(?itemLabel)   = "en") }
      OPTIONAL { ?item rdfs:label ?itemLabelDe FILTER(LANG(?itemLabelDe) = "de") }
    }
    LIMIT 1`.trim();
  const rows = await runSparql(sparql, opts);
  const list = rowsToPois(rows);
  return list[0] ?? null;
}

/**
 * Resolve a Commons filename (the bare value of P18) to a fetchable
 * URL pointing at the rendered image (`width` defaults to 800 px,
 * enough for a DINOv2 384²-input crop with margin).
 */
export function commonsImageUrl(filename: string, width = 800): string {
  // Wikidata stores filenames with leading "File:" stripped and using
  // underscores. Special:FilePath handles both forms.
  const trimmed = filename.replace(/^File:/, "").replace(/^http.*\//, "");
  const encoded = encodeURIComponent(trimmed);
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${width}`;
}

/**
 * Derive the German Wikipedia URL for a QID by following the
 * `sitelinks` REST endpoint — used by the admin UI to link out from a
 * POI match. Returns null when no German article exists.
 *
 * Implemented separately from the SPARQL path so the cache can fill
 * in incrementally without one slow query per row.
 */
export async function fetchGermanWikipediaUrl(
  qid: string,
  opts: ClientOptions = {},
): Promise<string | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const fetcher = opts.fetcher ?? fetch;
  const timeout = opts.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks/urls&sitefilter=dewiki&format=json`;
    const res = await fetcher(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      entities?: Record<string, { sitelinks?: { dewiki?: { url?: string } } }>;
    };
    return body.entities?.[qid]?.sitelinks?.dewiki?.url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── internals ────────────────────────────────────────────────────────

interface SparqlBinding {
  type: string;
  value: string;
}

interface SparqlRow {
  item?: SparqlBinding;
  itemLabel?: SparqlBinding;
  itemLabelDe?: SparqlBinding;
  image?: SparqlBinding;
}

async function runSparql(
  query: string,
  opts: ClientOptions,
): Promise<SparqlRow[]> {
  const fetcher = opts.fetcher ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_SPARQL_ENDPOINT;
  const timeout = opts.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = await res.json() as { results?: { bindings?: SparqlRow[] } };
    return body.results?.bindings ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function rowsToPois(rows: SparqlRow[]): WikidataPoi[] {
  const out: WikidataPoi[] = [];
  for (const r of rows) {
    if (!r.item) continue;
    const uri = r.item.value;
    const qid = uri.split("/").pop() ?? "";
    if (!/^Q\d+$/.test(qid)) continue;
    const imageUri = r.image?.value ?? null;
    out.push({
      qid,
      name: r.itemLabel?.value ?? r.itemLabelDe?.value ?? qid,
      nameDe: r.itemLabelDe?.value ?? null,
      imageFilename: imageUri ? decodeCommonsUri(imageUri) : null,
    });
  }
  return out;
}

/**
 * Wikidata returns P18 as an URI like
 * `http://commons.wikimedia.org/wiki/Special:FilePath/Marienplatz.jpg`.
 * Pull off the filename portion, URL-decoded.
 */
function decodeCommonsUri(uri: string): string {
  const last = uri.split("/").pop() ?? uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
