/**
 * What a user's edit (`photo_transforms`) does to a photo's frame: its size
 * after crop and rotation, and where a point of the original lands in it.
 * It follows `renderPhotoWithRecipe` (photo-transforms-render.service.ts):
 * first the crop, in the original's display frame (after EXIF rotation), then
 * the rotation clockwise in quarter turns. Whoever changes that order changes
 * it here too.
 */

import type { PhotoTransformCrop } from "../db/schema";

export interface PhotoEdit {
  crop: PhotoTransformCrop | null;
  /** 0 | 90 | 180 | 270, clockwise. */
  rotation: number;
}

export interface Point {
  x: number;
  y: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** A rotation as one of 0, 90, 180, 270. */
export function quarterTurns(rotation: number | null | undefined): 0 | 90 | 180 | 270 {
  const r = ((Math.round((rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** The pixel size of the edited photo; null while the original's size is unknown. */
export function editedSize(
  width: number | null,
  height: number | null,
  edit: PhotoEdit | null,
): { width: number; height: number } | null {
  if (!width || !height) return null;
  if (!edit) return { width, height };
  let w = width;
  let h = height;
  if (edit.crop && edit.crop.w > 0 && edit.crop.h > 0) {
    w = Math.max(1, Math.round(clamp01(edit.crop.w) * width));
    h = Math.max(1, Math.round(clamp01(edit.crop.h) * height));
  }
  const r = quarterTurns(edit.rotation);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * A point of the original (shares 0..1, e.g. the focal point `auto_crop`) in
 * the edited photo. A point the crop cut away lands on the nearest edge.
 */
export function editedPoint(p: Point | null, edit: PhotoEdit | null): Point | null {
  if (!p) return null;
  if (!edit) return p;
  let x = p.x;
  let y = p.y;
  const c = edit.crop;
  if (c && c.w > 0 && c.h > 0) {
    x = clamp01((x - c.x) / c.w);
    y = clamp01((y - c.y) / c.h);
  }
  switch (quarterTurns(edit.rotation)) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rectangle of the original (shares 0..1, e.g. a face's `bbox`) in the
 * edited photo: the part the crop keeps, turned with the photo. Null when the
 * crop cut it away entirely.
 */
export function editedRect(r: Rect, edit: PhotoEdit | null): Rect | null {
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  const c = edit?.crop;
  if (c && c.w > 0 && c.h > 0) {
    x0 = (x0 - c.x) / c.w;
    x1 = (x1 - c.x) / c.w;
    y0 = (y0 - c.y) / c.h;
    y1 = (y1 - c.y) / c.h;
  }
  x0 = clamp01(x0);
  x1 = clamp01(x1);
  y0 = clamp01(y0);
  y1 = clamp01(y1);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  const a = editedPoint({ x: x0, y: y0 }, edit && { crop: null, rotation: edit.rotation })!;
  const b = editedPoint({ x: x1, y: y1 }, edit && { crop: null, rotation: edit.rotation })!;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
