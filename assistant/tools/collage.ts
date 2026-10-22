/**
 * `create_photo_collage`: a collage of 2 to 9 photos, optionally with a
 * caption at one of nine places. Like every write tool it only proposes; the
 * card previews the collage with the layout and caption the model chose and
 * lets the user change both before "Ausführen". Running it renders the JPEG
 * on the server (`POST /photos/collage`) and files it as a new photo, if
 * asked into an album.
 */

import { photo } from "~encore/clients";
import {
  COLLAGE_TEXT_POSITIONS,
  COLLAGE_TEXT_POSITION_LABELS,
  COLLAGE_TEXT_SIZES,
  MAX_COLLAGE_PHOTOS,
  MIN_COLLAGE_PHOTOS,
  collageLayouts,
  isTextPosition,
  pickCollageLayout,
  type CollageTextPosition,
  type CollageTextSize,
} from "../../photo/collage";
import { bool, int, str } from "../format";
import type { CollageEdits, CollagePhoto, CollagePreview, WriteToolDefinition } from "../proposals";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TEXT_SIZES = Object.keys(COLLAGE_TEXT_SIZES) as CollageTextSize[];
const MAX_TEXT = 200;

function isTextSize(v: unknown): v is CollageTextSize {
  return typeof v === "string" && (TEXT_SIZES as string[]).includes(v);
}

function layoutList(count: number): string {
  return collageLayouts(count).map((l) => `${l.id} (${l.name})`).join(", ");
}

/** Layout and caption from the model's or the card's values; throws on what cannot be drawn. */
function design(count: number, v: {
  layout?: unknown; text?: unknown; text_position?: unknown; text_size?: unknown; text_color?: unknown;
}) {
  const layoutId = str(v.layout);
  const layout = pickCollageLayout(count, layoutId);
  if (!layout) throw new Error(`unknown layout ${layoutId} for ${count} photos; use one of ${layoutList(count)}`);
  const text = (typeof v.text === "string" ? v.text.trim() : "").slice(0, MAX_TEXT);
  const position = v.text_position ?? "center";
  if (!isTextPosition(position)) throw new Error(`text_position must be one of ${COLLAGE_TEXT_POSITIONS.join(", ")}`);
  const size = v.text_size ?? "medium";
  if (!isTextSize(size)) throw new Error(`text_size must be one of ${TEXT_SIZES.join(", ")}`);
  const color = str(v.text_color) ?? "#ffffff";
  if (!HEX_COLOR.test(color)) throw new Error("text_color must be #rrggbb");
  return { layout, text, position, size, color };
}

function photoIdsOf(args: Record<string, unknown>): number[] {
  return Array.isArray(args.photo_ids)
    ? [...new Set(args.photo_ids.map((v) => int(v)).filter((v): v is number => v !== undefined && v > 0))]
    : [];
}

function summaryOf(count: number, layoutName: string, text: string, position: CollageTextPosition, albumName: string | null): string {
  const parts = [`Collage aus ${count} Fotos (${layoutName})`];
  if (text) parts.push(`mit dem Text „${text}“ ${position === "center" ? "in der Mitte" : COLLAGE_TEXT_POSITION_LABELS[position]}`);
  parts.push(albumName ? `als Foto im Album „${albumName}“ ablegen` : "als neues Foto ablegen");
  return parts.join(" ");
}

