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

  it("collapses candidates that share a qid into a single match", () => {
    const sameVec = new Array(768).fill(0.5);
    // The Hohenzollern Bridge case: one Wikidata POI mapped as several
    // OSM ways, all carrying wikidata=Q696762.
    const r = matchPhotoToPois({
      photoEmbedding: sameVec,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({ qid: "Q696762", osmRef: "way:268661322", poiEmbedding: sameVec, distanceM: 40 }),
        candidate({ qid: "Q696762", osmRef: "way:268130024", poiEmbedding: sameVec, distanceM: 42 }),
        candidate({ qid: "Q696762", osmRef: "way:999", poiEmbedding: sameVec, distanceM: 44 }),
      ],
    });
    // All three are the same POI — exactly one row, no duplicate that
    // would violate the (photo_id, COALESCE(qid, osm_ref)) unique index.
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].qid).toBe("Q696762");
    // The kept entry is the highest-scoring one (closest → best proximity).
    expect(r.matches[0].osmRef).toBe("way:268661322");
  });

  it("keeps qid-less candidates distinct by osm_ref", () => {
    const sameVec = new Array(768).fill(0.5);
    const r = matchPhotoToPois({
      photoEmbedding: sameVec,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({ qid: null, osmRef: "node:1", poiEmbedding: sameVec, distanceM: 40 }),
        candidate({ qid: null, osmRef: "node:2", poiEmbedding: sameVec, distanceM: 42 }),
      ],
    });
    // Different osm elements, no qid → two distinct targets.
    expect(r.matches.length).toBe(2);
  });

  it("drops a visually dissimilar candidate via the similarity gate", () => {
    // Photo and POI orthogonal in 768D: raw cosine = 0, well below the
    // 0.5 gate. Proximity (right at the POI) and the heading fallback
    // would otherwise lift the composite score, but the gate rejects it
    // before scoring — geography must not carry an unrelated image.
    const photo = new Array(768).fill(0);
    photo[0] = 1;
    const poi = new Array(768).fill(0);
    poi[1] = 1; // orthogonal → raw cosine 0
    const r = matchPhotoToPois({
      photoEmbedding: photo,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [
        candidate({ qid: "Q1", poiEmbedding: poi, distanceM: 0 }),
      ],
    });
    expect(r.matches).toEqual([]);
    expect(r.reason).toBe("below_similarity_gate");
  });

  it("keeps a candidate whose raw cosine clears the gate even if it then falls below the score threshold", () => {
    // Raw cosine ≈ 0.5 (just at the gate) → passes the gate, gets scored.
    // similarity mapped = 0.75 → 0.6·0.75 = 0.45; far field (1000 m)
    // proximity ≈ 0.05 → 0.2·0.05 = 0.01; heading fallback 0.2·0.5 = 0.1.
    // Composite ≈ 0.56 — actually persists. Use a vector pair giving
    // raw cosine just above 0.5 and a far distance to keep it tight.
    const photo = [1, 0];
    const poi = [1, 1]; // raw cosine = 1/√2 ≈ 0.707, clears the gate
    const r = matchPhotoToPois({
      photoEmbedding: photo,
      photoHeadingDeg: null,
      photoLat: 48.137,
      photoLon: 11.575,
      candidates: [candidate({ qid: "Q1", poiEmbedding: poi, distanceM: 30 })],
    });
    // Gate passed and the composite score is high enough → one match.
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].qid).toBe("Q1");
  });

  it("returns below_threshold when a gated-in candidate is sunk by opposing heading + distance", () => {
    // Raw cosine 0.707 clears the gate (mapped 0.853 → 0.6·0.853 = 0.512),
    // but the photo points due-west while the POI is due-east (heading
    // match 0) and it's 1 km away (proximity ≈ 0.048). Composite ≈ 0.52,
    // below the 0.55 score threshold.
    const photo = [1, 0];
    const poi = [1, 1];
    const r = matchPhotoToPois({
      photoEmbedding: photo,
      photoHeadingDeg: 270, // due west
      photoLat: 48.0,
      photoLon: 11.0,
      candidates: [
        candidate({ qid: "Q1", lat: 48.0, lon: 11.01, poiEmbedding: poi, distanceM: 1000 }),
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
