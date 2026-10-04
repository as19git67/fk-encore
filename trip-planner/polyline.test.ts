import { describe, expect, it } from "vitest";
import { decodePolyline, thinPolyline } from "./polyline";

describe("decodePolyline", () => {
  it("reads Google's five-place example", () => {
    // The example from Google's polyline algorithm documentation.
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    expect(points).toEqual([
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ]);
  });

  it("reads six places by default, as Valhalla writes them", () => {
    // The same deltas with six places decode to a tenth of the span.
    const six = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(six[0].lat).toBeCloseTo(3.85, 6);
    expect(six[2].lon).toBeCloseTo(-12.6453, 6);
    expect(decodePolyline("")).toEqual([]);
  });
});

describe("thinPolyline", () => {
  it("keeps both ends and spreads the rest", () => {
    const dense = Array.from({ length: 101 }, (_, i) => ({ lat: i, lon: 0 }));
    const thin = thinPolyline(dense, 11);
    expect(thin).toHaveLength(11);
    expect(thin[0]).toEqual({ lat: 0, lon: 0 });
    expect(thin[10]).toEqual({ lat: 100, lon: 0 });
    expect(thin[5].lat).toBe(50);
    expect(thinPolyline(dense.slice(0, 5), 11)).toHaveLength(5);
  });
});
