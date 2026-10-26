/**
 * Photo read tools. The photo service checks `module.photos`, `photos.view`
 * and which photos the user may see (own, shared albums, group).
 */

import { feed, photo } from "~encore/clients";
import { bool, digestOf, int, isoDate, query, str, table } from "../format";
import type { ToolSpec } from "../types";
import { dateKey, groupProperties, groupRows, parseGrouping, parseRanking, rankNote, rankProperties, type RankField } from "./ranking";

const PHOTOS = ["module.photos", "photos.view"];

/** Photos counted per call; past this the answer says "more than". */
const PHOTO_COUNT_CAP = 2000;
/** Photos read to narrow a previous result; the most the endpoint returns. */
const NARROW_CAP = 5000;

/**
 * What a photo list is ranked by, in the words of the tool and of the photo
 * service (`sortBy` of GET /photos). A field the service computes
 * (favourites of every viewer, comments, the face) needs the service even
 * when the rows are an earlier result; the rest a row carries itself.
 */
const RANK_FIELDS = {
  taken_at: { description: "date taken", sortBy: "date", own: true },
  quality: { description: "quality score ('die besten')", sortBy: "quality", own: true },
  aesthetics: { description: "aesthetics score", sortBy: "aesthetics", own: true },
  person_face: { description: "how well the persons of person_ids show (needs person_ids)", sortBy: "face", own: false },
  favorites_count: { description: "favourites (Likes) of all users", sortBy: "favorites", own: false },
  comments_count: { description: "comments in shared albums", sortBy: "comments", own: false },
  file_size: { description: "file size", sortBy: "size", own: true },
} satisfies Record<string, RankField & { sortBy: string; own: boolean }>;
type PhotoRankField = keyof typeof RANK_FIELDS;

const GROUPS = {
  year: "taken",
  month: "taken, YYYY-MM",
  country: "of the place",
  city: "of the place",
} as const;
type PhotoGroup = keyof typeof GROUPS;

interface PhotoRow {
  id: number; taken_at?: string; created_at?: string; location_name?: string; location_city?: string; location_country?: string;
  filename?: string; original_name?: string; mime_type?: string; size?: number; latitude?: number; longitude?: number;
  ai_quality_score?: number; ai_quality_details?: Record<string, number>; description?: string; keywords?: string[];
  curation_status?: string; orientation?: string | null; rank_value?: number;
}

/** The value of a field a row carries itself, for ranking an earlier result without the service. */
function ownValue(p: PhotoRow, field: PhotoRankField): number | undefined {
  switch (field) {
    case "taken_at": {
      const t = Date.parse(p.taken_at ?? p.created_at ?? "");
      return Number.isFinite(t) ? t : undefined;
    }
    case "quality": return p.ai_quality_score;
    case "aesthetics": return p.ai_quality_details?.clip_aesthetics;
    case "file_size": return p.size;
    default: return p.rank_value;
  }
}

/** The ranked value as the table prints it: scores as percent, counts and bytes as they are. */
function rankCell(p: PhotoRow, field: PhotoRankField): number | string | undefined {
  const v = ownValue(p, field);
  if (field === "taken_at") return (p.taken_at ?? p.created_at ?? "").slice(0, 10);
  if (field === "quality" || field === "aesthetics") return percent(v);
  if (field === "person_face") return v === undefined ? undefined : Math.round(v * 10) / 10;
  return v;
}

function groupKey(p: PhotoRow, by: PhotoGroup): string | undefined {
  const date = p.taken_at ?? p.created_at;
  if (by === "year" || by === "month") return dateKey(date, by);
  return by === "country" ? p.location_country || undefined : p.location_city || undefined;
}
interface NaturalResult { photoId: number; filename?: string; taken_at?: string; created_at: string; location_city?: string; location_country?: string; score: number }
interface Recap { id: number; kind: string; title: string; subtitle: string | null; period_start: string | null; period_end: string | null; photo_count: number }
interface Album {
  id: number; user_id: number; name: string; event_name: string | null;
  oldest_photo_at: string | null; newest_photo_at: string | null; photo_count: number;
  /** Shared with at least one user, or reachable by a public link. */
  is_shared: boolean;
}
interface AlbumShare { user_id: number; user_name: string; access_level: string }
interface AlbumShares { shares: AlbumShare[]; publicLink?: { token?: string } | null }

/** How many albums one `list_album_shares` call looks up — one service call each. */
const SHARE_LOOKUP_CAP = 40;

