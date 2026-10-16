/**
 * The assistant's write tools (#1529). Each one only prepares: the catalog
 * turns it into a proposal (proposals.ts), and `execute` runs when the user
 * clicks "Ausführen" — through the same endpoints the app's own buttons use.
 *
 * Photo selections take the filter `list_photos` takes and are resolved to ids
 * when the proposal is made: the model sees only the first ids of a result,
 * and the card has to name the count the action will really touch.
 */

import { documents, finance, photo } from "~encore/clients";
import { bool, int, isoDate, str } from "../format";
import { writeTool, type WriteToolDefinition } from "../proposals";
import type { JsonSchema, RefType, ToolContext } from "../types";

/** More than this many objects in one proposal is refused; the user narrows first. */
const MAX_PHOTOS = 2000;
const MAX_FAVORITES = 200;
const MAX_TRANSACTIONS = 500;
const MAX_DOCUMENTS = 200;
/** Ids per call of the album batch endpoint. */
const BATCH = 500;

const PHOTO_SELECTION: Record<string, Record<string, unknown>> = {
  photos: {
    type: "object",
    description: "which photos, by the same filter as list_photos",
    properties: {
      favorite: { type: "boolean" },
      date_from: { type: "string", description: "YYYY-MM-DD" },
      date_to: { type: "string", description: "YYYY-MM-DD" },
      person_ids: { type: "array", items: { type: "integer" } },
    },
  },
  photo_ids: { type: "array", items: { type: "integer" }, description: "explicit photo ids, instead of a filter" },
  from_previous_result: { type: "boolean", description: "the photos of the previous answer, instead of a filter or ids" },
};

const FROM_PREVIOUS = (what: string) => ({
  type: "boolean",
  description: `the ${what} of the previous answer, instead of listing ids`,
});

/** Explicit ids, or the latest result of `type` when the model asks for it. */
function idsOrPrevious(args: Record<string, unknown>, key: string, type: RefType, ctx: ToolContext): number[] {
  if (bool(args.from_previous_result) === true) {
    const previous = ctx.previous?.(type);
    if (!previous) throw new Error(`there is no earlier ${type} result in this conversation`);
    return [...new Set(previous)];
  }
  return ids(args[key]);
}

function ids(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map((v) => int(v)).filter((v): v is number => v !== undefined && v > 0))]
    : [];
}

function deDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** The photo ids a selection points at, now. */
async function resolvePhotos(args: Record<string, unknown>, ctx: ToolContext): Promise<number[]> {
  if (bool(args.from_previous_result) === true) return idsOrPrevious(args, "photo_ids", "photo", ctx);
  const explicit = ids(args.photo_ids);
  if (explicit.length) return explicit.slice(0, MAX_PHOTOS + 1);
  const f = (args.photos && typeof args.photos === "object" ? args.photos : {}) as Record<string, unknown>;
  const favorite = bool(f.favorite);
  const dateFrom = isoDate(f.date_from);
  const dateTo = isoDate(f.date_to);
  const personIds = ids(f.person_ids);
  if (!favorite && !dateFrom && !dateTo && !personIds.length) {
    throw new Error("say which photos: a filter (favorite, date range, persons), photo_ids or from_previous_result");
  }
  const res = (await photo.listPhotos({
    favorite: favorite || undefined,
    dateFrom,
    dateTo,
    personIds: personIds.length ? personIds.join(",") : undefined,
    personMode: personIds.length ? "include" : undefined,
    limit: MAX_PHOTOS + 1,
  })) as unknown as { photos: { id: number }[] };
  return res.photos.map((p) => p.id);
}

function checkPhotoCount(photoIds: number[]): void {
  if (photoIds.length > MAX_PHOTOS) {
    throw new Error(`more than ${MAX_PHOTOS} photos match; narrow the selection first`);
  }
}

async function addToAlbum(albumId: number, photoIds: number[]): Promise<void> {
  for (let i = 0; i < photoIds.length; i += BATCH) {
    await photo.batchUpdateAlbumPhotos({ albumIds: [albumId], photoIds: photoIds.slice(i, i + BATCH), action: "add" });
  }
}

