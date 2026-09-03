import { describe, expect, it } from "vitest";
import {
  DETOUR_FACTOR,
  WALKING_SPEED_M_PER_MIN,
  haversineMeters,
  walkingLeg,
} from "./travel";

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters({ lat: 48.37, lon: 10.9 }, { lat: 48.37, lon: 10.9 })).toBe(0);
  });

  it("gives ~111 m per 0.001° of latitude", () => {
    const d = haversineMeters({ lat: 48.37, lon: 10.9 }, { lat: 48.371, lon: 10.9 });
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(114);
  });

  it("is symmetric", () => {
    const a = { lat: 48.37, lon: 10.9 };
    const b = { lat: 48.4, lon: 11.0 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("walkingLeg", () => {
  it("applies the detour factor and the walking speed", () => {
    const a = { lat: 48.37, lon: 10.9 };
    const b = { lat: 48.379, lon: 10.9 }; // ~1 km straight line
    const straight = haversineMeters(a, b);
    const leg = walkingLeg(a, b);

    expect(leg.distanceM).toBe(Math.round(straight * DETOUR_FACTOR));
    expect(leg.minutes).toBe(Math.round(leg.distanceM / WALKING_SPEED_M_PER_MIN));
  });

  it("classifies a leg under ten minutes as a short walk", () => {
    // ~400 m straight → ~520 m walked → ~7 min
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.3736, lon: 10.9 });
    expect(leg.minutes).toBeLessThan(10);
    expect(leg.travelClass).toBe("short_walk");
  });

  it("classifies a longer leg as a long walk", () => {
    // ~1.5 km straight → ~2 km walked → ~26 min
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.3835, lon: 10.9 });
    expect(leg.minutes).toBeGreaterThanOrEqual(10);
    expect(leg.travelClass).toBe("long_walk");
  });

  it("costs nothing to stay where you are", () => {
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.37, lon: 10.9 });
    expect(leg).toEqual({ distanceM: 0, minutes: 0, travelClass: "short_walk" });
  });
});