function place(p: { location_city?: string; location_country?: string }): string | undefined {
  return [p.location_city, p.location_country].filter(Boolean).join(", ") || undefined;
}

function yearOf(date: string | null | undefined): number | undefined {
  return date ? Number(date.slice(0, 4)) : undefined;
}

const MEDIA_TYPES = ["photo", "video", "raw"] as const;
const ORIENTATIONS = ["portrait", "landscape", "square"] as const;

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const s = str(v);
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/** A score in [0, 1] as a whole percent; the tools speak 0–100. */
function percent(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : undefined;
}

/**
 * Hidden photos (Ausgeblendet) are what the user put out of sight: no photo
 * tool returns, counts or uses them unless the user asks for them in so many
 * words. The model says so with `hidden`; leaving it out excludes them.
 */
export type HiddenChoice = "exclude" | "include" | "only";
export const HIDDEN_PARAM = {
  type: "string",
  enum: ["include", "only"],
  description: "leave out: hidden (ausgeblendete) photos are left out. include = also hidden ones, only = just the hidden ones; only when the user explicitly asks for hidden photos",
} as const;

export function hiddenOf(v: unknown): HiddenChoice {
  const s = str(v);
  return s === "include" || s === "only" ? s : "exclude";
}

/** Whether a photo with this curation status belongs into a result under `hidden`. */
export function passesHidden(status: string | null | undefined, hidden: HiddenChoice): boolean {
  const isHidden = status === "hidden";
  return hidden === "include" || (hidden === "only" ? isHidden : !isHidden);
}

const HIDDEN_NOTE: Record<HiddenChoice, string> = {
  exclude: "hidden photos left out",
  include: "hidden photos included",
  only: "only hidden photos",
};

