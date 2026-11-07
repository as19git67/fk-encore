import { describe, it, expect } from "vitest";
import { editedPoint, editedSize, quarterTurns } from "./photo-edit-geometry";

describe("edited photo geometry", () => {
  it("keeps the size of an unedited photo and swaps it for a quarter turn", () => {
    expect(editedSize(3000, 2000, null)).toEqual({ width: 3000, height: 2000 });
    expect(editedSize(3000, 2000, { crop: null, rotation: 0 })).toEqual({ width: 3000, height: 2000 });
    expect(editedSize(3000, 2000, { crop: null, rotation: 90 })).toEqual({ width: 2000, height: 3000 });
    expect(editedSize(3000, 2000, { crop: null, rotation: 180 })).toEqual({ width: 3000, height: 2000 });
    expect(editedSize(3000, 2000, { crop: null, rotation: 270 })).toEqual({ width: 2000, height: 3000 });
    expect(editedSize(null, 2000, { crop: null, rotation: 90 })).toBeNull();
  });

  it("crops before it turns, as the renderer does", () => {
    // Half the width, the full height: 1500 × 2000, turned: 2000 × 1500.
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    expect(editedSize(3000, 2000, { crop, rotation: 0 })).toEqual({ width: 1500, height: 2000 });
    expect(editedSize(3000, 2000, { crop, rotation: 90 })).toEqual({ width: 2000, height: 1500 });
  });

  it("moves the focal point with crop and turn", () => {
    const p = { x: 0.2, y: 0.1 };
    expect(editedPoint(p, null)).toEqual(p);
    // Clockwise: the top-left corner goes to the top right.
    expect(editedPoint({ x: 0, y: 0 }, { crop: null, rotation: 90 })).toEqual({ x: 1, y: 0 });
    expect(editedPoint(p, { crop: null, rotation: 90 })).toEqual({ x: 0.9, y: 0.2 });
    expect(editedPoint(p, { crop: null, rotation: 180 })).toEqual({ x: 0.8, y: 0.9 });
    expect(editedPoint(p, { crop: null, rotation: 270 })).toEqual({ x: 0.1, y: 0.8 });
    // Inside the crop it keeps its place in the cut-out; outside it lands on the edge.
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    expect(editedPoint({ x: 0.5, y: 0.5 }, { crop, rotation: 0 })).toEqual({ x: 0.5, y: 0.5 });
    expect(editedPoint({ x: 0.9, y: 0.5 }, { crop, rotation: 0 })).toEqual({ x: 1, y: 0.5 });
    expect(editedPoint(null, { crop, rotation: 90 })).toBeNull();
  });

  it("reads any rotation as a quarter turn", () => {
    expect(quarterTurns(-90)).toBe(270);
    expect(quarterTurns(450)).toBe(90);
    expect(quarterTurns(null)).toBe(0);
  });
});