const createAlbum: WriteToolDefinition = {
  name: "create_album",
  summary: "Propose a new photo album, optionally filled with photos chosen by filter or ids.",
  permissions: ["module.photos", "albums.manage"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      ...PHOTO_SELECTION,
    },
    required: ["name"],
  } as JsonSchema,
  async prepare(args, ctx) {
    const name = str(args.name);
    if (!name) throw new Error("name is required");
    const wantsPhotos = Boolean(args.photos || ids(args.photo_ids).length || bool(args.from_previous_result));
    const photoIds = wantsPhotos ? await resolvePhotos(args, ctx) : [];
    checkPhotoCount(photoIds);
    return {
      summary: photoIds.length
        ? `Album „${name}“ anlegen und ${photoIds.length} Fotos hinzufügen`
        : `Leeres Album „${name}“ anlegen`,
      arguments: { name, description: str(args.description) ?? null, photo_ids: photoIds },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const album = (await photo.createAlbum({
      name: String(args.name),
      description: (args.description as string | null) ?? undefined,
    })) as unknown as { id: number; name: string };
    const photoIds = ids(args.photo_ids);
    if (photoIds.length) await addToAlbum(album.id, photoIds);
    return {
      summary: `Album „${album.name}“ mit ${photoIds.length} Fotos angelegt`,
      route: `/fotos/alben/${album.id}`,
      details: { album_id: album.id },
    };
  },
};