function excerpt(text: string | undefined, max = 60): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const listPhotos: ToolSpec = {
  name: "list_photos",
  kind: "read",
  summary: "Photos by metadata (favorite, dates, persons, place, description, keywords, text, sights, shape, type, GPS, quality), ranked by date, quality, aesthetics, a person's face, favourites of all users or comments (rank_by, direction), optionally the first of every year, month or place (group_by); or narrows the previous photo result.",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      favorite: { type: "boolean", description: "only when the user says Favoriten; 'die besten' is rank_by=quality" },
      date_from: { type: "string", description: "taken on or after, YYYY-MM-DD" },
      date_to: { type: "string", description: "taken on or before, YYYY-MM-DD" },
      person_ids: { type: "array", items: { type: "integer" }, description: "ids from list_persons" },
      place: { type: "string", description: "country, region or city, any language, e.g. 'Italien', 'Rom'" },
      has_description: { type: "boolean", description: "with (true) or without (false) a description" },
      text: { type: "string", description: "word in description, keywords, file name or text in the photo" },
      keyword: { type: "string", description: "Stichwort" },
      sight: { type: "string", description: "recognised sight, e.g. 'Eiffelturm'" },
      orientation: { type: "string", enum: [...ORIENTATIONS] },
      media_type: { type: "string", enum: [...MEDIA_TYPES] },
      has_gps: { type: "boolean" },
      quality_min: { type: "integer", description: "0–100" },
      ...rankProperties(RANK_FIELDS, "taken_at"),
      ...groupProperties(GROUPS),
      limit: { type: "integer", description: "at most 60 (default 15); with group_by: groups shown" },
      from_previous_result: { type: "boolean", description: "narrow the previous answer's photos" },
      hidden: HIDDEN_PARAM,
    },
  },
  async run(args, ctx) {
    const hidden = hiddenOf(args.hidden);
    const favorite = bool(args.favorite);
    const dateFrom = isoDate(args.date_from);
    const dateTo = isoDate(args.date_to);
    const personIds = Array.isArray(args.person_ids)
      ? args.person_ids.map((v) => int(v)).filter((v): v is number => v !== undefined)
      : [];
    const placeTerm = str(args.place);
    const hasDescription = bool(args.has_description);
    const text = str(args.text);
    const keyword = str(args.keyword);
    const sight = str(args.sight);
    const orientation = oneOf(args.orientation, ORIENTATIONS);
    const mediaType = oneOf(args.media_type, MEDIA_TYPES);
    const hasGps = bool(args.has_gps);
    const qualityMin = int(args.quality_min, { min: 0, max: 100 });
    const ranking = parseRanking(args, RANK_FIELDS, "taken_at");
    if (ranking.field === "person_face" && personIds.length === 0) throw new Error("rank_by person_face needs person_ids (ids from list_persons)");
    const grouping = parseGrouping(args, GROUPS);
    const oldest = ranking.direction === "asc";
    const limit = int(args.limit, { min: 1, max: 60 }) ?? 15;
    const fromPrevious = bool(args.from_previous_result) === true;
    const filter = {
      favorite: favorite || undefined,
      dateFrom,
      dateTo,
      personIds: personIds.length ? personIds.join(",") : undefined,
      personMode: personIds.length ? "include" : undefined,
      // The place is matched on the server, which knows its other names and
      // outline: filtering the newest 2000 here missed every older photo.
      locationText: placeTerm,
      hasDescription,
      text,
      keyword,
      sight,
      orientation,
      mediaTypes: mediaType,
      hasGps,
      qualityMin,
    };
    const serverFilter = Object.values(filter).some((v) => v !== undefined);

    const previous = fromPrevious ? ctx.previous?.("photo") : undefined;
    if (fromPrevious && !previous) throw new Error("there is no earlier photo result in this conversation");

    let rows: PhotoRow[];
    let capped = false;
    // A metric the service computes is read from the service even for an
    // earlier result: the rows of that result do not carry it.
    if (!previous || serverFilter || !RANK_FIELDS[ranking.field].own) {
      const res = await (photo.listPhotos({
        ...filter,
        hiddenMode: hidden,
        sortBy: RANK_FIELDS[ranking.field].sortBy,
        sortDir: ranking.direction,
        limit: (previous ? NARROW_CAP : PHOTO_COUNT_CAP) + 1,
      })) as unknown as { photos: PhotoRow[] };
      capped = res.photos.length > PHOTO_COUNT_CAP;
      rows = res.photos.slice(0, PHOTO_COUNT_CAP);
      if (previous) {
        const keep = new Set(previous);
        rows = rows.filter((p) => keep.has(p.id));
        capped = false;
      }
    } else {
      // The details endpoint returns every photo it is asked for, hidden or not.
      rows = (await loadPhotoRows(previous)).filter((p) => passesHidden(p.curation_status, hidden));
      // Ranked here: the rows carry the field. Unvalued rows last either way.
      const sign = oldest ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = ownValue(a, ranking.field);
        const bv = ownValue(b, ranking.field);
        if (av === undefined && bv === undefined) return 0;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        return sign * (av - bv);
      });
    }

    const count = rows.length;
    // Grouped: the rows become the first of every group; the count stays the
    // count of what matched, so "more than 2000" still says it was capped.
    const groups = grouping ? groupRows(rows, (p) => groupKey(p, grouping.by), grouping.perGroup) : undefined;
    const shownRows = groups ? groups.flatMap((g) => g.rows.map((p) => ({ ...p, group: g.key }))) : rows.map((p) => ({ ...p, group: undefined as string | undefined }));
    const rankColumn = ranking.field === "taken_at" ? [] : [ranking.field];
    const columns = [...(groups ? ["group"] : []), "id", "taken", ...rankColumn, "place", "description", "keywords", "quality"];
    const tableRows = shownRows.map((p) => [
      ...(groups ? [p.group] : []),
      p.id, (p.taken_at ?? p.created_at ?? "").slice(0, 10),
      ...(rankColumn.length ? [rankCell(p, ranking.field)] : []),
      place(p), excerpt(p.description),
      p.keywords?.length ? p.keywords.slice(0, 5).join(", ") : undefined, percent(p.ai_quality_score),
    ]);
    const rowCap = groups ? Math.min(shownRows.length, limit * grouping!.perGroup) : limit;
    const resultIds = shownRows.map((p) => p.id);
    const countText = capped ? `more than ${PHOTO_COUNT_CAP}` : String(count);
    // The gallery knows neither a place by name, the text filters, nor "the previous result".
    const galleryCanShow = !previous && !placeTerm && hasDescription === undefined && !text && !keyword && !sight && !orientation;
    // The gallery sorts by date, quality and aesthetics; a grouped result is no gallery page.
    const gallerySort = ranking.field === "quality" ? "ai_quality_score" : ranking.field === "aesthetics" ? "aesthetics" : ranking.field === "taken_at" ? undefined : null;
    const route = galleryCanShow && !groups && gallerySort !== null ? `/fotos/galerie${query({
      favorite: favorite ? "true" : undefined, dateFrom, dateTo, personIds: personIds.join(",") || undefined,
      mediaTypes: mediaType, hasGps: hasGps === undefined ? undefined : String(hasGps), qualityMin,
      sortBy: gallerySort, sortDir: gallerySort ? ranking.direction : undefined,
      hiddenMode: hidden === "exclude" ? undefined : hidden,
    })}` : undefined;
    return {
      text: table(
        columns,
        tableRows,
        {
          cap: rowCap,
          total: groups ? shownRows.length : count,
          note: `photo count: ${countText}, ${rankNote(ranking, grouping, groups?.length ?? 0)}, ${HIDDEN_NOTE[hidden]}${previous ? " (narrowed from the previous result)" : ""}. For everything known about a few photos call photo_details(ids).`,
        },
      ),
      digest: digestOf("list_photos", groups ? shownRows.length : count, resultIds),
      rowCount: groups ? shownRows.length : count,
      // Grouped, the result is the picks: a follow-up (an album) takes them, not everything that matched.
      ref: { type: "photo", ids: resultIds },
      block: {
        kind: "photos",
        tool: "list_photos",
        total: groups ? shownRows.length : count,
        // The filename is what a thumbnail URL is built from.
        rows: shownRows.slice(0, Math.max(rowCap, 12)).map((p) => ({ id: p.id, filename: p.filename ?? null, taken_at: p.taken_at ?? null })),
        route,
      },
    };
  },
};

