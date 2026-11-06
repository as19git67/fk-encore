/**
 * Wikivoyage's listings, read out of a city article's wikitext
 * (candidate ranking plan, stage 1).
 *
 * Wikivoyage is a travel guide written by travellers, under CC BY-SA.
 * Its city articles list places as templates —
 * `{{vCard |name=… |type=cathedral |wikidata=Q… |lat=… |long=… |description=…}}`
 * on the German edition, `{{see |name=… |wikidata=… |content=…}}` on
 * the English one. The German `type` names the kind of place (museum,
 * church, hotel), not the group, so a German listing is a sight by the
 * section it stands in: "Sehenswürdigkeiten" or "Aktivitäten". A place listed there is a place a travel writer
 * thought worth a visit, and the one-line description is often the
 * best short text about it there is.
 *
 * Pure: wikitext in, listings out. What leaves the house is a
 * coordinate (the stay's anchor) and the title of a public article.
 */

import { haversineMeters } from "./travel";

export interface VoyageListing {
  name: string;
  qid: string | null;
  lat: number | null;
  lon: number | null;
  /** Markup removed, at most `MAX_LINE` characters. Null when the listing has none. */
  description: string | null;
}

/** Listing kinds that are sights rather than beds and meals. */
const SIGHT_TYPES = new Set(["see", "do"]);
/** Second-level sections whose listings are sights, in either edition. */
const SIGHT_SECTION = /^(sehenswürdigkeiten|aktivitäten|see|do)$/i;
const MAX_LINE = 300;
/** How close a listing without a Wikidata id has to be to a place of the same name. */
export const VOYAGE_MATCH_RADIUS_M = 150;

/**
 * Every sight listing in a page. Templates nest (a listing's
 * description can hold `{{Bpl|…}}` or a link), so this walks the
 * braces rather than trusting a regular expression to find the end.
 */
export function parseListings(wikitext: string): VoyageListing[] {
  const listings: VoyageListing[] = [];
  // Where each second-level section starts, to tell which one a
  // listing stands in.
  const sections = [...wikitext.matchAll(/^==([^=].*?)==\s*$/gm)]
    .map((m) => ({ at: m.index ?? 0, sight: SIGHT_SECTION.test(m[1].trim()) }));
  const inSightSection = (at: number) => {
    let sight = false;
    for (const section of sections) {
      if (section.at > at) break;
      sight = section.sight;
    }
    return sight;
  };
  let i = 0;
  while ((i = wikitext.indexOf("{{", i)) !== -1) {
    const end = closingBraces(wikitext, i);
    if (end === -1) break;
    const body = wikitext.slice(i + 2, end);
    const listing = asListing(body, inSightSection(i));
    if (listing) listings.push(listing);
    i = listing ? end + 2 : i + 2;
  }
  return listings;
}

function closingBraces(text: string, start: number): number {
  let depth = 0;
  for (let j = start; j < text.length - 1; j += 1) {
    if (text[j] === "{" && text[j + 1] === "{") { depth += 1; j += 1; continue; }
    if (text[j] === "}" && text[j + 1] === "}") {
      depth -= 1;
      if (depth === 0) return j;
      j += 1;
    }
  }
  return -1;
}

function asListing(body: string, inSightSection: boolean): VoyageListing | null {
  const parts = splitTopLevel(body);
  const template = parts[0]?.trim().toLocaleLowerCase("de") ?? "";
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields.set(part.slice(0, eq).trim().toLocaleLowerCase("de"), part.slice(eq + 1).trim());
  }
  if (template === "vcard" || template === "listing") {
    const type = (fields.get("type") ?? "").toLocaleLowerCase("de");
    if (!SIGHT_TYPES.has(type) && !inSightSection) return null;
  } else if (!SIGHT_TYPES.has(template)) {
    return null;
  }
  const name = cleanText(fields.get("name") ?? "");
  if (!name) return null;
  const qid = (fields.get("wikidata") ?? "").trim();
  return {
    name,
    qid: /^Q\d+$/.test(qid) ? qid : null,
    lat: numberOrNull(fields.get("lat")),
    lon: numberOrNull(fields.get("long") ?? fields.get("lon")),
    description: cleanText(fields.get("description") ?? fields.get("content") ?? "", MAX_LINE),
  };
}

/** Split on `|` that are not inside a nested template or link. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let j = 0; j < body.length; j += 1) {
    const two = body.slice(j, j + 2);
    if (two === "{{" || two === "[[") { depth += 1; current += two; j += 1; continue; }
    if ((two === "}}" || two === "]]") && depth > 0) { depth -= 1; current += two; j += 1; continue; }
    if (body[j] === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += body[j];
  }
  parts.push(current);
  return parts;
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** Links to their text, templates and markup out, at most `max` characters. */
export function cleanText(value: string, max?: number): string | null {
  const text = value
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (max === undefined || text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const stop = cut.lastIndexOf(". ");
  return stop > max / 2 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

/**
 * The listing that describes this place: the one with its Wikidata id,
 * else one with its name within `VOYAGE_MATCH_RADIUS_M`. A name alone
 * is not enough — every town has a Marktplatz.
 */
export function listingFor(
  place: { name: string | null; qid: string | null; lat: number; lon: number },
  listings: readonly VoyageListing[],
): VoyageListing | null {
  if (place.qid) {
    const byId = listings.find((l) => l.qid === place.qid);
    if (byId) return byId;
  }
  const wanted = normalName(place.name);
  if (!wanted) return null;
  return listings.find((l) =>
    normalName(l.name) === wanted
    && l.lat !== null && l.lon !== null
    && haversineMeters(place, { lat: l.lat, lon: l.lon }) <= VOYAGE_MATCH_RADIUS_M) ?? null;
}

function normalName(name: string | null): string {
  return (name ?? "").toLocaleLowerCase("de").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
