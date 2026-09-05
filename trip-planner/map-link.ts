/**
 * Reading a shared map link (§9.2, case 1).
 *
 * The clearest of the four ways in, because somewhere in the link there
 * is a coordinate. Getting it out is nonetheless **fragile**, and the
 * concept says so outright: the formats change without announcement.
 * That shapes the whole module.
 *
 *   - Nothing here throws on a link it does not understand. It answers
 *     what it found, which may be a coordinate, may be only a name, and
 *     may be nothing at all. The caller's fallback is a map asking the
 *     traveller to confirm the spot — not an error dialog.
 *   - A coordinate is only ever reported when it was *read*, never
 *     derived. A link carrying just a search term yields a `query` and
 *     no position, because "somewhere in Lisbon" is not a position
 *     (§15.3).
 *   - Short links (`maps.app.goo.gl`) carry nothing at all; they are
 *     reported as needing a redirect resolved, which is I/O and belongs
 *     to the caller.
 *
 * Everything is parsed with `URL` rather than by regex over the whole
 * string, so percent-encoding and parameter order are handled by
 * something that already knows the rules.
 */

export interface MapLink {
  /** Read from the link. Null when the link only names a place. */
  position: { lat: number; lon: number } | null;
  /** The place's name or the search term, when the link carries one. */
  name: string | null;
  /**
   * True for a shortened link, which holds nothing until its redirect
   * is followed. `position` and `name` are then both null.
   */
  needsRedirect: boolean;
  /** Which app's format was recognised — for the message, not for logic. */
  source: "apple" | "google" | "osm" | "geo" | "coordinates" | null;
}

/** Hosts whose links are shortened and say nothing until resolved. */
const SHORT_LINK_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "g.co",
]);

/**
 * Parse whatever was shared. Answers null only when the text holds
 * nothing that could be a place at all.
 */
export function parseMapLink(shared: string): MapLink | null {
  const text = shared.trim();
  if (text.length === 0) return null;

  const bare = parseBareCoordinates(text);
  if (bare) return { position: bare, name: null, needsRedirect: false, source: "coordinates" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol === "geo:") return parseGeoUri(url);

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (SHORT_LINK_HOSTS.has(host)) {
    return { position: null, name: null, needsRedirect: true, source: "google" };
  }
  if (host === "maps.apple.com" || url.protocol === "maps:") return parseAppleLink(url);
  if (isGoogleMaps(host, url.pathname)) return parseGoogleLink(url);
  if (host === "openstreetmap.org") return parseOsmLink(url);
  return null;
}

/**
 * Is this a Google *Maps* link, rather than merely a Google one?
 *
 * The distinction earns its keep: `docs.google.com/document/…` and
 * `google.com/search?q=…` both end in google.com, and reading either as
 * a pin would turn a shared document into a place named after its
 * title. Only `maps.google.com` and a `/maps` path are maps.
 */
function isGoogleMaps(host: string, pathname: string): boolean {
  if (host === "maps.google.com") return true;
  if (!host.endsWith("google.com")) return false;
  return pathname === "/maps" || pathname.startsWith("/maps/");
}

/**
 * Apple's parameters, in the order they are worth trusting.
 *
 * `ll` and `coordinate` are the place itself. `sll` deliberately is not:
 * it is the *search* location — where the map was looking when the
 * search ran — and a link with `q=Bäckerei&sll=…` would otherwise come
 * back pointing at the middle of the city rather than at a bakery.
 */
function parseAppleLink(url: URL): MapLink {
  const p = url.searchParams;
  const position = firstCoordinatePair(p.get("ll"), p.get("coordinate"), p.get("daddr"));
  const name = cleanName(p.get("name") ?? p.get("q") ?? p.get("address"));
  return { position, name, needsRedirect: false, source: "apple" };
}