/** Ids per call of the details endpoint, which takes them in the query string. */
const DETAILS_BATCH = 500;

async function loadPhotoRows(ids: number[]): Promise<PhotoRow[]> {
  const rows: PhotoRow[] = [];
  for (let i = 0; i < ids.length; i += DETAILS_BATCH) {
    const res = await (photo.getPhotoDetailsBatch({ ids: ids.slice(i, i + DETAILS_BATCH).join(",") })) as unknown as { photos: PhotoRow[] };
    rows.push(...res.photos);
  }
  return rows;
}

/** Photos one `photo_details` call describes — up to four service calls each. */
const DETAILS_CAP = 10;

interface FaceRow { person_id?: number; person_name?: string; ignored?: boolean }
interface PoiRow { name: string; nameDe: string | null; distanceM: number | null; ambiguous: boolean }
interface OcrRow { full_text: string }
interface CritiqueRow { summary: string; strengths: string[]; weaknesses: string[] }

/** One per-photo lookup; a missing right or a failing service leaves its field out. */
async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try { return await load(); } catch { return undefined; }
}

function shapeOf(p: PhotoRow): string | undefined {
  return p.orientation === "portrait" ? "Hochformat" : p.orientation === "landscape" ? "Querformat" : p.orientation === "square" ? "quadratisch" : undefined;
}

