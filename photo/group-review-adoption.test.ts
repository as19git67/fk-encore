import { describe, expect, it } from "vitest";
import {
  decideAdoption,
  peerVerdict,
  resolveAdoptionEnabled,
  type AdoptionMember,
} from "./group-review-adoption";

describe("peerVerdict", () => {
  it("keeps a photo nobody said anything about", () => {
    expect(peerVerdict(undefined)).toBe("keep");
    expect(peerVerdict({ hidden: 0, favorite: 0 })).toBe("keep");
  });

  it("hides a photo the peers hid", () => {
    expect(peerVerdict({ hidden: 1, favorite: 0 })).toBe("hide");
    expect(peerVerdict({ hidden: 3, favorite: 0 })).toBe("hide");
  });

  it("lets a single favorite veto the hides", () => {
    expect(peerVerdict({ hidden: 2, favorite: 1 })).toBe("keep");
  });
});

describe("decideAdoption", () => {
  const m = (photo_id: number, extra: Partial<AdoptionMember> = {}): AdoptionMember => ({
    photo_id,
    ...extra,
  });

  it("hides the members the peers hid and leaves the rest alone", () => {
    const d = decideAdoption([
      m(1),
      m(2, { peer: { hidden: 1, favorite: 0 } }),
      m(3, { peer: { hidden: 1, favorite: 0 } }),
      m(4),
    ]);
    expect(d.skipped).toBe(false);
    expect(d.hide).toEqual([2, 3]);
    expect(d.revert).toEqual([]);
    expect(d.visibleAfter).toBe(2);
  });

  it("never touches a row the user made themselves", () => {
    // The user favorited photo 2 — the peers' hide must not reach it. That
    // is what makes the mixed mode work without a per-group flag.
    const d = decideAdoption([
      m(1),
      m(2, { own: { status: "favorite", source: "user" }, peer: { hidden: 2, favorite: 0 } }),
      m(3, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.hide).toEqual([3]);
    expect(d.visibleAfter).toBe(2);
  });

  it("respects a visible tombstone from an earlier disagreement", () => {
    // The user un-hid an adopted hide once. The peers still hide it, but the
    // user's "no" stands — otherwise the next pass would undo their action.
    const d = decideAdoption([
      m(1),
      m(2, { own: { status: "visible", source: "user" }, peer: { hidden: 1, favorite: 0 } }),
      m(3, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.hide).toEqual([3]);
    expect(d.visibleAfter).toBe(2);
  });

  it("is idempotent — an already adopted hide is not written again", () => {
    const d = decideAdoption([
      m(1),
      m(2, { own: { status: "hidden", source: "adopted" }, peer: { hidden: 1, favorite: 0 } }),
      m(3),
    ]);
    expect(d.hide).toEqual([]);
    expect(d.revert).toEqual([]);
    expect(d.skipped).toBe(false);
  });

  it("reverts an adopted hide once the peers stop hiding the photo", () => {
    const d = decideAdoption([
      m(1),
      m(2, { own: { status: "hidden", source: "adopted" } }),
      m(3),
    ]);
    expect(d.revert).toEqual([2]);
    expect(d.hide).toEqual([]);
    expect(d.visibleAfter).toBe(3);
  });

  it("adopts a burst culled down to a single keeper", () => {
    // The commonest review outcome there is: three near-identical frames,
    // the reviewer keeps the good one. An earlier floor of two surviving
    // members skipped exactly these groups — the ones the feature exists
    // for — so they kept showing up as open work for everybody else.
    const d = decideAdoption([
      m(1),
      m(2, { peer: { hidden: 1, favorite: 0 } }),
      m(3, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.skipped).toBe(false);
    expect(d.hide).toEqual([2, 3]);
    expect(d.visibleAfter).toBe(1);
  });

  it("adopts a pair where the peers hid one side", () => {
    const d = decideAdoption([
      m(1),
      m(2, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.skipped).toBe(false);
    expect(d.hide).toEqual([2]);
    expect(d.visibleAfter).toBe(1);
  });

  it("refuses a verdict that would hide every member", () => {
    // Adoption may tidy a stack, never empty it. Nothing left to look at is
    // not a review result, so the group stays open.
    const d = decideAdoption([
      m(1, { peer: { hidden: 1, favorite: 0 } }),
      m(2, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.skipped).toBe(true);
    expect(d.hide).toEqual([]);
    expect(d.visibleAfter).toBe(0);
  });

  it("counts the user's own hides towards what survives", () => {
    // The user hid one member themselves and the peers hide the rest —
    // nothing would be left, so the group stays open.
    const d = decideAdoption([
      m(1, { own: { status: "hidden", source: "user" } }),
      m(2, { peer: { hidden: 1, favorite: 0 } }),
    ]);
    expect(d.skipped).toBe(true);
  });
});

describe("resolveAdoptionEnabled", () => {
  it("falls back to the user default without any album override", () => {
    expect(resolveAdoptionEnabled(true, [])).toBe(true);
    expect(resolveAdoptionEnabled(false, [])).toBe(false);
    expect(resolveAdoptionEnabled(true, [null, undefined])).toBe(true);
  });

  it("lets an explicit album override beat the user default", () => {
    expect(resolveAdoptionEnabled(true, ["off"])).toBe(false);
    expect(resolveAdoptionEnabled(false, ["on"])).toBe(true);
  });

  it("takes the safe side when albums disagree", () => {
    expect(resolveAdoptionEnabled(true, ["on", "off"])).toBe(false);
  });
});
