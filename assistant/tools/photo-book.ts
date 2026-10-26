/**
 * "Mach daraus ein Fotobuch" (documentation/plans/fotobuch.md, stage 5): the
 * assistant proposes a photo book from the photos of an answer, from ids or
 * from an album. Like every write tool it only prepares; the book is built
 * when the user clicks "Ausführen", through the photo book endpoint, with the
 * narrowing the user asked for. The card names how many photos go in before
 * narrowing; the book's own page then shows what is left.
 */

import { photo } from "~encore/clients";
import { bool, int, str } from "../format";
import type { WriteToolDefinition } from "../proposals";
import type { JsonSchema } from "../types";

const MAX_BOOK_PHOTOS = 600;
/** The selection the narrowing picks from may be larger than the book. */
const MAX_SOURCE_PHOTOS = 5000;

const FORMATS: Record<string, string> = {
  "a4-landscape": "A4 quer",
  "a4-portrait": "A4 hoch",
  "square-21": "Quadrat 21 × 21 cm",
  "square-30": "Quadrat 30 × 30 cm",
};

const SUBJECTS = ["people", "landscape", "nature", "buildings"] as const;
const SUBJECT_WORDS: Record<(typeof SUBJECTS)[number], string> = {
  people: "Personen",
  landscape: "Landschaft",
  nature: "Natur",
  buildings: "Bauwerke",
};

const WEIGHT = { type: "number", minimum: -1, maximum: 1, description: "-1 fewer, 0 as they come, 1 more" };

function photoIds(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map((v) => int(v)).filter((v): v is number => v !== undefined && v > 0))]
    : [];
}

function percent(value: unknown): number | null {
  const n = int(value, { min: 1, max: 100 });
  return n ?? null;
}

function weightsOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, number> = {};
  for (const k of SUBJECTS) {
    const v = Number((value as Record<string, unknown>)[k]);
    if (Number.isFinite(v) && v !== 0) out[k] = Math.max(-1, Math.min(1, v));
  }
  return Object.keys(out).length ? out : null;
}

function narrowingWords(args: Record<string, unknown>): string[] {
  const words: string[] = [];
  if (args.quality_min != null) words.push(`Qualität ab ${args.quality_min} %`);
  if (args.aesthetic_min != null) words.push(`Ästhetik ab ${args.aesthetic_min} %`);
  if (args.without_recognisable_faces) words.push("ohne erkennbare Gesichter");
  if (args.max_photos != null) words.push(`höchstens ${args.max_photos} Fotos`);
  const w = args.weights as Record<string, number> | null;
  if (w) {
    for (const k of SUBJECTS) {
      if (w[k] > 0) words.push(`mehr ${SUBJECT_WORDS[k]}`);
      if (w[k] < 0) words.push(`weniger ${SUBJECT_WORDS[k]}`);
    }
  }
  return words;
}