export const photoDetails: ToolSpec = {
  name: "photo_details",
  kind: "read",
  summary: `All metadata of up to ${DETAILS_CAP} photos: date, place, GPS, file, description, keywords, status, scores, persons, sights, text in the photo, critique.`,
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "integer" } },
      from_previous_result: { type: "boolean" },
    },
  },
  async run(args, ctx) {
    let ids = Array.isArray(args.ids) ? args.ids.map((v) => int(v)).filter((v): v is number => v !== undefined) : [];
    if (!ids.length && bool(args.from_previous_result)) ids = ctx.previous?.("photo") ?? [];
    if (!ids.length) throw new Error("ids are required");
    ids = [...new Set(ids)].slice(0, DETAILS_CAP);
    const rows = await loadPhotoRows(ids);
    const lines: string[] = [];
    for (const p of rows) {
      const [faces, pois, ocr, critique] = await Promise.all([
        optional(async () => ((await photo.getPhotoFaces({ id: p.id })) as unknown as { faces: FaceRow[] }).faces),
        optional(async () => ((await photo.getPhotoPoiMatches({ id: p.id })) as unknown as { matches: PoiRow[] }).matches),
        optional(async () => ((await photo.getPhotoOcr({ id: p.id })) as unknown as { ocr: OcrRow | null }).ocr),
        optional(async () => ((await photo.getPhotoCritique({ id: p.id })) as unknown as { critique: CritiqueRow | null }).critique),
      ]);
      const d = p.ai_quality_details ?? {};
      const persons = faces ? [...new Set(faces.filter((f) => !f.ignored && f.person_name).map((f) => f.person_name!))] : undefined;
      const unnamed = faces ? faces.filter((f) => !f.ignored && !f.person_name).length : 0;
      const fields: Array<[string, string | number | undefined]> = [
        ["taken", p.taken_at?.slice(0, 16).replace("T", " ")],
        ["imported", p.created_at?.slice(0, 10)],
        ["place", p.location_name || place(p)],
        ["gps", p.latitude != null && p.longitude != null ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}` : "none"],
        ["file", p.original_name],
        ["type", p.mime_type],
        ["size", p.size ? `${(p.size / 1_000_000).toFixed(1)} MB` : undefined],
        ["orientation", shapeOf(p)],
        ["status", p.curation_status],
        ["description", p.description?.trim() || "none"],
        ["keywords", p.keywords?.length ? p.keywords.join(", ") : "none"],
        ["quality", percent(p.ai_quality_score)],
        ["aesthetics", percent(d.clip_aesthetics)],
        ["composition", percent(d.clip_composition)],
        ["sharpness", percent(d.sharpness)],
        ["persons", persons ? [...persons, ...(unnamed ? [`${unnamed} unnamed face${unnamed === 1 ? "" : "s"}`] : [])].join(", ") || "none" : undefined],
        ["sights", pois ? pois.map((m) => `${m.nameDe ?? m.name}${m.distanceM != null ? ` (${Math.round(m.distanceM)} m)` : ""}${m.ambiguous ? " (unsure)" : ""}`).join(", ") || "none" : undefined],
        ["text in photo", ocr === undefined ? undefined : ocr === null ? "not scanned yet" : excerpt(ocr.full_text, 300) ?? "none"],
        ["critique", critique ? [critique.summary, ...critique.strengths.map((x) => `+ ${x}`), ...critique.weaknesses.map((x) => `− ${x}`)].join(" ") : undefined],
      ];
      lines.push(`Photo ${p.id}:\n${fields.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
    }
    const missing = ids.filter((id) => !rows.some((p) => p.id === id));
    if (missing.length) lines.push(`Not found or not visible: ${missing.join(", ")}`);
    lines.push("Scores are 0–100. Camera, lens and exposure settings are not stored.");
    return {
      text: lines.join("\n\n"),
      digest: digestOf("photo_details", rows.length, rows.map((p) => p.id)),
      rowCount: rows.length,
      ref: { type: "photo", ids: rows.map((p) => p.id) },
      block: {
        kind: "photos",
        tool: "photo_details",
        total: rows.length,
        rows: rows.map((p) => ({ id: p.id, filename: p.filename ?? null, taken_at: p.taken_at ?? null })),
      },
    };
  },
};

export const searchPhotos: ToolSpec = {
  name: "search_photos",
  kind: "read",
  refines: true,
  summary: "Search over what the image shows (German works), e.g. 'Strand'. Not for places: use list_photos(place).",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. 'Strand in Italien 2024'" },
      hidden: HIDDEN_PARAM,
    },
    required: ["query"],
  },
  async run(args) {
    const q = str(args.query);
    if (!q) throw new Error("query is required");
    const hidden = hiddenOf(args.hidden);
    const res = await (photo.searchPhotosNatural({ query: q, limit: 200, hiddenMode: hidden })) as unknown as { results: NaturalResult[] };
    const rows = res.results;
    return {
      text: table(
        ["id", "taken", "place", "score"],
        rows.map((r) => [r.photoId, (r.taken_at ?? r.created_at).slice(0, 10), place(r), r.score.toFixed(2)]),
        { cap: 15, total: rows.length, note: HIDDEN_NOTE[hidden] },
      ),
      digest: digestOf("search_photos", rows.length, rows.map((r) => r.photoId)),
      rowCount: rows.length,
      ref: { type: "photo", ids: rows.map((r) => r.photoId) },
      block: {
        kind: "photos",
        tool: "search_photos",
        total: rows.length,
        rows: rows.slice(0, 60).map((r) => ({ id: r.photoId, filename: r.filename ?? null, taken_at: r.taken_at ?? null })),
        route: `/fotos/galerie${query({ q, hiddenMode: hidden === "exclude" ? undefined : hidden })}`,
      },
    };
  },
};

