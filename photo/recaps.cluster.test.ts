import { describe, expect, it } from "vitest";
import { clusterByLocation, type CandidatePhoto } from "./recaps.service";

const photo = (
  id: number,
  lat: number | null,
  lon: number | null
): CandidatePhoto => ({
  id,
  taken_at: "2026-05-01T10:00:00Z",
  created_at: "2026-05-01T10:00:00Z",
  latitude: lat,
  longitude: lon,
  location_city: null,
  location_country: null,
  ai_quality_score: null,
  curation_status: null,
});

// Two spots ~2 km apart in Augsburg, well beyond the ~500 m cluster radius.
const SPOT_A = { lat: 48.3668, lon: 10.8986 };
const SPOT_B = { lat: 48.3846, lon: 10.8637 };

describe("clusterByLocation", () => {
  it("groups nearby photos into one cluster", () => {
    const photos = [
      photo(1, SPOT_A.lat, SPOT_A.lon),
      photo(2, SPOT_A.lat + 0.0005, SPOT_A.lon), // ~55 m away
      photo(3, SPOT_A.lat, SPOT_A.lon + 0.0005),
    ];
    const labels = clusterByLocation(photos);
    expect(new Set(labels).size).toBe(1);
  });

  it("separates photos taken far apart", () => {
    const photos = [
      photo(1, SPOT_A.lat, SPOT_A.lon),
      photo(2, SPOT_B.lat, SPOT_B.lon),
    ];
    const labels = clusterByLocation(photos);
    expect(labels[0]).not.toBe(labels[1]);
    expect(new Set(labels).size).toBe(2);
  });

  it("puts all GPS-less photos into one shared cluster after the geo clusters", () => {
    const photos = [
      photo(1, SPOT_A.lat, SPOT_A.lon),
      photo(2, null, null),
      photo(3, null, null),
    ];
    const labels = clusterByLocation(photos);
    // Photo 1 in its geo cluster (0), the two GPS-less share the next label.
    expect(labels[1]).toBe(labels[2]);
    expect(labels[1]).not.toBe(labels[0]);
  });

  it("returns one label per input photo, in order", () => {
    const photos = [
      photo(1, SPOT_A.lat, SPOT_A.lon),
      photo(2, SPOT_B.lat, SPOT_B.lon),
      photo(3, SPOT_A.lat, SPOT_A.lon),
    ];
    const labels = clusterByLocation(photos);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toBe(labels[2]); // photo 1 and 3 share SPOT_A's cluster
  });
});
