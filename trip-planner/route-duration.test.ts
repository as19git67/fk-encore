/**
 * How long a way takes (§4.7) — the walkers' rule of the two times.
 */
import { describe, expect, it } from "vitest";
import { MAX_ROUTE_MINUTES, MIN_ROUTE_MINUTES, routeMinutes } from "./route-duration";

describe("routeMinutes on foot", () => {
  it("is the flat time when nothing climbs", () => {
    // Twelve kilometres at four an hour is three hours.
    expect(routeMinutes(12_000, 0)).toBe(180);
  });

  it("charges the climb at half once the walking is longer", () => {
    // 10 km is 2.5 h along; 600 m of climb is 2 h up. The longer at
    // full, the shorter at half: 2.5 + 1 = 3.5 h. The concept's own
    // example of a way no category could have timed.
    expect(routeMinutes(10_000, 600)).toBe(210);
  });

  it("charges the walking at half when the climb is longer", () => {
    // 2 km along (0.5 h) with 900 m of climb (3 h): 3 + 0.25 = 3.25 h.
    expect(routeMinutes(2_000, 900)).toBe(195);
  });

  it("reads an unknown climb as flat rather than refusing to answer", () => {
    expect(routeMinutes(12_000, null)).toBe(180);
    expect(routeMinutes(12_000, undefined)).toBe(180);
  });
});

describe("routeMinutes by bike", () => {
  it("is quicker along and less quicker uphill", () => {
    const onFoot = routeMinutes(10_000, 600, "foot");
    const byBike = routeMinutes(10_000, 600, "bike");
    expect(byBike).toBeLessThan(onFoot);
    // 10 km at 15 km/h is 40 min; 600 m at 400 m/h is 90 min. The
    // climb is the longer, so: 90 + 20 = 110.
    expect(byBike).toBe(110);
  });

  it("walks a way for any other mode", () => {
    // A leg that gets about by car still walks the path it planned.
    expect(routeMinutes(10_000, 600, "car")).toBe(routeMinutes(10_000, 600, "foot"));
    expect(routeMinutes(10_000, 600, "transit")).toBe(routeMinutes(10_000, 600, "foot"));
  });
});

describe("the ends of the scale", () => {
  it("never calls a short way nothing", () => {
    expect(routeMinutes(300, 0)).toBe(MIN_ROUTE_MINUTES);
    expect(routeMinutes(0, 0)).toBe(MIN_ROUTE_MINUTES);
  });

  it("never proposes more than a day", () => {
    expect(routeMinutes(200_000, 8_000)).toBe(MAX_ROUTE_MINUTES);
  });

  it("treats nonsense as nothing rather than as a number", () => {
    expect(routeMinutes(Number.NaN, 600)).toBeGreaterThanOrEqual(MIN_ROUTE_MINUTES);
    expect(routeMinutes(-5_000, -600)).toBe(MIN_ROUTE_MINUTES);
  });
});

describe("who is walking (§3.5)", () => {
  it("takes longer for a group that walks slower", () => {
    // 10 km with 600 m of climb is 3.5 h for an adult hiker; a group
    // walking three kilometres an hour rather than four needs 1.4 of
    // that.
    expect(routeMinutes(10_000, 600, "foot", 1.4)).toBe(294);
  });

  it("leaves an ordinary group exactly where it was", () => {
    expect(routeMinutes(10_000, 600, "foot", 1)).toBe(routeMinutes(10_000, 600, "foot"));
  });

  it("slows the climbing with the walking, not one of them", () => {
    // Splitting the correction would claim a precision nobody has
    // measured: the whole is scaled.
    const plain = routeMinutes(2_000, 900, "foot");
    expect(routeMinutes(2_000, 900, "foot", 1.4)).toBe(Math.round(plain * 1.4));
  });

  it("still never proposes more than a day, however slow the group", () => {
    expect(routeMinutes(200_000, 8_000, "foot", 1.4)).toBe(MAX_ROUTE_MINUTES);
  });

  it("treats a nonsensical pace as no correction rather than as a number", () => {
    expect(routeMinutes(10_000, 600, "foot", 0)).toBe(routeMinutes(10_000, 600, "foot"));
    expect(routeMinutes(10_000, 600, "foot", Number.NaN)).toBe(routeMinutes(10_000, 600, "foot"));
    expect(routeMinutes(10_000, 600, "foot", -2)).toBe(routeMinutes(10_000, 600, "foot"));
  });
});
