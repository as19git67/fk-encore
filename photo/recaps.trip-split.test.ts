import { describe, expect, it } from "vitest";
import { splitBucketByGeo, type CandidatePhoto } from "./recaps.service";

const photo = (
  id: number,
  lat: number | null,
  lon: number | null,
  takenAt: string = "2026-05-01T10:00:00Z"
): CandidatePhoto => ({
  id,
  taken_at: takenAt,
  created_at: takenAt,
  latitude: lat,
  longitude: lon,
  location_city: null,
  location_country: null,
  ai_quality_score: null,
  curation_status: null,
});

// Berlin and Prague are ~280 km apart — well above the 50 km split threshold.
const BERLIN = { lat: 52.52, lon: 13.405 };
const PRAGUE = { lat: 50.075, lon: 14.437 };

// Two spots within Berlin, ~5 km apart — should stay together.
const BERLIN_MITTE = { lat: 52.52, lon: 13.405 };
const BERLIN_CHARLOTTENBURG = { lat: 52.515, lon: 13.305 };

describe("splitBucketByGeo", () => {
  it("keeps photos in the same city together", () => {
    const photos = [
      photo(1, BERLIN_MITTE.lat, BERLIN_MITTE.lon),
      photo(2, BERLIN_CHARLOTTENBURG.lat, BERLIN_CHARLOTTENBURG.lon),
      photo(3, BERLIN_MITTE.lat + 0.002, BERLIN_MITTE.lon + 0.001),
    ];
    const groups = splitBucketByGeo(photos);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("splits photos in different cities", () => {
    const photos = [
      photo(1, BERLIN.lat, BERLIN.lon),
      photo(2, BERLIN.lat + 0.001, BERLIN.lon),
      photo(3, PRAGUE.lat, PRAGUE.lon),
      photo(4, PRAGUE.lat + 0.001, PRAGUE.lon),
    ];
    const groups = splitBucketByGeo(photos);
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.map((p) => p.id).sort());
    expect(ids).toContainEqual([1, 2]);
    expect(ids).toContainEqual([3, 4]);
  });

  it("assigns GPS-less photos to the largest cluster", () => {
    const photos = [
      photo(1, BERLIN.lat, BERLIN.lon),
      photo(2, BERLIN.lat, BERLIN.lon + 0.001),
      photo(3, null, null), // no GPS — should join Berlin (larger cluster)
      photo(4, PRAGUE.lat, PRAGUE.lon),
    ];
    const groups = splitBucketByGeo(photos);
    expect(groups).toHaveLength(2);
    // Find the Berlin group — should have 3 photos (incl. the GPS-less one).
    const berlinGroup = groups.find((g) =>
      g.some((p) => p.id === 1)
    );
    expect(berlinGroup).toBeDefined();
    expect(berlinGroup!.map((p) => p.id)).toContain(3);
  });

  it("returns empty array for empty input", () => {
    expect(splitBucketByGeo([])).toHaveLength(0);
  });

  it("keeps a single photo as one group", () => {
    const groups = splitBucketByGeo([photo(1, BERLIN.lat, BERLIN.lon)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });
});
