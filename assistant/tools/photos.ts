/**
 * Photo read tools. The photo service checks `module.photos`, `photos.view`
 * and which photos the user may see (own, shared albums, group).
 */

import { photo } from "~encore/clients";
import { bool, digestOf, int, isoDate, query, str, table } from "../format";
import type { ToolSpec } from "../types";

const PHOTOS = ["module.photos", "photos.view"];

/** Photos counted per call; past this the answer says "more than". */
const PHOTO_COUNT_CAP = 2000;

interface PhotoRow { id: number; taken_at?: string; created_at?: string; location_city?: string; location_country?: string; filename?: string }
interface NaturalResult { photoId: number; taken_at?: string; created_at: string; location_city?: string; location_country?: string; score: number }
interface Recap { id: number; kind: string; title: string; subtitle: string | null; period_start: string | null; period_end: string | null; photo_count: number }
interface Album { id: number; name: string; event_name: string | null; oldest_photo_at: string | null; newest_photo_at: string | null; photo_count: number }

function place(p: { location_city?: string; location_country?: string }): string | undefined {
  return [p.location_city, p.location_country].filter(Boolean).join(", ") || undefined;
}

function yearOf(date: string | null | undefined): number | undefined {
  return date ? Number(date.slice(0, 4)) : undefined;
}

export const listPhotos: ToolSpec = {
  name: "list_photos",
  kind: "read",
  summary: "Photos filtered by favorite flag, date range and person ids; returns the count and the first ids.",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      favorite: { type: "boolean", description: "only favorites" },
      date_from: { type: "string", description: "taken on or after, YYYY-MM-DD" },
      date_to: { type: "string", description: "taken on or before, YYYY-MM-DD" },
      person_ids: { type: "array", items: { type: "integer" }, description: "ids from list_persons; photos showing these persons" },
    },
  },
  async run(args) {
    const favorite = bool(args.favorite);
    const dateFrom = isoDate(args.date_from);
    const dateTo = isoDate(args.date_to);
    const personIds = Array.isArray(args.person_ids)
      ? args.person_ids.map((v) => int(v)).filter((v): v is number => v !== undefined)
      : [];
    const res = await (photo.listPhotos({
      favorite: favorite || undefined,
      dateFrom,
      dateTo,
      personIds: personIds.length ? personIds.join(",") : undefined,
      personMode: personIds.length ? "include" : undefined,
      limit: PHOTO_COUNT_CAP + 1,
    })) as unknown as { photos: PhotoRow[] };
    const capped = res.photos.length > PHOTO_COUNT_CAP;
    const photos = res.photos.slice(0, PHOTO_COUNT_CAP);
    const count = photos.length;
    const countText = capped ? `more than ${PHOTO_COUNT_CAP}` : String(count);
    return {
      text: table(
        ["id", "taken", "place"],
        photos.map((p) => [p.id, (p.taken_at ?? p.created_at ?? "").slice(0, 10), place(p)]),
        { cap: 15, total: count, note: `photo count: ${countText}` },
      ),
      digest: digestOf("list_photos", count, photos.map((p) => p.id)),
      rowCount: count,
      block: {
        kind: "photos",
        tool: "list_photos",
        total: count,
        rows: photos.slice(0, 60).map((p) => ({ id: p.id, taken_at: p.taken_at ?? null })),
        route: `/fotos/galerie${query({
          favorite: favorite ? "true" : undefined, dateFrom, dateTo, personIds: personIds.join(",") || undefined,
        })}`,
      },
    };
  },
};

export const searchPhotos: ToolSpec = {
  name: "search_photos",
  kind: "read",
  summary: "Natural-language photo search over what the image shows, place and date (German works).",
  permissions: PHOTOS,
  source: "hand",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "e.g. 'Strand in Italien 2024'" } },
    required: ["query"],
  },
  async run(args) {
    const q = str(args.query);
    if (!q) throw new Error("query is required");
    const res = await (photo.searchPhotosNatural({ query: q, limit: 200 })) as unknown as { results: NaturalResult[] };
    const rows = res.results;
    return {
      text: table(
        ["id", "taken", "place", "score"],
        rows.map((r) => [r.photoId, (r.taken_at ?? r.created_at).slice(0, 10), place(r), r.score.toFixed(2)]),
        { cap: 15, total: rows.length },
      ),
      digest: digestOf("search_photos", rows.length, rows.map((r) => r.photoId)),
      rowCount: rows.length,
      block: {
        kind: "photos",
        tool: "search_photos",
        total: rows.length,
        rows: rows.slice(0, 60).map((r) => ({ id: r.photoId, taken_at: r.taken_at ?? null })),
        route: `/fotos/galerie${query({ q })}`,
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
  summary: "Photo albums with event name, photo period and count; optionally only those with an event or in a year.",
  permissions: ["module.photos"],
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "only albums whose photos fall in this year" },
      has_event: { type: "boolean", description: "only albums with an event name (trips, parties)" },
      q: { type: "string", description: "text in name or event" },
    },
  },
  async run(args) {
    const year = int(args.year);
    const hasEvent = bool(args.has_event);
    const q = str(args.q)?.toLocaleLowerCase("de");
    const res = await (photo.listAlbums()) as unknown as { albums: Album[] };
    const rows = res.albums.filter((a) => {
      if (hasEvent && !a.event_name) return false;
      if (q && !`${a.name} ${a.event_name ?? ""}`.toLocaleLowerCase("de").includes(q)) return false;
      if (year !== undefined) {
        const from = yearOf(a.oldest_photo_at);
        const to = yearOf(a.newest_photo_at) ?? from;
        if (from === undefined || to === undefined || year < from || year > to) return false;
      }
      return true;
    });
    return {
      text: table(
        ["id", "name", "event", "from", "to", "photos"],
        rows.map((a) => [a.id, a.name, a.event_name, a.oldest_photo_at?.slice(0, 10), a.newest_photo_at?.slice(0, 10), a.photo_count]),
        { cap: 30 },
      ),
      digest: digestOf("list_albums", rows.length, rows.map((a) => a.id)),
      rowCount: rows.length,
      block: {
        kind: "albums",
        tool: "list_albums",
        rows: rows.map((a) => ({ id: a.id, name: a.name, event_name: a.event_name, photo_count: a.photo_count, route: `/fotos/alben/${a.id}` })),
        route: `/fotos/alben${query({ q: str(args.q) })}`,
      },
    };
  },
};

export const PHOTO_TOOLS = [listPhotos, searchPhotos, listRecaps, listAlbums];
