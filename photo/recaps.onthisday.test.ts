import { describe, expect, it } from "vitest";
import { buildOnThisDayGroups, type CandidatePhoto } from "./recaps.service";

const photo = (id: number, takenAt: string): CandidatePhoto => ({
  id,
  taken_at: takenAt,
  created_at: takenAt,
  latitude: null,
  longitude: null,
  location_city: null,
  location_country: null,
  ai_quality_score: null,
  curation_status: null,
});

// "Today" is 2026-07-17; a photo on 17 July of a past year matches.
const TODAY = new Date("2026-07-17T12:00:00Z");

describe("buildOnThisDayGroups", () => {
  it("only keeps milestone anniversaries (1, 5, 10, 20, 25 years)", () => {
    const photos = [
      photo(1, "2025-07-17T10:00:00Z"), // 1 year ago — milestone
      photo(2, "2024-07-17T10:00:00Z"), // 2 years ago — not a milestone
      photo(3, "2021-07-17T10:00:00Z"), // 5 years ago — milestone
      photo(4, "2016-07-17T10:00:00Z"), // 10 years ago — milestone
      photo(5, "2011-07-17T10:00:00Z"), // 15 years ago — not a milestone
      photo(6, "2006-07-17T10:00:00Z"), // 20 years ago — milestone
      photo(7, "2001-07-17T10:00:00Z"), // 25 years ago — milestone
      photo(8, "1999-07-17T10:00:00Z"), // 27 years ago — not a milestone
    ];
    const groups = buildOnThisDayGroups(photos, TODAY);
    expect(new Set(groups.keys())).toEqual(new Set([2025, 2021, 2016, 2006, 2001]));
  });

  it("drops a non-milestone year entirely, even with many photos", () => {
    const photos = Array.from({ length: 10 }, (_, i) =>
      photo(100 + i, "2024-07-17T10:00:00Z")
    ); // 2 years ago — not a milestone
    const groups = buildOnThisDayGroups(photos, TODAY);
    expect(groups.size).toBe(0);
  });

  it("ignores photos not taken on today's month/day", () => {
    const photos = [photo(1, "2025-07-18T10:00:00Z")];
    const groups = buildOnThisDayGroups(photos, TODAY);
    expect(groups.size).toBe(0);
  });

  it("ignores the current and future years", () => {
    const photos = [
      photo(1, "2026-07-17T10:00:00Z"),
      photo(2, "2027-07-17T10:00:00Z"),
    ];
    const groups = buildOnThisDayGroups(photos, TODAY);
    expect(groups.size).toBe(0);
  });
});