export const createPhotoCollage: WriteToolDefinition = {
  name: "create_photo_collage",
  summary: "Propose a collage of 2–9 photos, optionally with a caption placed center, top, bottom, left, right or in a corner; filed as a new photo.",
  permissions: ["module.photos", "photos.upload"],
  parameters: {
    type: "object",
    properties: {
      photo_ids: { type: "array", items: { type: "integer" }, description: "2–9 photo ids in cell order" },
      from_previous_result: { type: "boolean", description: "the photos of the previous answer (2–9), instead of ids" },
      layout: { type: "string", description: "layout id; leave out for the first one, the proposal names the others" },
      text: { type: "string", description: "caption, only when the user asks for one" },
      text_position: { type: "string", enum: [...COLLAGE_TEXT_POSITIONS] },
      text_size: { type: "string", enum: TEXT_SIZES },
      text_color: { type: "string", description: "#rrggbb, white by default" },
      album_id: { type: "integer", description: "also put the collage into this album from list_albums" },
    },
  },
  async prepare(args, ctx) {
    let ids = photoIdsOf(args);
    if (bool(args.from_previous_result) === true) {
      const previous = ctx.previous?.("photo");
      if (!previous) throw new Error("there is no earlier photo result in this conversation");
      ids = [...new Set(previous)];
    }
    if (ids.length < MIN_COLLAGE_PHOTOS || ids.length > MAX_COLLAGE_PHOTOS) {
      throw new Error(`a collage takes ${MIN_COLLAGE_PHOTOS} to ${MAX_COLLAGE_PHOTOS} photos, got ${ids.length}; pick which ones first`);
    }
    const d = design(ids.length, args);
    const res = (await photo.getPhotoDetailsBatch({ ids: ids.join(",") })) as unknown as {
      photos: { id: number; filename: string; mime_type: string; auto_crop?: { x: number; y: number } | null }[];
    };
    const byId = new Map(res.photos.map((p) => [p.id, p]));
    const photos: CollagePhoto[] = ids.map((id) => {
      const p = byId.get(id);
      if (!p) throw new Error(`photo ${id} not found`);
      if (!p.mime_type.startsWith("image/")) throw new Error(`photo ${id} is a video, not a picture`);
      return { id, filename: p.filename, auto_crop: p.auto_crop ?? null };
    });

    let albumId: number | null = null;
    let albumName: string | null = null;
    const wantedAlbum = int(args.album_id);
    if (wantedAlbum !== undefined) {
      const albums = (await photo.listAlbums()) as unknown as { albums: { id: number; name: string }[] };
      const album = albums.albums.find((a) => a.id === wantedAlbum);
      if (!album) throw new Error(`album ${wantedAlbum} not found`);
      albumId = album.id;
      albumName = album.name;
    }

    const others = collageLayouts(ids.length).filter((l) => l.id !== d.layout.id);
    return {
      summary: summaryOf(ids.length, d.layout.name, d.text, d.position, albumName),
      arguments: {
        photo_ids: ids,
        photos,
        layout: d.layout.id,
        text: d.text,
        text_position: d.position,
        text_size: d.size,
        text_color: d.color,
        album_id: albumId,
        album_name: albumName,
      },
      count: ids.length,
      note: `Layout ${d.layout.id}. Other layouts for ${ids.length} photos: ${others.map((l) => `${l.id} (${l.name})`).join(", ")}. The card shows a preview where the user can change layout and caption.`,
    };
  },
  collage(args, result): CollagePreview {
    const details = (result?.details ?? null) as { photo_id?: number; filename?: string } | null;
    return {
      photos: Array.isArray(args.photos) ? (args.photos as CollagePhoto[]) : [],
      layout: String(args.layout),
      text: typeof args.text === "string" ? args.text : "",
      text_position: isTextPosition(args.text_position) ? args.text_position : "center",
      text_size: isTextSize(args.text_size) ? args.text_size : "medium",
      text_color: typeof args.text_color === "string" ? args.text_color : "#ffffff",
      album_name: typeof args.album_name === "string" ? args.album_name : null,
      result: details?.photo_id && details.filename ? { photo_id: details.photo_id, filename: details.filename } : null,
    };
  },
  edit(args, edits) {
    const c: CollageEdits = edits.collage ?? {};
    const ids = photoIdsOf(args);
    const d = design(ids.length, {
      layout: c.layout ?? args.layout,
      text: c.text ?? args.text,
      text_position: c.text_position ?? args.text_position,
      text_size: c.text_size ?? args.text_size,
      text_color: c.text_color ?? args.text_color,
    });
    return {
      ...args,
      layout: d.layout.id,
      text: d.text,
      text_position: d.position,
      text_size: d.size,
      text_color: d.color,
    };
  },
  async execute(args) {
    const ids = photoIdsOf(args);
    const text = typeof args.text === "string" ? args.text : "";
    const made = await photo.createPhotoCollage({
      photoIds: ids,
      layout: String(args.layout),
      text: text || undefined,
      textPosition: isTextPosition(args.text_position) ? args.text_position : undefined,
      textSize: isTextSize(args.text_size) ? args.text_size : undefined,
      textColor: typeof args.text_color === "string" ? args.text_color : undefined,
    });
    const albumId = int(args.album_id);
    if (albumId !== undefined) {
      await photo.batchUpdateAlbumPhotos({ albumIds: [albumId], photoIds: [made.photoId], action: "add" });
    }
    const where = albumId !== undefined ? `ins Album „${String(args.album_name)}“ gelegt` : "als neues Foto abgelegt";
    return {
      summary: made.created
        ? `Collage aus ${ids.length} Fotos erstellt und ${where}`
        : `Diese Collage gab es schon als Foto${albumId !== undefined ? `; sie wurde ${where}` : ""}`,
      route: albumId !== undefined ? `/fotos/alben/${albumId}` : `/fotos/galerie?photoId=${made.photoId}`,
      details: { photo_id: made.photoId, filename: made.filename },
    };
  },
};