/**
 * Google writes the same place three ways, so all three are read.
 *
 * The `@lat,lon,zoom` segment of a `/maps/place/…` path is the map's
 * centre rather than the pin, but on a place link the two coincide
 * closely enough to put a marker on a confirmation map — which is all
 * this is for. `!3d…!4d…` in the data segment is the pin proper and
 * wins where it is present.
 */
function parseGoogleLink(url: URL): MapLink {
  const p = url.searchParams;
  const path = decodeSafely(url.pathname);

  const pin = matchPair(path, /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const centre = matchPair(path, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  // `q=` may be a coordinate ("48.1,11.5", "loc:48.1,11.5") or a name.
  const queryParam = p.get("query") ?? p.get("q") ?? p.get("daddr");
  const fromQuery = queryParam ? parseBareCoordinates(queryParam.replace(/^loc:/i, "")) : null;

  const placeName = /\/maps\/place\/([^/@]+)/.exec(path)?.[1];
  const name = cleanName(placeName ?? (fromQuery ? null : queryParam));

  return {
    position: pin ?? fromQuery ?? centre,
    name,
    needsRedirect: false,
    source: "google",
  };
}

/** OpenStreetMap puts the marker in the query and the view in the fragment. */
function parseOsmLink(url: URL): MapLink {
  const p = url.searchParams;
  const marker = pair(p.get("mlat"), p.get("mlon"));
  const view = matchPair(url.hash, /#map=[\d.]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
  return { position: marker ?? view, name: null, needsRedirect: false, source: "osm" };
}

/** `geo:48.1,11.5?q=48.1,11.5(Name)` — RFC 5870 plus the Android custom. */
function parseGeoUri(url: URL): MapLink {
  // `new URL` leaves everything after "geo:" in `pathname`.
  const [coords, query] = url.pathname.split("?");
  const position = parseBareCoordinates(coords ?? "");
  const label = /\(([^)]+)\)/.exec(decodeSafely(query ?? url.search))?.[1];
  return { position, name: cleanName(label), needsRedirect: false, source: "geo" };
}

/**
 * "48.137, 11.575" — what you get from a screenshot's caption, or from
 * someone pasting coordinates straight into a chat.
 *
 * Strict on purpose: two numbers and nothing else. Loosening it to find
 * numbers *inside* a sentence would read "wir waren 4,5 Stunden dort"
 * as a place in the Atlantic.
 */
export function parseBareCoordinates(text: string): { lat: number; lon: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  return pair(match[1], match[2]);
}

function firstCoordinatePair(...values: (string | null)[]): { lat: number; lon: number } | null {
  for (const value of values) {
    if (!value) continue;
    const parsed = parseBareCoordinates(value);
    if (parsed) return parsed;
  }
  return null;
}

function matchPair(text: string, pattern: RegExp): { lat: number; lon: number } | null {
  const match = pattern.exec(text);
  return match ? pair(match[1], match[2]) : null;
}

/**
 * A pair of strings to a position, or null.
 *
 * The range check is the whole point: a link whose numbers are not a
 * latitude and a longitude has been misread, and answering null sends
 * the caller to its confirmation map instead of dropping a pin in the
 * wrong hemisphere.
 */
function pair(latText: string | null, lonText: string | null): { lat: number; lon: number } | null {
  if (latText === null || lonText === null) return null;
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Null Island is what a link says when its coordinates went missing,
  // far more often than it is where somebody stood.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/**
 * A name out of a URL segment: percent-decoded, `+` back to spaces, and
 * refused when it is really a coordinate or an id.
 */
function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const decoded = decodeSafely(raw).replace(/\+/g, " ").trim();
  if (decoded.length === 0) return null;
  if (parseBareCoordinates(decoded)) return null;
  // Google's place ids and Apple's auid values are identifiers, not
  // names — showing one to the traveller would be noise.
  if (/^(0x[0-9a-f]+|[A-Za-z0-9_-]{20,})$/i.test(decoded)) return null;
  return decoded;
}

function decodeSafely(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A malformed escape is not a reason to lose the rest of the name.
    return text;
  }
}