export const createPhotoBookTool: WriteToolDefinition = {
  name: "create_photo_book",
  summary:
    "Propose a photo book (chapters by capture time, pages laid out, PDF for a print shop or home) from photos of the previous answer, photo ids or an album, with optional narrowing and subject weights.",
  permissions: ["module.photos", "photos.view"],
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "the book's title, from the user's words or the photos' period and place" },
      subtitle: { type: "string" },
      from_previous_result: { type: "boolean", description: "the photos of the previous answer, instead of ids or an album" },
      photo_ids: { type: "array", items: { type: "integer" }, description: "explicit photo ids" },
      album_id: { type: "integer", description: "all photos of this album from list_albums" },
      format: { type: "string", enum: Object.keys(FORMATS), description: "trim size; a4-landscape when the user names none" },
      quality_min: { type: "integer", minimum: 1, maximum: 100, description: "only photos with at least this quality (percent)" },
      aesthetic_min: { type: "integer", minimum: 1, maximum: 100, description: "only photos with at least this aesthetic score (percent)" },
      without_recognisable_faces: { type: "boolean", description: "leave out photos where a person can be recognised" },
      max_photos: { type: "integer", minimum: 1, maximum: MAX_BOOK_PHOTOS, description: "keep at most this many, the best" },
      weights: {
        type: "object",
        description: "more or fewer photos of a subject; leave out what the user did not mention",
        properties: { people: WEIGHT, landscape: WEIGHT, nature: WEIGHT, buildings: WEIGHT },
      },
    },
    required: ["title"],
  } as JsonSchema,
  async prepare(args, ctx) {
    const title = str(args.title);
    if (!title) throw new Error("title is required");
    const format = str(args.format) ?? "a4-landscape";
    if (!FORMATS[format]) throw new Error(`unknown format ${format}; one of ${Object.keys(FORMATS).join(", ")}`);

    let ids: number[] = [];
    let albumId: number | null = null;
    let albumName: string | null = null;
    if (bool(args.from_previous_result) === true) {
      const previous = ctx.previous?.("photo");
      if (!previous) throw new Error("there is no earlier photo result in this conversation");
      ids = [...new Set(previous)];
    } else if (int(args.album_id) !== undefined) {
      albumId = int(args.album_id)!;
      const res = (await photo.listAlbums()) as unknown as { albums: { id: number; name: string; photo_count?: number }[] };
      const album = res.albums.find((a) => a.id === albumId);
      if (!album) throw new Error(`album ${albumId} not found`);
      albumName = album.name;
    } else {
      ids = photoIds(args.photo_ids);
    }
    if (!albumId && !ids.length) throw new Error("say which photos: from_previous_result, photo_ids or album_id");
    if (ids.length > MAX_SOURCE_PHOTOS) throw new Error(`more than ${MAX_SOURCE_PHOTOS} photos; narrow the selection first`);

    const prepared: Record<string, unknown> = {
      title,
      subtitle: str(args.subtitle) ?? null,
      format,
      ...(albumId ? { album_id: albumId } : { photo_ids: ids }),
      quality_min: percent(args.quality_min),
      aesthetic_min: percent(args.aesthetic_min),
      without_recognisable_faces: bool(args.without_recognisable_faces) === true,
      max_photos: int(args.max_photos, { min: 1, max: MAX_BOOK_PHOTOS }) ?? null,
      weights: weightsOf(args.weights),
    };
    const from = albumName ? `aus dem Album „${albumName}“` : `aus ${ids.length} Fotos`;
    const narrowing = narrowingWords(prepared);
    return {
      summary: `Fotobuch „${title}“ ${from} gestalten (${FORMATS[format]}${narrowing.length ? `, ${narrowing.join(", ")}` : ""})`,
      arguments: prepared,
      count: ids.length || undefined,
      note: "Chapters, pages and the PDF are made when the user runs the proposal; captions and chapter titles by the local model can be asked for on the book's page.",
    };
  },
  async execute(args) {
    const book = (await photo.createPhotoBookApi({
      title: String(args.title),
      subtitle: (args.subtitle as string | null) ?? null,
      format: args.format as "a4-landscape" | "a4-portrait" | "square-21" | "square-30",
      ...(args.album_id ? { albumId: Number(args.album_id) } : { photoIds: photoIds(args.photo_ids) }),
      qualityMin: (args.quality_min as number | null) ?? null,
      aestheticMin: (args.aesthetic_min as number | null) ?? null,
      withoutRecognisableFaces: args.without_recognisable_faces === true,
      maxPhotos: (args.max_photos as number | null) ?? null,
      weights: (args.weights as Record<string, number> | null) ?? null,
    })) as unknown as { id: number; title: string; page_count: number; photo_count: number };
    return {
      summary: `Fotobuch „${book.title}“ mit ${book.photo_count} Fotos auf ${book.page_count} Seiten angelegt`,
      route: `/fotos/fotobuecher/${book.id}`,
      details: { photo_book_id: book.id },
    };
  },
};
