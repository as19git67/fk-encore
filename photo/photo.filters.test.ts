import { describe, expect, it } from "vitest";
import { parsePhotoFilterQuery } from "./photo.filters";

describe("location proximity photo filter", () => {
  it("uses a 10 km default radius for a valid coordinate pair", () => {
    expect(parsePhotoFilterQuery({ nearLat: 48.1372, nearLon: 11.5756 })).toMatchObject({
      nearLat: 48.1372,
      nearLon: 11.5756,
      nearRadiusKm: 10,
    });
  });

  it("does not enable proximity filtering with invalid or incomplete coordinates", () => {
    expect(parsePhotoFilterQuery({ nearLat: 91, nearLon: 11.5756 })).not.toHaveProperty("nearLat");
    expect(parsePhotoFilterQuery({ nearLat: 48.1372 })).not.toHaveProperty("nearLat");
  });

  it("keeps the requested radius within safe bounds", () => {
    expect(parsePhotoFilterQuery({ nearLat: 0, nearLon: 0, nearRadiusKm: 0 })).toMatchObject({
      nearRadiusKm: 0.1,
    });
    expect(parsePhotoFilterQuery({ nearLat: 0, nearLon: 0, nearRadiusKm: 99999 })).toMatchObject({
      nearRadiusKm: 20_000,
    });
  });
});
