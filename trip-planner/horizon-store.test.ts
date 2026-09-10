/**
 * Storing and reusing a place's horizon (§7.3).
 *
 * Two things are worth a test here, and neither is arithmetic: that a
 * profile is computed once and then read, and that a height model
 * nobody can reach costs a light window its terrain and nothing else.
 */

import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { horizonProfiles } from "../db/schema";
import type { ElevationClient } from "./elevation-client";
import { setElevationClient } from "./elevation-client";
import type { Coordinate } from "./horizon";
import {
  computeHorizon,
  horizonFor,
  PLACE_GRID_DEGREES,
  readHorizon,
  roundToPlace,
} from "./horizon-store";

const VALLEY = { lat: 47.2701, lon: 11.4001 };

/** A model with a ridge due south and level ground everywhere else. */
class RidgeModel implements ElevationClient {
  calls = 0;
  constructor(private readonly ridgeM = 900) {}
  async elevations(points: readonly Coordinate[]): Promise<(number | null)[]> {
    this.calls += 1;
    const [origin, ...rest] = points;
    return [
      500,
      ...rest.map((point) => (point.lat < origin.lat - 0.001 ? this.ridgeM : 500)),
    ];
  }
}

class DeadModel implements ElevationClient {
  async elevations(): Promise<(number | null)[]> {
    throw new Error("height model unreachable");
  }
}

describe("horizon-store", () => {
  beforeEach(async () => {
    await db.delete(horizonProfiles);
  });

  it("snaps a place to about a hundred metres", () => {
    expect(roundToPlace(47.27004)).toBeCloseTo(47.27, 5);
    expect(roundToPlace(47.2706)).toBeCloseTo(47.271, 5);
    expect(PLACE_GRID_DEGREES).toBeLessThan(0.002);
  });

  it("computes a profile with the ridge in it and stores it", async () => {
    setElevationClient(new RidgeModel());
    const profile = await computeHorizon(VALLEY);

    const south = profile.find((point) => point.azimuth === 180);
    expect(south).toBeDefined();
    expect(south!.altitude).toBeGreaterThan(1);
    const north = profile.find((point) => point.azimuth === 0);
    expect(north!.altitude).toBeLessThan(0.5);

    expect(await readHorizon(VALLEY)).toEqual(profile);
  });

  it("asks the model once and reads the row after that", async () => {
    const model = new RidgeModel();
    setElevationClient(model);

    await horizonFor(VALLEY);
    expect(model.calls).toBe(1);

    // A second spot in the same hundred-metre square is the same place.
    await horizonFor({ lat: VALLEY.lat + 0.0002, lon: VALLEY.lon });
    expect(model.calls).toBe(1);
  });

  it("assumes a free horizon when the model is unreachable", async () => {
    setElevationClient(new DeadModel());
    expect(await horizonFor(VALLEY)).toEqual([]);
    expect(await readHorizon(VALLEY)).toBeNull();
  });

  it("knows nothing about a place nobody has measured", async () => {
    expect(await readHorizon({ lat: 12.34, lon: 56.78 })).toBeNull();
  });
});
