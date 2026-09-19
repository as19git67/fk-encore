/**
 * What a route walks past (§4.7). A compact synthetic valley; every
 * place is invented.
 */
import { describe, expect, it } from "vitest";
import { CORRIDOR_HALF_WIDTH_M, distanceToWayMetres, isPassedByAny, passedBy } from "./on-the-way";

const START = { lat: 45.88, lon: 10.84 };

/** North of the start by roughly `metres`. */
function north(metres: number) {
  return { lat: START.lat + metres / 111_320, lon: START.lon };
}

/** East of a point by roughly `metres`, at this latitude. */
function east(of: { lat: number; lon: number }, metres: number) {
  return { lat: of.lat, lon: of.lon + metres / (111_320 * Math.cos((of.lat * Math.PI) / 180)) };
}

const ROUTE_END = north(8_000);

function route(osmRef = "manual:route") {
  return { osmRef, ...START, extent: { end: ROUTE_END } };
}

function spot(osmRef: string, at: { lat: number; lon: number }) {
  return { osmRef, ...at };
}

describe("distanceToWayMetres", () => {
  it("is nothing for a spot on the line", () => {
    expect(distanceToWayMetres(START, ROUTE_END, north(4_000))).toBeLessThan(1);
  });

  it("is the step off the line, whatever the route's length", () => {
    // The point of a fixed corridor: two hundred metres aside is two
    // hundred metres, on a short way and on a long one alike.
    expect(distanceToWayMetres(START, ROUTE_END, east(north(4_000), 200))).toBeCloseTo(200, -1);
    const shortEnd = north(1_000);
    expect(distanceToWayMetres(START, shortEnd, east(north(500), 200))).toBeCloseTo(200, -1);
  });

  it("measures to the way's ends, not along an endless line", () => {
    // In line with the route but four kilometres past its finish.
    expect(distanceToWayMetres(START, ROUTE_END, north(12_000))).toBeCloseTo(4_000, -2);
  });

  it("answers the distance to the point when a route has no length", () => {
    expect(distanceToWayMetres(START, START, east(START, 300))).toBeCloseTo(300, -1);
  });
});

describe("passedBy", () => {
  it("takes in what lies on the way", () => {
    const passed = passedBy(route(), [
      spot("node:on", east(north(4_000), 80)),
      spot("node:off", east(north(4_000), 900)),
    ]);
    expect(passed.map((p) => p.osmRef)).toEqual(["node:on"]);
  });

  it("counts a spot at either end as passed", () => {
    const passed = passedBy(route(), [
      spot("node:start", east(START, 50)),
      spot("node:finish", east(ROUTE_END, 50)),
    ]);
    expect(passed.map((p) => p.osmRef)).toEqual(["node:start", "node:finish"]);
  });

  it("ignores a spot beyond either end", () => {
    // On the same line, but past the finish: you turn round before it.
    const passed = passedBy(route(), [spot("node:beyond", north(12_000))]);
    expect(passed).toEqual([]);
  });

  it("is empty for an ordinary point", () => {
    const point = { osmRef: "node:museum", ...START };
    expect(passedBy(point, [spot("node:next-door", east(START, 40))])).toEqual([]);
  });

  it("never passes itself", () => {
    const r = route();
    expect(passedBy(r, [r])).toEqual([]);
  });

  it("does not swallow another route", () => {
    // Two ways that cross are two outings. The one nobody planned is
    // not "seen on the way".
    const crossing = { osmRef: "manual:other", ...east(north(4_000), 50), extent: { end: east(north(4_000), 5_000) } };
    expect(passedBy(route(), [crossing])).toEqual([]);
  });

  it("says nothing for a route too short to have a way", () => {
    const stub = { osmRef: "manual:stub", ...START, extent: { end: north(200) } };
    expect(passedBy(stub, [spot("node:near", east(START, 20))])).toEqual([]);
  });

  it("takes the width it is given", () => {
    const off = spot("node:off", east(north(4_000), 1_000));
    expect(passedBy(route(), [off])).toEqual([]);
    expect(passedBy(route(), [off], 5_000).map((p) => p.osmRef)).toEqual(["node:off"]);
    expect(CORRIDOR_HALF_WIDTH_M).toBeLessThan(1_000);
  });
});

describe("isPassedByAny", () => {
  it("is true once one of the chosen stops walks past it", () => {
    const onTheWay = spot("node:on", east(north(4_000), 80));
    expect(isPassedByAny([route()], onTheWay)).toBe(true);
    expect(isPassedByAny([{ osmRef: "node:museum", ...START }], onTheWay)).toBe(false);
    expect(isPassedByAny([], onTheWay)).toBe(false);
  });
});
