import { describe, expect, it } from "vitest";
import { computeHomeCentroid, type CandidatePhoto } from "./recaps.service";

const photo = (
  id: number,
  takenAt: string,
  lat: number | null,
  lon: number | null
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

// Beispielstadt (fiktiv)
const HOME = { lat: 48.14, lon: 11.58 };
// Tokio
const TRIP = { lat: 35.68, lon: 139.69 };

describe("computeHomeCentroid", () => {
  it("returns null without GPS photos", () => {
    const photos = [photo(1, "2026-05-01T10:00:00Z", null, null)];
    expect(computeHomeCentroid(photos, new Date("2026-07-01"))).toBeNull();
  });

  it("picks the cell with the most distinct photo days, not the coordinate average", () => {
    const photos: CandidatePhoto[] = [];
    // Home: few photos per day, but on many distinct days across the year.
    for (let day = 1; day <= 40; day++) {
      const d = `2026-${String(1 + (day % 6)).padStart(2, "0")}-${String(
        1 + (day % 27)
      ).padStart(2, "0")}T12:00:00Z`;
      photos.push(photo(1000 + day, d, HOME.lat + 0.001 * (day % 3), HOME.lon));
    }
    // Trip: 708 photos, but compressed into 14 days. A plain average would
    // land the "home" somewhere between Bavaria and Japan.
    for (let i = 0; i < 708; i++) {
      const day = 1 + (i % 14);
      photos.push(
        photo(
          2000 + i,
          `2026-06-${String(day).padStart(2, "0")}T09:00:00Z`,
          TRIP.lat + 0.0005 * (i % 5),
          TRIP.lon
        )
      );
    }

    const home = computeHomeCentroid(photos, new Date("2026-07-01"));
    expect(home).not.toBeNull();
    expect(home!.lat).toBeCloseTo(HOME.lat, 1);
    expect(home!.lon).toBeCloseTo(HOME.lon, 1);
  });

  it("still works when the library only contains one location", () => {
    const photos = [
      photo(1, "2026-05-01T10:00:00Z", HOME.lat, HOME.lon),
      photo(2, "2026-05-02T10:00:00Z", HOME.lat, HOME.lon),
    ];
    const home = computeHomeCentroid(photos, new Date("2026-07-01"));
    expect(home).not.toBeNull();
    expect(home!.lat).toBeCloseTo(HOME.lat, 4);
  });
});
