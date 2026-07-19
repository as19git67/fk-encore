import { describe, expect, it } from "vitest";
import { applyExclusionsAndBackfill } from "./recaps.service";

describe("applyExclusionsAndBackfill", () => {
  it("keeps everything when there are no exclusions", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2, 3],
      reserve: [4, 5],
      excluded: new Set(),
      coverPhotoId: 1,
      targetCount: 3,
    });
    expect(r.photoIds).toEqual([1, 2, 3]);
    expect(r.reserve).toEqual([4, 5]);
    expect(r.coverPhotoId).toBe(1);
  });

  it("drops an excluded photo and backfills from the reserve", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2, 3],
      reserve: [4, 5],
      excluded: new Set([2]),
      coverPhotoId: 1,
      targetCount: 3,
    });
    expect(r.photoIds).toEqual([1, 3, 4]); // 2 removed, 4 appended
    expect(r.reserve).toEqual([5]); // 4 consumed
    expect(r.coverPhotoId).toBe(1);
  });

  it("moves the cover to the first survivor when the cover is excluded", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2, 3],
      reserve: [],
      excluded: new Set([1]),
      coverPhotoId: 1,
      targetCount: 3,
    });
    expect(r.photoIds).toEqual([2, 3]);
    expect(r.coverPhotoId).toBe(2);
  });

  it("shrinks when the reserve is exhausted", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2],
      reserve: [],
      excluded: new Set([2]),
      coverPhotoId: 1,
      targetCount: 2,
    });
    expect(r.photoIds).toEqual([1]);
    expect(r.reserve).toEqual([]);
  });

  it("never surfaces an excluded photo via the reserve", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2, 3],
      reserve: [2, 4], // 2 also excluded — must not come back
      excluded: new Set([2]),
      coverPhotoId: 3,
      targetCount: 3,
    });
    expect(r.photoIds).toEqual([1, 3, 4]);
    expect(r.reserve).toEqual([]);
    expect(r.coverPhotoId).toBe(3);
  });

  it("does not duplicate a reserve id already in the chosen set", () => {
    const r = applyExclusionsAndBackfill({
      chosen: [1, 2, 3],
      reserve: [3, 4], // 3 already shown
      excluded: new Set([1]),
      coverPhotoId: 2,
      targetCount: 3,
    });
    expect(r.photoIds).toEqual([2, 3, 4]);
    expect(r.reserve).toEqual([]);
  });
});
