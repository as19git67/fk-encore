import { describe, expect, it } from "vitest";

import {
  chooseOsdRotation,
  normalizeRightAngle,
  parseOsdRotation,
} from "./ocr-preprocess";

describe("documents.ocr-preprocess parseOsdRotation", () => {
  const sample = [
    "Page number: 0",
    "Orientation in degrees: 90",
    "Rotate: 270",
    "Orientation confidence: 15.30",
    "Script: Latin",
    "Script confidence: 3.44",
  ].join("\n");

  it("parses the Rotate angle and confidence from OSD output", () => {
    expect(parseOsdRotation(sample)).toEqual({ rotate: 270, confidence: 15.3 });
  });

  it("handles an upright page (Rotate: 0)", () => {
    const out = [
      "Orientation in degrees: 0",
      "Rotate: 0",
      "Orientation confidence: 12.00",
    ].join("\n");
    expect(parseOsdRotation(out)).toEqual({ rotate: 0, confidence: 12 });
  });

  it("normalizes an out-of-range angle back into 0/90/180/270", () => {
    const out = ["Rotate: 360", "Orientation confidence: 5.0"].join("\n");
    expect(parseOsdRotation(out)).toEqual({ rotate: 0, confidence: 5 });
  });

  it("rejects a non-right-angle rotation as noise", () => {
    const out = ["Rotate: 45", "Orientation confidence: 5.0"].join("\n");
    expect(parseOsdRotation(out)).toBeNull();
  });

  it("returns null when there is no OSD block (blank page / error)", () => {
    expect(parseOsdRotation("")).toBeNull();
    expect(parseOsdRotation("Too few characters. Skipping this page")).toBeNull();
  });

  it("defaults confidence to 0 when the line is absent", () => {
    expect(parseOsdRotation("Rotate: 180")).toEqual({ rotate: 180, confidence: 0 });
  });
});

describe("documents.ocr-preprocess chooseOsdRotation", () => {
  it("applies a confident right-angle rotation", () => {
    expect(chooseOsdRotation({ rotate: 90, confidence: 10 }, 1)).toBe(90);
    expect(chooseOsdRotation({ rotate: 270, confidence: 2 }, 1)).toBe(270);
  });

  it("does not rotate an upright page", () => {
    expect(chooseOsdRotation({ rotate: 0, confidence: 20 }, 1)).toBe(0);
  });

  it("ignores a low-confidence detection", () => {
    expect(chooseOsdRotation({ rotate: 90, confidence: 0.4 }, 1)).toBe(0);
  });

  it("treats a null OSD result as no rotation", () => {
    expect(chooseOsdRotation(null, 1)).toBe(0);
  });
});

describe("documents.ocr-preprocess normalizeRightAngle", () => {
  it("snaps to the nearest right angle and wraps into [0,360)", () => {
    expect(normalizeRightAngle(0)).toBe(0);
    expect(normalizeRightAngle(90)).toBe(90);
    expect(normalizeRightAngle(269)).toBe(270);
    expect(normalizeRightAngle(360)).toBe(0);
    expect(normalizeRightAngle(-90)).toBe(270);
    expect(normalizeRightAngle(44)).toBe(0);
    expect(normalizeRightAngle(46)).toBe(90);
  });
});
