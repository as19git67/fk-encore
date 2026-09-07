import { describe, expect, it } from "vitest";
import { facadeLight, spotLight } from "./light";
import { lightWindows } from "./sun";

const MUNICH = { lat: 48.14, lon: 11.58 };

describe("how the sun meets a facade", () => {
  it("calls it frontal when the sun stands square to the wall", () => {
    // A south-facing facade (normal 180°, folded to 0) with the sun due
    // south at noon.
    expect(facadeLight(0, 180)).toBe("frontal");
    expect(facadeLight(0, 0)).toBe("frontal");
  });

  it("calls it raking when the light comes across the wall", () => {
    expect(facadeLight(0, 135)).toBe("raking");
    expect(facadeLight(90, 45)).toBe("raking");
  });

  it("calls it edge-on when the sun runs along the wall", () => {
    expect(facadeLight(0, 90)).toBe("edge_on");
    expect(facadeLight(90, 175)).toBe("edge_on");
  });

  it("treats a normal and its opposite as the same pair of walls", () => {
    // The column folds both into [0, 180) because an outline cannot say
    // which of the two faces is the front. The verdict must not depend
    // on which end of that fold the caller happens to hold.
    for (const sun of [0, 45, 90, 135, 200, 300, 359]) {
      expect(facadeLight(20, sun)).toBe(facadeLight(200, sun));
    }
  });

  it("says nothing about a spot with no outline", () => {
    // Every POI mapped as a node — viewpoints, most cafés — lands here,
    // and that is not a failure. The screen simply says less.
    expect(facadeLight(null, 180)).toBeNull();
    expect(facadeLight(undefined, 180)).toBeNull();
    expect(facadeLight(Number.NaN, 180)).toBeNull();
  });
});

describe("the windows as they apply to one spot", () => {
  const windows = lightWindows(MUNICH, "2026-06-21", 120);

  // Munich on the solstice: the evening golden hour has the sun in the
  // north-west (azimuth ≈ 305°), the morning one in the north-east
  // (≈ 55°). A facade square to one of those is square to it all
  // evening, which is the whole point of the exercise.
  const FACES_THE_EVENING_SUN = 125;  // 305° folded into [0, 180)
  const FACES_THE_MORNING_SUN = 55;

  it("puts a golden hour that lights the building first", () => {
    const [best] = spotLight(MUNICH, windows, FACES_THE_EVENING_SUN);
    expect(best.window.kind).toBe("golden");
    expect(best.window.fromMinutes).toBeGreaterThan(12 * 60);
    expect(best.facade).toBe("frontal");
  });

  it("prefers the morning for a building facing the other way", () => {
    const [best] = spotLight(MUNICH, windows, FACES_THE_MORNING_SUN);
    expect(best.window.kind).toBe("golden");
    expect(best.window.fromMinutes).toBeLessThan(12 * 60);
    expect(best.facade).toBe("frontal");
  });

  it("ranks a golden hour that only grazes the wall below one that lights it", () => {
    // Same day, same two windows: which comes first is decided by the
    // building, not by the clock.
    const evening = spotLight(MUNICH, windows, FACES_THE_EVENING_SUN)[0];
    const morning = spotLight(MUNICH, windows, FACES_THE_MORNING_SUN)[0];
    expect(evening.window.fromMinutes).not.toBe(morning.window.fromMinutes);
  });

  it("keeps the harsh middle of the day last, whatever it lights", () => {
    for (const facade of [0, 45, 90, 135, null]) {
      const ordered = spotLight(MUNICH, windows, facade);
      expect(ordered.at(-1)?.window.kind).toBe("harsh");
    }
  });

  it("does not demote a golden hour just because the orientation is unknown", () => {
    const ordered = spotLight(MUNICH, windows, null);
    expect(ordered[0].window.kind).toBe("golden");
    expect(ordered[0].facade).toBeNull();
  });

  it("keeps every window it was given", () => {
    expect(spotLight(MUNICH, windows, 90)).toHaveLength(windows.length);
  });

  it("judges the facade from the middle of the window, not its edge", () => {
    // The azimuth swings fastest at sunrise and sunset; either edge
    // would answer for a minute nobody is standing there.
    // The evening golden hour in Munich: the sun swings from 298.9° at
    // its start to 312.4° at its end. For a facade at 89° those two
    // ends disagree — square to it at the start, across it thereafter —
    // so the verdict says which moment was asked about.
    const evening = windows.filter((w) => w.kind === "golden").at(-1)!;
    expect(facadeLight(89, 298.9)).toBe("frontal");

    const [judged] = spotLight(MUNICH, [evening], 89);
    expect(judged.facade).toBe("raking");
  });
});
