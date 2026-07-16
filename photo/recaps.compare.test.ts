import { describe, expect, it } from "vitest";
import { pickThenAndNow, type CandidatePhoto } from "./recaps.service";

const photo = (
  id: number,
  takenAt: string | null,
  quality: number | null = null
): CandidatePhoto => ({
  id,
  taken_at: takenAt,
  created_at: takenAt,
  latitude: null,
  longitude: null,
  location_city: null,
  location_country: null,
  ai_quality_score: quality,
  curation_status: null,
});

describe("pickThenAndNow", () => {
  it("picks the best-quality photo from the oldest and newest year", () => {
    const result = pickThenAndNow([
      photo(1, "2015-06-01T10:00:00Z", 0.4),
      photo(2, "2015-08-01T10:00:00Z", 0.9), // best of 2015
      photo(3, "2020-01-01T10:00:00Z", 0.99),
      photo(4, "2026-03-01T10:00:00Z", 0.7), // best of 2026
      photo(5, "2026-05-01T10:00:00Z", 0.2),
    ]);
    expect(result).not.toBeNull();
    expect(result!.then.id).toBe(2);
    expect(result!.thenYear).toBe(2015);
    expect(result!.now.id).toBe(4);
    expect(result!.nowYear).toBe(2026);
  });

  it("returns null when the year span is too small", () => {
    expect(
      pickThenAndNow([
        photo(1, "2025-01-01T10:00:00Z"),
        photo(2, "2026-06-01T10:00:00Z"),
      ])
    ).toBeNull();
  });

  it("returns null for photos without dates or fewer than two dated photos", () => {
    expect(pickThenAndNow([photo(1, null), photo(2, null)])).toBeNull();
    expect(pickThenAndNow([photo(1, "2015-01-01T10:00:00Z")])).toBeNull();
    expect(pickThenAndNow([])).toBeNull();
  });

  it("treats missing quality as 0", () => {
    const result = pickThenAndNow([
      photo(1, "2010-01-01T10:00:00Z", null),
      photo(2, "2010-02-01T10:00:00Z", 0.1),
      photo(3, "2026-01-01T10:00:00Z", null),
    ]);
    expect(result!.then.id).toBe(2);
    expect(result!.now.id).toBe(3);
  });
});
