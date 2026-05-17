import { describe, expect, it } from "vitest";
import {
  bearingDeg,
  computeHeadingMatch,
  cosineSimilarity,
  matchPhotoToPois,
  proximityFactor,
  type MatchCandidate,
} from "./poi-matcher";

function candidate(overrides: Partial<MatchCandidate>): MatchCandidate {
  return {
    qid: "Q1",
    osmRef: "node:1",
    name: "Test",
    nameDe: null,
    lat: 48.137,
    lon: 11.575,
    distanceM: 50,
    poiEmbedding: new Array(768).fill(0.1),
    source: "osm",
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors (mapped from raw cosine 1 → 1)", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("returns 0.5 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.5, 6);
  });

  it("returns 0 for opposing vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(0, 6);
  });

  it("returns 0 for length mismatches", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("proximityFactor", () => {
  it("returns 1 at the centroid and 0.5 at 50 m", () => {
    expect(proximityFactor(0)).toBe(1);
    expect(proximityFactor(50)).toBeCloseTo(0.5, 6);
  });

  it("decays towards 0 in the far field", () => {
    expect(proximityFactor(1000)).toBeLessThan(0.05);
  });
});

describe("bearingDeg", () => {
  it("is 0° due-north and 90° due-east", () => {
    // Move 100m north
    expect(bearingDeg(48, 11, 48.001, 11)).toBeCloseTo(0, 0);
    expect(bearingDeg(48, 11, 48, 11.001)).toBeCloseTo(90, 0);
  });

  it("wraps around correctly for southern bearings", () => {
    expect(bearingDeg(48, 11, 47.999, 11)).toBeCloseTo(180, 0);
  });
});

describe("computeHeadingMatch", () => {
  it("is null when the photo carries no EXIF heading", () => {
    expect(computeHeadingMatch(null, 90)).toBeNull();
  });

  it("is 1.0 when heading matches the bearing exactly", () => {
    expect(computeHeadingMatch(90, 90)).toBeCloseTo(1, 6);
  });

  it("is 0 when heading is 180° opposed", () => {
    expect(computeHeadingMatch(0, 180)).toBeCloseTo(0, 6);
  });

  it("scales linearly across 0..180", () => {
    expect(computeHeadingMatch(45, 90)).toBeCloseTo(0.75, 2);
  });
});

describe("matchPhotoToPois", () => {
  const photoEmbedding = new Array(768).fill(0.1);

  it("picks a clear winner above threshold and margin", () => {
    const r = matchPhotoToPois({
      photoEmbedding,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({
          qid: "Q161819",
          name: "Marienplatz",
          // identical → cosine 1 → similarity 1
          poiEmbedding: photoEmbedding,
          distanceM: 30,
        }),
        candidate({
          qid: "Q5074",
          name: "Frauenkirche",
          poiEmbedding: new Array(768).fill(-0.1),
          distanceM: 150,
        }),
      ],
    });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].qid).toBe("Q161819");
    expect(r.matches[0].ambiguous).toBe(false);
  });

  it("marks all top candidates ambiguous when top-1 and top-2 are within margin", () => {
    const sameVec = new Array(768).fill(0.5);
    const r = matchPhotoToPois({
      photoEmbedding: sameVec,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({ qid: "Q1", name: "A", poiEmbedding: sameVec, distanceM: 40 }),
        candidate({ qid: "Q2", name: "B", poiEmbedding: sameVec, distanceM: 42 }),
      ],
    });
    expect(r.matches.length).toBe(2);
    expect(r.matches.every((m) => m.ambiguous)).toBe(true);
  });

  it("returns empty matches when the top score is below threshold", () => {
    // Photo and POI orthogonal in 768D: similarity = 0.5.
    // Worst-case proximity (200 m): proximity ≈ 0.2. heading not set
    // → 0.5. Score: 0.6 · 0.5 + 0.2 · 0.5 + 0.2 · 0.2 = 0.44 < 0.55.
    const photo = new Array(768).fill(0);
    photo[0] = 1;
    const poi = new Array(768).fill(0);
    poi[1] = 1; // orthogonal
    const r = matchPhotoToPois({
      photoEmbedding: photo,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({ qid: "Q1", poiEmbedding: poi, distanceM: 200 }),
      ],
    });
    expect(r.matches).toEqual([]);
    expect(r.reason).toBe("below_threshold");
  });

  it("returns no_candidates when the list is empty", () => {
    const r = matchPhotoToPois({
      photoEmbedding,
      photoHeadingDeg: null,
      photoLat: 0,
      photoLon: 0,
      candidates: [],
    });
    expect(r.reason).toBe("no_candidates");
  });

  it("skips candidates without a POI embedding and reports no_embeddings_for_candidates if none remain", () => {
    const r = matchPhotoToPois({
      photoEmbedding,
      photoHeadingDeg: null,
      photoLat: 0,
      photoLon: 0,
      candidates: [candidate({ poiEmbedding: null })],
    });
    expect(r.reason).toBe("no_embeddings_for_candidates");
  });
});