const addPhotosToAlbum: WriteToolDefinition = {
  name: "add_photos_to_album",
  summary: "Propose adding photos (by filter or ids) to an existing album from list_albums.",
  permissions: ["module.photos", "photos.view"],
  parameters: {
    type: "object",
    properties: {
      album_id: { type: "integer", description: "id from list_albums" },
      ...PHOTO_SELECTION,
    },
    required: ["album_id"],
  } as JsonSchema,
  async prepare(args, ctx) {
    const albumId = int(args.album_id);
    if (albumId === undefined) throw new Error("album_id is required");
    const albums = (await photo.listAlbums()) as unknown as { albums: { id: number; name: string }[] };
    const album = albums.albums.find((a) => a.id === albumId);
    if (!album) throw new Error(`album ${albumId} not found`);
    const photoIds = await resolvePhotos(args, ctx);
    checkPhotoCount(photoIds);
    if (!photoIds.length) throw new Error("no photos match");
    return {
      summary: `${photoIds.length} Fotos zum Album „${album.name}“ hinzufügen`,
      arguments: { album_id: albumId, album_name: album.name, photo_ids: photoIds },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const albumId = Number(args.album_id);
    const photoIds = ids(args.photo_ids);
    await addToAlbum(albumId, photoIds);
    return {
      summary: `${photoIds.length} Fotos zum Album „${String(args.album_name)}“ hinzugefügt`,
      route: `/fotos/alben/${albumId}`,
    };
  },
};

const setPhotoFavorite: WriteToolDefinition = {
  name: "set_photo_favorite",
  summary: "Propose marking photos as favorites, or removing the mark.",
  permissions: ["module.photos", "photos.view"],
  parameters: {
    type: "object",
    properties: {
      photo_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("photos"),
      favorite: { type: "boolean", description: "false removes the mark" },
    },
    required: ["favorite"],
  },
  async prepare(args, ctx) {
    const photoIds = idsOrPrevious(args, "photo_ids", "photo", ctx);
    if (!photoIds.length) throw new Error("photo_ids or from_previous_result is required");
    if (photoIds.length > MAX_FAVORITES) throw new Error(`at most ${MAX_FAVORITES} photos at once`);
    const favorite = bool(args.favorite) ?? true;
    return {
      summary: favorite
        ? `${photoIds.length} Fotos als Favorit markieren`
        : `Bei ${photoIds.length} Fotos die Favoriten-Markierung entfernen`,
      arguments: { photo_ids: photoIds, favorite },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const photoIds = ids(args.photo_ids);
    const status = args.favorite === false ? "visible" : "favorite";
    for (const id of photoIds) await photo.updatePhotoCuration({ id, status });
    return {
      summary: status === "favorite"
        ? `${photoIds.length} Fotos als Favorit markiert`
        : `Bei ${photoIds.length} Fotos die Markierung entfernt`,
      route: status === "favorite" ? "/fotos/galerie?favorite=true" : undefined,
    };
  },
};

const createDocumentFollowUp: WriteToolDefinition = {
  name: "create_document_follow_up",
  summary: "Propose a follow-up (Wiedervorlage) on documents for a date, with an optional note.",
  permissions: ["module.documents", "documents.view"],
  parameters: {
    type: "object",
    properties: {
      document_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("documents"),
      date: { type: "string", description: "YYYY-MM-DD" },
      note: { type: "string" },
    },
    required: ["date"],
  },
  async prepare(args, ctx) {
    const documentIds = idsOrPrevious(args, "document_ids", "document", ctx);
    if (!documentIds.length) throw new Error("document_ids or from_previous_result is required");
    if (documentIds.length > MAX_DOCUMENTS) throw new Error(`at most ${MAX_DOCUMENTS} documents at once`);
    const date = isoDate(args.date);
    if (!date) throw new Error("date must be YYYY-MM-DD");
    if (date < ctx.today) throw new Error("the follow-up date lies in the past");
    const note = str(args.note) ?? null;
    return {
      summary: `Wiedervorlage am ${deDate(date)} für ${documentIds.length === 1 ? "1 Dokument" : `${documentIds.length} Dokumente`}${note ? ` („${note.slice(0, 60)}“)` : ""}`,
      arguments: { document_ids: documentIds, date, note },
      count: documentIds.length,
    };
  },
  async execute(args) {
    const res = (await documents.setDocumentFollowUp({
      document_ids: ids(args.document_ids),
      follow_up_date: String(args.date),
      note: (args.note as string | null) ?? null,
    })) as unknown as { scheduled: number };
    return {
      summary: `Wiedervorlage am ${deDate(String(args.date))} für ${res.scheduled} Dokumente gesetzt`,
      route: "/dokumente/spaeter",
    };
  },
};

const tagTransactions: WriteToolDefinition = {
  name: "tag_transactions",
  summary: "Propose adding or removing the user's tags on bookings (ids from list_transactions).",
  permissions: ["module.finance", "finance.view"],
  parameters: {
    type: "object",
    properties: {
      transaction_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("bookings"),
      add: { type: "array", items: { type: "string" }, description: "tags to add" },
      remove: { type: "array", items: { type: "string" }, description: "tags to remove" },
    },
  },
  async prepare(args, ctx) {
    const transactionIds = idsOrPrevious(args, "transaction_ids", "transaction", ctx);
    if (!transactionIds.length) throw new Error("transaction_ids or from_previous_result is required");
    if (transactionIds.length > MAX_TRANSACTIONS) throw new Error(`at most ${MAX_TRANSACTIONS} bookings at once`);
    const clean = (v: unknown) => (Array.isArray(v) ? v.map((t) => str(t)).filter((t): t is string => !!t) : []);
    const add = clean(args.add);
    const remove = clean(args.remove);
    if (!add.length && !remove.length) throw new Error("say which tags to add or remove");
    const parts = [
      add.length ? `${add.map((t) => `„${t}“`).join(", ")} setzen` : null,
      remove.length ? `${remove.map((t) => `„${t}“`).join(", ")} entfernen` : null,
    ].filter(Boolean);
    return {
      summary: `Bei ${transactionIds.length} Buchungen ${parts.join(" und ")}`,
      arguments: { transaction_ids: transactionIds, add, remove },
      count: transactionIds.length,
    };
  },
  async execute(args) {
    const res = (await finance.batchTag({
      transaction_ids: ids(args.transaction_ids),
      add: (args.add as string[]) ?? [],
      remove: (args.remove as string[]) ?? [],
    })) as unknown as { affected_transactions: number };
    return { summary: `Tags an ${res.affected_transactions} Buchungen geändert` };
  },
};

export const WRITE_TOOL_DEFINITIONS: WriteToolDefinition[] = [
  createAlbum,
  addPhotosToAlbum,
  setPhotoFavorite,
  createDocumentFollowUp,
  tagTransactions,
];

export const WRITE_TOOLS = WRITE_TOOL_DEFINITIONS.map(writeTool);

export const WRITE_TOOLS_BY_NAME = new Map(WRITE_TOOL_DEFINITIONS.map((d) => [d.name, d]));
