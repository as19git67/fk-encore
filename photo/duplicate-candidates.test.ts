import { describe, expect, it } from "vitest";
import { isHighConfidenceDuplicateGroup, recommendDuplicatePhoto, type DuplicateCandidateMember } from "./duplicate-candidates";

const member = (id: number, overrides: Partial<DuplicateCandidateMember> = {}): DuplicateCandidateMember => ({
  photo_id: id, similarity_score: 0.999, taken_at: "2026-01-02T03:04:05Z",
  width: 3024, height: 4032, latitude: 48.1, longitude: 11.5,
  description: "Holiday", keywords: ["Paris"], ...overrides,
});

describe("duplicate candidates", () => {
  it("requires very high visual confidence and matching metadata/albums", () => {
    const albums = new Map([[1, [4, 8]], [2, [4, 8]]]);
    expect(isHighConfidenceDuplicateGroup([member(1), member(2)], albums)).toBe(true);
    expect(isHighConfidenceDuplicateGroup([member(1), member(2, { similarity_score: 0.994 })], albums)).toBe(false);
    expect(isHighConfidenceDuplicateGroup([member(1), member(2)], new Map([[1, [4]], [2, [8]]]))).toBe(false);
    expect(isHighConfidenceDuplicateGroup([member(1), member(2, { taken_at: null })], albums)).toBe(false);
  });

  it("prefers favorite, then quality, resolution and newest record", () => {
    const candidates = [
      { photo_id: 1, curation: null, ai_quality_score: 0.9, width: 4000, height: 3000, created_at: "2026-01-01" },
      { photo_id: 2, curation: "favorite", ai_quality_score: 0.5, width: 2000, height: 1500, created_at: "2025-01-01" },
    ];
    expect(recommendDuplicatePhoto(candidates)).toBe(2);
  });
});
