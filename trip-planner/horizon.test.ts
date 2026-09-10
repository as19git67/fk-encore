/**
 * The horizon profile generator (§7.3).
 *
 * The property that matters is the direction of the error: a ridge must
 * shorten the evening, never lengthen it, and flat ground must not
 * invent one.
 */

import { describe, expect, it } from "vitest";
import {
  destination,
  elevationAngle,
  HORIZON_AZIMUTHS,
  HORIZON_DISTANCES_M,
  isFlat,
  profileFrom,
  samplePoints,
} from "./horizon";
import { horizonAltitude } from "./sun";

const MUNICH = { lat: 48.14, lon: 11.58 };

describe("destination", () => {
  it("walks north by roughly a degree per 111 km", () => {
    const north = destination(MUNICH, 0, 111_195);
    expect(north.lat).toBeCloseTo(MUNICH.lat + 1, 2);
    expect(north.lon).toBeCloseTo(MUNICH.lon, 3);
  });

  it("walks east without changing latitude much", () => {
    const east = destination(MUNICH, 90, 10_000);
    expect(east.lon).toBeGreaterThan(MUNICH.lon);
    expect(Math.abs(east.lat - MUNICH.lat)).toBeLessThan(0.01);
  });

  it("stays on the map across the date line", () => {
    const across = destination({ lat: 0, lon: 179.99 }, 90, 5_000);
    expect(across.lon).toBeLessThanOrEqual(180);
    expect(across.lon).toBeGreaterThan(-180);
  });
});

describe("elevationAngle", () => {
  it("is positive for something above you", () => {
    expect(elevationAngle(100, 1_000)).toBeGreaterThan(5);
  });

  it("is negative when the ground falls away", () => {
    expect(elevationAngle(-50, 1_000)).toBeLessThan(0);
  });

  it("puts distant flat ground below the tangent plane", () => {
    // Twenty kilometres out, level ground has curved about 27 m away.
    // Without that correction this would be exactly zero and every
    // plain would read as a horizon at eye level.
    expect(elevationAngle(0, 20_000)).toBeLessThan(0);
    expect(elevationAngle(0, 20_000)).toBeGreaterThan(-0.2);
  });

  it("says nothing about a distance of zero", () => {
    expect(elevationAngle(500, 0)).toBe(0);
  });
});

describe("samplePoints", () => {
  it("covers every bearing at every distance", () => {
    const samples = samplePoints(MUNICH);
    expect(samples).toHaveLength(HORIZON_AZIMUTHS * HORIZON_DISTANCES_M.length);
    expect(new Set(samples.map((s) => s.azimuth)).size).toBe(HORIZON_AZIMUTHS);
  });

  it("starts due north and turns clockwise", () => {
    const [first, ...rest] = samplePoints(MUNICH, 4, [1_000]);
    expect(first.azimuth).toBe(0);
    expect(rest.map((s) => s.azimuth)).toEqual([90, 180, 270]);
  });
});

describe("profileFrom", () => {
  const samples = samplePoints(MUNICH, 4, [1_000, 2_000]);

  it("keeps the highest angle per bearing", () => {
    // Due north: a low wall close by and a high ridge further out. The
    // ridge wins even though the wall is nearer.
    const heights = samples.map((sample) => {
      if (sample.azimuth !== 0) return 500;
      return sample.distanceM === 1_000 ? 520 : 700;
    });
    const profile = profileFrom(500, samples, heights);
    const north = profile.find((point) => point.azimuth === 0);
    expect(north?.altitude).toBeCloseTo(elevationAngle(200, 2_000), 1);
  });

  it("reads flat ground as flat", () => {
    const profile = profileFrom(500, samples, samples.map(() => 500));
    expect(isFlat(profile)).toBe(true);
    for (const point of profile) expect(point.altitude).toBeLessThanOrEqual(0);
  });

  it("skips a hole in the model instead of calling it sea level", () => {
    // Every sample due east is missing. Filling those with zero would
    // put the spot on a 500 m cliff and hand it an extra hour of sun.
    const heights = samples.map((sample) => (sample.azimuth === 90 ? null : 500));
    const profile = profileFrom(500, samples, heights);
    expect(profile.some((point) => point.azimuth === 90)).toBe(false);
    // …and the reader interpolates across the gap from its neighbours.
    expect(horizonAltitude(profile, 90)).toBeLessThan(0.5);
  });

  it("has no points at all when the model knows nothing", () => {
    expect(profileFrom(500, samples, samples.map(() => null))).toEqual([]);
  });

  it("hands the light calculation a profile it can interpolate", () => {
    const heights = samples.map((sample) => (sample.azimuth === 180 ? 900 : 500));
    const profile = profileFrom(500, samples, heights);
    // Due south is blocked, due north is not, and halfway between the
    // two the answer lies in between rather than jumping.
    expect(horizonAltitude(profile, 180)).toBeGreaterThan(10);
    expect(horizonAltitude(profile, 0)).toBeLessThan(0.5);
    const between = horizonAltitude(profile, 135);
    expect(between).toBeGreaterThan(0);
    expect(between).toBeLessThan(horizonAltitude(profile, 180));
  });
});

describe("isFlat", () => {
  it("is true for an empty profile", () => {
    expect(isFlat([])).toBe(true);
  });

  it("is false as soon as something stands up", () => {
    expect(isFlat([{ azimuth: 0, altitude: 3 }])).toBe(false);
  });
});
