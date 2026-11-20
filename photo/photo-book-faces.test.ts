import { describe, expect, it } from "vitest";
import {
  MAX_FACE_CUT,
  MIN_ZOOM,
  faceCut,
  frameFaces,
  placePhoto,
  relevantFaces,
  type FaceRect,
} from "./photo-book-faces";
import { coverCrop } from "./recap-export.service";

const LANDSCAPE = 3 / 2;
/** A tall cell: a 3:2 photo keeps a third of its width. */
const TALL = 1 / 2;

function shown(photoAspect: number, cellAspect: number, faces: FaceRect[], canZoom: boolean) {
  const framing = frameFaces(photoAspect, cellAspect, faces, canZoom);
  const placed = placePhoto(photoAspect, cellAspect, framing.placement);
  return { framing, ...placed, cuts: faces.map((f) => faceCut(f, placed.window)) };
}

describe("photo book: faces in their cells", () => {
  it("leaves a photo without faces where its focal point puts it, as before", () => {
    const f = frameFaces(LANDSCAPE, TALL, [], true);
    expect(f.placement).toBeNull();
    const { window, inset } = placePhoto(LANDSCAPE, TALL, null, { x: 0.2, y: 0.5 });
    const px = coverCrop(3000, 2000, TALL, { x: 0.2, y: 0.5 });
    expect(window.x * 3000).toBeCloseTo(px.left, 0);
    expect(window.w * 3000).toBeCloseTo(px.width, 0);
    expect(inset).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("moves the window so every face is whole", () => {
    const faces = [{ x: 0.1, y: 0.3, w: 0.1, h: 0.15 }, { x: 0.3, y: 0.3, w: 0.1, h: 0.15 }];
    const r = shown(LANDSCAPE, TALL, faces, true);
    expect(r.cuts).toEqual([0, 0]);
    expect(r.framing.placement!.zoom).toBe(1);
    expect(r.inset).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // Their common focal point alone cut the left one.
    const before = placePhoto(LANDSCAPE, TALL, null, { x: 0.25, y: 0.375 });
    expect(faceCut(faces[0], before.window)).toBeGreaterThan(MAX_FACE_CUT);
  });

  it("keeps faces a little above the middle when the photo loses height", () => {
    const face = { x: 0.4, y: 0.05, w: 0.2, h: 0.1 };
    const r = shown(2 / 3, 2, [face], false);
    expect(r.cuts[0]).toBe(0);
    expect(r.window.y).toBeCloseTo(0, 6);
  });

  it("zooms out on a framed cell when the faces are spread wider than the window", () => {
    const faces = [{ x: 0.3, y: 0.4, w: 0.08, h: 0.12 }, { x: 0.62, y: 0.4, w: 0.08, h: 0.12 }];
    const r = shown(LANDSCAPE, TALL, faces, true);
    expect(r.cuts).toEqual([0, 0]);
    expect(r.framing.placement!.zoom).toBeLessThan(1);
    expect(r.framing.placement!.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    // The photo fills the cell's width and leaves a strip above and below.
    expect(r.inset.w).toBeCloseTo(1, 6);
    expect(r.inset.h).toBeCloseTo(r.framing.placement!.zoom, 6);
    expect(r.inset.y).toBeCloseTo((1 - r.inset.h) / 2, 6);
  });

  it("never zooms out where the photo reaches the edge of the sheet, and cuts no face by more than a quarter when it can", () => {
    const faces = [{ x: 0.3, y: 0.4, w: 0.1, h: 0.12 }, { x: 0.57, y: 0.4, w: 0.1, h: 0.12 }];
    const r = shown(LANDSCAPE, TALL, faces, false);
    expect(r.framing.placement!.zoom).toBe(1);
    expect(Math.max(...r.cuts)).toBeGreaterThan(0);
    expect(Math.max(...r.cuts)).toBeLessThanOrEqual(MAX_FACE_CUT + 1e-6);
  });

  it("leaves a face out rather than cutting it through when a quarter is not enough", () => {
    const faces = [{ x: 0.3, y: 0.4, w: 0.08, h: 0.12 }, { x: 0.62, y: 0.4, w: 0.08, h: 0.12 }];
    const r = shown(LANDSCAPE, TALL, faces, false);
    const sorted = [...r.cuts].sort();
    expect(sorted[0]).toBe(0);
    expect(sorted[1]).toBe(1);
    expect(r.framing.worstCut).toBe(1);
  });

  it("is not steered by faces in the background", () => {
    const main = { x: 0.1, y: 0.3, w: 0.2, h: 0.3 };
    const passerby = { x: 0.9, y: 0.4, w: 0.04, h: 0.06 };
    expect(relevantFaces([main, passerby])).toHaveLength(1);
    const r = shown(LANDSCAPE, TALL, [main, passerby], true);
    expect(r.cuts[0]).toBe(0);
    expect(r.framing.placement!.zoom).toBe(1);
  });

  it("keeps the window inside the photo for any placement", () => {
    const { window } = placePhoto(LANDSCAPE, TALL, { cx: 0.99, cy: 0.5, zoom: 1 });
    expect(window.x + window.w).toBeLessThanOrEqual(1 + 1e-9);
    const zoomed = placePhoto(LANDSCAPE, TALL, { cx: 0.5, cy: 0.5, zoom: 0.1 });
    expect(zoomed.inset.h).toBeCloseTo(MIN_ZOOM, 6);
  });
});