export const listRecaps: ToolSpec = {
  name: "list_recaps",
  kind: "read",
  summary: "Photo recaps (Rückblicke) with period and photo count; kind 'trip' are journeys the photos show.",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["trip", "person", "place", "theme", "on_this_day", "recent_highlights", "scene_then_now"] },
      year: { type: "integer", description: "only recaps whose period touches this year" },
    },
  },
  async run(args) {
    const kind = str(args.kind);
    const year = int(args.year);
    const res = await (photo.listRecaps()) as unknown as { recaps: Recap[] };
    const rows = res.recaps.filter((r) => {
      if (kind && r.kind !== kind) return false;
      if (year !== undefined) {
        const from = yearOf(r.period_start);
        const to = yearOf(r.period_end) ?? from;
        if (from === undefined || to === undefined || year < from || year > to) return false;
      }
      return true;
    });
    return {
      text: table(
        ["id", "kind", "title", "from", "to", "photos"],
        rows.map((r) => [r.id, r.kind, r.subtitle ? `${r.title} — ${r.subtitle}` : r.title, r.period_start?.slice(0, 10), r.period_end?.slice(0, 10), r.photo_count]),
        { cap: 30 },
      ),
      digest: digestOf("list_recaps", rows.length, rows.map((r) => r.id)),
      rowCount: rows.length,
      block: {
        kind: "recaps",
        tool: "list_recaps",
        rows: rows.map((r) => ({
          id: r.id, kind: r.kind, title: r.title, period_start: r.period_start, period_end: r.period_end, photo_count: r.photo_count,
          route: `/fotos/rueckblicke?id=${r.id}`,
        })),
        route: "/fotos/rueckblicke",
      },
    };
  },
};

export const listAlbums: ToolSpec = {
  name: "list_albums",
  kind: "read",
  summary: "Photo albums with event name, photo period, count and whether they are shared; optionally only those with an event, in a year, or shared. For who an album is shared with use list_album_shares.",
  permissions: ["module.photos"],
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "only albums whose photos fall in this year" },
      has_event: { type: "boolean", description: "only albums with an event name (trips, parties)" },
      shared: { type: "boolean", description: "true: only albums shared with other users or by a public link; false: only unshared ones" },
      q: { type: "string", description: "text in name or event" },
      limit: { type: "integer", description: "rows to return, at most 100 (default 30)" },
    },
  },
  async run(args, ctx) {
    const year = int(args.year);
    const hasEvent = bool(args.has_event);
    const shared = bool(args.shared);
    const limit = int(args.limit, { min: 1, max: 100 }) ?? 30;
    const q = str(args.q)?.toLocaleLowerCase("de");
    const me = Number(ctx.user.userID);
    const res = await (photo.listAlbums()) as unknown as { albums: Album[] };
    const rows = res.albums.filter((a) => {
      if (hasEvent && !a.event_name) return false;
      if (shared !== undefined && Boolean(a.is_shared) !== shared) return false;
      if (q && !`${a.name} ${a.event_name ?? ""}`.toLocaleLowerCase("de").includes(q)) return false;
      if (year !== undefined) {
        const from = yearOf(a.oldest_photo_at);
        const to = yearOf(a.newest_photo_at) ?? from;
        if (from === undefined || to === undefined || year < from || year > to) return false;
      }
      return true;
    });
    const shown = rows.slice(0, limit);
    return {
      text: table(
        ["id", "name", "event", "from", "to", "photos", "shared", "owner"],
        shown.map((a) => [
          a.id, a.name, a.event_name, a.oldest_photo_at?.slice(0, 10), a.newest_photo_at?.slice(0, 10), a.photo_count,
          a.is_shared ? "yes" : "no", a.user_id === me ? "me" : "another user",
        ]),
        { total: rows.length, cap: limit },
      ),
      digest: digestOf("list_albums", rows.length, rows.map((a) => a.id)),
      rowCount: rows.length,
      block: {
        kind: "albums",
        tool: "list_albums",
        total: rows.length,
        rows: shown.map((a) => ({
          id: a.id, name: a.name, event_name: a.event_name, photo_count: a.photo_count, shared: Boolean(a.is_shared), route: `/fotos/alben/${a.id}`,
        })),
        route: `/fotos/alben${query({ q: str(args.q) })}`,
      },
    };
  },
};

