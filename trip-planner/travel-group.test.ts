/**
 * Reading a travel group (§3.5).
 *
 * The cases worth pinning down are the two that pull against each
 * other: an age *is* derived, because how long a small child lasts is a
 * fact about small children — and "kürzere Wege" is *never* derived,
 * because that is a statement about a person and belongs to them.
 */

import { describe, expect, it } from "vitest";
import { ageOn, readGroup, withGroup, CHILD_UNDER_YEARS } from "./travel-group";

const CHILD = { label: "Kind A", birthDate: "2020-06-15" };
const ADULT = { label: "Erwachsene A", birthDate: "1985-03-02" };

describe("how old somebody is on a given day", () => {
  it("counts whole years", () => {
    expect(ageOn("2020-06-15", "2026-06-15")).toBe(6);
    expect(ageOn("2020-06-15", "2026-06-14")).toBe(5);
  });

  it("knows a birthday later in the year has not happened yet", () => {
    expect(ageOn("2020-12-31", "2026-01-01")).toBe(5);
  });

  it("says nothing rather than guessing", () => {
    expect(ageOn(null, "2026-06-15")).toBeNull();
    expect(ageOn("irgendwann", "2026-06-15")).toBeNull();
    expect(ageOn("2020-13-40", "2026-06-15")).toBeNull();
    expect(ageOn("2030-01-01", "2026-06-15")).toBeNull();
  });
});

describe("what the group does to the days", () => {
  it("shortens the blocks when a child is coming", () => {
    const reading = readGroup([ADULT, CHILD], "2026-07-01");

    expect(reading.group.withChildren).toBe(true);
    expect(reading.reasons[0]).toContain("Kind A");
    expect(reading.count).toBe(2);
  });

  it("counts the age at the start of the trip, not today", () => {
    // A trip planned years ahead is a trip with an older child. Two
    // dates, one child, two answers.
    const soon = readGroup([CHILD], "2026-07-01");
    const later = readGroup([CHILD], `${2020 + CHILD_UNDER_YEARS + 1}-07-01`);

    expect(soon.group.withChildren).toBe(true);
    expect(later.group.withChildren).toBeUndefined();
  });

  it("never concludes 'kürzere Wege' from an age", () => {
    // §3.5: age says how long a small child lasts; needing shorter
    // distances is a statement somebody makes about themselves.
    const reading = readGroup([{ label: "Oma", birthDate: "1944-02-02" }], "2026-07-01");

    expect(reading.group.limitedMobility).toBeUndefined();
  });

  it("takes 'kürzere Wege' as a hard limit when a person set it", () => {
    const reading = readGroup(
      [{ label: "Oma", birthDate: "1944-02-02", shortWalks: true }],
      "2026-07-01",
    );

    expect(reading.group.limitedMobility).toBe(true);
    expect(reading.reasons.join(" ")).toContain("harte Grenze");
  });

  it("says when it knows nothing rather than looking like an empty trip", () => {
    const reading = readGroup([{ label: "Jemand" }], "2026-07-01");

    expect(reading.group).toEqual({});
    expect(reading.reasons.join(" ")).toContain("Von niemandem ist ein Geburtsdatum");
  });

  it("asks for a date instead of pretending to have computed ages", () => {
    const reading = readGroup([CHILD], null);

    expect(reading.group).toEqual({});
    expect(reading.reasons.join(" ")).toContain("Ohne Reisedatum");
  });

  it("says nothing at all about a trip with nobody on it", () => {
    expect(readGroup([], "2026-07-01")).toEqual({ group: {}, reasons: [], count: 0 });
  });
});

describe("writing the group back into the trip's constraints", () => {
  it("keeps everything else the trip was asked for", () => {
    const next = withGroup({ pace: "relaxed", interests: ["barock"] }, { withChildren: true });

    expect(next.pace).toBe("relaxed");
    expect(next.interests).toEqual(["barock"]);
    expect(next.group).toEqual({ withChildren: true });
  });

  it("removes the group rather than storing a 'false' nobody said", () => {
    const next = withGroup({ pace: "relaxed", group: { withChildren: true } }, {});

    expect(next.group).toBeUndefined();
    expect("group" in next).toBe(false);
  });
});