export const listAlbumShares: ToolSpec = {
  name: "list_album_shares",
  kind: "read",
  summary: "Who the user's shared albums are shared with: the users (participants) by name and whether a public link exists — for every shared album the user owns, or one album by id.",
  permissions: ["module.photos"],
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      album_id: { type: "integer", description: "one album; default: every shared album the user owns" },
      q: { type: "string", description: "text in album name or event" },
      limit: { type: "integer", description: `albums to look up, at most ${SHARE_LOOKUP_CAP} (default ${SHARE_LOOKUP_CAP})` },
    },
  },
  async run(args, ctx) {
    const me = Number(ctx.user.userID);
    const albumId = int(args.album_id);
    const q = str(args.q)?.toLocaleLowerCase("de");
    const limit = int(args.limit, { min: 1, max: SHARE_LOOKUP_CAP }) ?? SHARE_LOOKUP_CAP;
    const res = await (photo.listAlbums()) as unknown as { albums: Album[] };
    const candidates = res.albums.filter((a) => {
      if (albumId !== undefined) return a.id === albumId;
      if (!a.is_shared) return false;
      if (q && !`${a.name} ${a.event_name ?? ""}`.toLocaleLowerCase("de").includes(q)) return false;
      return true;
    });
    // The share list is the owner's to see; an album shared *with* the user
    // is listed with its owner and no participants.
    const own = candidates.filter((a) => a.user_id === me);
    const foreign = candidates.filter((a) => a.user_id !== me);
    const looked = own.slice(0, limit);
    const rows: Array<{ id: number; name: string; event_name: string | null; shared_with: string[]; public_link: boolean; owner: "me" | "another user" }> = [];
    for (const a of looked) {
      const shares = (await photo.getAlbumShares({ id: a.id })) as unknown as AlbumShares;
      rows.push({
        id: a.id, name: a.name, event_name: a.event_name, owner: "me",
        shared_with: shares.shares.map((x) => x.user_name),
        public_link: Boolean(shares.publicLink),
      });
    }
    for (const a of foreign) rows.push({ id: a.id, name: a.name, event_name: a.event_name, owner: "another user", shared_with: [], public_link: false });
    const notes = [
      foreign.length ? `${foreign.length} album${foreign.length === 1 ? " is" : "s are"} shared with the user by someone else; only the owner sees their participants.` : undefined,
      own.length > looked.length ? `Only the first ${looked.length} of ${own.length} shared albums were looked up; narrow with q or ask for one album_id.` : undefined,
    ].filter(Boolean);
    return {
      text: table(
        ["id", "name", "event", "owner", "shared with", "public link"],
        rows.map((r) => [r.id, r.name, r.event_name, r.owner, r.shared_with.join(", ") || (r.owner === "me" ? "nobody (link only)" : "?"), r.public_link ? "yes" : "no"]),
        { cap: rows.length || 1, note: notes.join(" ") || undefined },
      ),
      digest: digestOf("list_album_shares", rows.length, rows.map((r) => r.id)),
      rowCount: rows.length,
      block: {
        kind: "albums",
        tool: "list_album_shares",
        rows: rows.map((r) => ({
          id: r.id, name: r.name, event_name: r.event_name, shared: true,
          shared_with: r.shared_with.join(", ") || null, public_link: r.public_link, route: `/fotos/alben/${r.id}`,
        })),
      },
    };
  },
};

interface PhotoComment { id: number; photoId: number; albumId: number; author: { id: number; name: string | null; kind: string }; body: string; createdAt: string; editedAt: string | null }
interface FeedItem {
  id: number; kind: string; actor: { id: number | null; name: string | null }; album: { id: number; name: string } | null;
  photo: { id: number; filename: string; description: string | null } | null; payload: Record<string, unknown>; seen_at: string | null; created_at: string;
}
const FEED_KINDS = ["photo_commented", "photo_favorited", "photo_added", "album_shared", "album_left"] as const;
const FEED_LABEL: Record<string, string> = {
  photo_commented: "comment", photo_favorited: "favorite", photo_added: "photos added", album_shared: "album shared", album_left: "left the album",
};
const FEED_PAGE = 100;

export const photoComments: ToolSpec = {
  name: "photo_comments",
  kind: "read",
  summary: "The comments under one photo in a shared album — who wrote what and when. Needs the album the photo is discussed in (album ids from list_albums or photo_activity).",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      photo_id: { type: "integer" },
      album_id: { type: "integer", description: "the album the comments belong to" },
      limit: { type: "integer", description: "newest comments to return, at most 100 (default 30)" },
    },
    required: ["photo_id", "album_id"],
  },
  async run(args) {
    const photoId = int(args.photo_id);
    const albumId = int(args.album_id);
    if (photoId === undefined || albumId === undefined) throw new Error("photo_id and album_id are required");
    const limit = int(args.limit, { min: 1, max: 100 }) ?? 30;
    const res = (await photo.listComments({ id: photoId, albumId, limit })) as unknown as { comments: PhotoComment[]; nextCursor: number | null };
    const rows = res.comments;
    return {
      text: table(
        ["id", "at", "author", "comment"],
        rows.map((c) => [c.id, c.createdAt.slice(0, 16).replace("T", " "), c.author.name ?? (c.author.kind === "guest" ? "guest" : `user ${c.author.id}`), c.body + (c.editedAt ? " (edited)" : "")]),
        { cap: limit, note: res.nextCursor !== null ? "Older comments exist beyond this page." : undefined },
      ),
      digest: digestOf("photo_comments", rows.length, rows.map((c) => c.id)),
      rowCount: rows.length,
      block: {
        kind: "comments",
        tool: "photo_comments",
        total: rows.length,
        rows: rows.map((c) => ({ id: c.id, author: c.author.name ?? "Gast", at: c.createdAt, body: c.body, photo_id: c.photoId, album_id: c.albumId, route: `/fotos/alben/${c.albumId}?photoId=${c.photoId}` })),
        route: `/fotos/alben/${albumId}?photoId=${photoId}`,
      },
    };
  },
};

export const photoActivity: ToolSpec = {
  name: "photo_activity",
  kind: "read",
  summary: "What happened in the user's shared albums, newest first: comments (with an excerpt), favorites, photos added, albums shared — the discussions around the photos. Filter by kind, album or photo; unread entries are marked.",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...FEED_KINDS], description: "only this kind of event; photo_commented for the discussions" },
      album_id: { type: "integer", description: "only one album" },
      photo_id: { type: "integer", description: "only one photo" },
      unread_only: { type: "boolean", description: "only what the user has not seen yet" },
      limit: { type: "integer", description: "entries to return, at most 50 (default 20)" },
    },
  },
  async run(args) {
    const kind = str(args.kind);
    if (kind && !(FEED_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${FEED_KINDS.join(", ")}`);
    const albumId = int(args.album_id);
    const photoId = int(args.photo_id);
    const unreadOnly = bool(args.unread_only) === true;
    const limit = int(args.limit, { min: 1, max: 50 }) ?? 20;
    // The feed is one stream; a filter reads a few pages of it, never the whole history.
    const rows: FeedItem[] = [];
    let cursor: number | undefined;
    let unread = 0;
    for (let page = 0; page < 5 && rows.length < limit; page++) {
      const res = (await feed.listFeed({ cursor, limit: FEED_PAGE })) as unknown as { items: FeedItem[]; nextCursor: number | null; unreadCount: number };
      if (page === 0) unread = res.unreadCount;
      for (const it of res.items) {
        if (kind && it.kind !== kind) continue;
        if (albumId !== undefined && it.album?.id !== albumId) continue;
        if (photoId !== undefined && it.photo?.id !== photoId) continue;
        if (unreadOnly && it.seen_at) continue;
        rows.push(it);
        if (rows.length >= limit) break;
      }
      if (res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    const what = (it: FeedItem) => {
      const excerpt = typeof it.payload.excerpt === "string" ? it.payload.excerpt : undefined;
      const count = typeof it.payload.count === "number" ? it.payload.count : undefined;
      return excerpt ?? (count !== undefined ? `${count} photos` : it.photo?.description ?? "");
    };
    return {
      text: table(
        ["id", "at", "kind", "who", "album", "photo", "what", "unread"],
        rows.map((it) => [it.id, it.created_at.slice(0, 16).replace("T", " "), FEED_LABEL[it.kind] ?? it.kind, it.actor.name, it.album?.name, it.photo?.id, what(it), it.seen_at ? "" : "yes"]),
        { cap: limit, note: `${unread} unread entries in the whole feed. For the full text of a comment call photo_comments(photo_id, album_id).` },
      ),
      digest: digestOf("photo_activity", rows.length, rows.map((it) => it.id)),
      rowCount: rows.length,
      block: {
        kind: "activity",
        tool: "photo_activity",
        total: rows.length,
        rows: rows.map((it) => ({
          id: it.id, kind: it.kind, label: FEED_LABEL[it.kind] ?? it.kind, actor: it.actor.name ?? "Gast", at: it.created_at,
          album: it.album?.name ?? null, photo_id: it.photo?.id ?? null, filename: it.photo?.filename ?? null, what: what(it), unread: !it.seen_at,
          route: it.album ? `/fotos/alben/${it.album.id}${it.photo ? `?photoId=${it.photo.id}` : ""}` : null,
        })),
        route: "/fotos/feed",
      },
    };
  },
};

export const PHOTO_TOOLS = [listPhotos, photoDetails, searchPhotos, listRecaps, listAlbums, listAlbumShares, photoComments, photoActivity];
