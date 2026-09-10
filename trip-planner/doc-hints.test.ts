/**
 * Reading a document for what a trip needs from it (§3.4).
 *
 * The cases that matter are the ones where reading *less* is right:
 * paperwork that is not travel paperwork, a line whose two times belong
 * to two different things, and a number that only looks like a time.
 * Every wrong reading here would end up as a proposed fixpoint, and a
 * proposed departure at the wrong hour is the one mistake §8.6 says
 * surfaces too late to fix.
 */

import { describe, expect, it } from "vitest";
import { germanDate, hardTimesIn, matchesTrip, travelRoleOf, writtenForms } from "./doc-hints";

describe("what sort of paperwork is this", () => {
  it("recognises a hotel confirmation", () => {
    expect(travelRoleOf({
      title: "Buchungsbestätigung Hotel",
      summary: "Übernachtung mit Frühstück, Check-in ab 15:00",
    })).toBe("lodging");
  });

  it("recognises a train ticket", () => {
    expect(travelRoleOf({ title: "Fahrkarte", summary: "Abfahrt 07:42, Zugbindung" }))
      .toBe("transport");
  });

  it("recognises a rental agreement", () => {
    expect(travelRoleOf({ title: "Mietwagen", summary: "Anmietung und Rückgabe" }))
      .toBe("rental");
  });

  it("recognises a booked slot", () => {
    expect(travelRoleOf({ title: "Zeitfensterticket", summary: "Einlass und Führung" }))
      .toBe("ticket");
  });

  it("says nothing about a phone bill", () => {
    expect(travelRoleOf({ title: "Rechnung Mobilfunk", summary: "Grundgebühr Juli" }))
      .toBeNull();
  });

  it("refuses to guess when two readings are equally good", () => {
    // Somebody should look at this one; a coin toss would put the wrong
    // word on the suggestion screen.
    expect(travelRoleOf({ title: "Hotel", summary: "Fahrkarte" })).toBeNull();
  });

  it("reads nothing out of an empty document", () => {
    expect(travelRoleOf({})).toBeNull();
  });
});

describe("which hard times it states", () => {
  it("reads a check-in time", () => {
    const [hint] = hardTimesIn("Check-in ab 15:00 Uhr");
    expect(hint).toMatchObject({ label: "Check-in", kind: "appointment", minutes: 15 * 60 });
    expect(hint.evidence).toContain("15:00");
  });

  it("knows a departure is not something you come back from (§4.4)", () => {
    expect(hardTimesIn("Abfahrt 17:45")[0]).toMatchObject({
      label: "Abfahrt", kind: "departure", minutes: 17 * 60 + 45,
    });
  });

  it("takes one reading per line, not two halves of two", () => {
    // "Abfahrt 07:42 Ankunft 11:03" must not become an arrival at 07:42.
    const hints = hardTimesIn("Abfahrt 07:42 Ankunft 11:03");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ label: "Abfahrt", minutes: 7 * 60 + 42 });
  });

  it("reads several lines, earliest first", () => {
    const hints = hardTimesIn("Rückgabe bis 10:00\nAbfahrt 17:45\nEinlass 19:30");
    expect(hints.map((h) => h.label)).toEqual(["Rückgabe", "Abfahrt", "Einlass"]);
  });

  it("accepts the dot German documents write, and OCR produces", () => {
    expect(hardTimesIn("Abflug 06.15")[0].minutes).toBe(6 * 60 + 15);
  });

  it("accepts a bare hour", () => {
    expect(hardTimesIn("Führung um 14 Uhr")[0].minutes).toBe(14 * 60);
  });

  it("does not read a booking reference as a time", () => {
    expect(hardTimesIn("Buchungsnummer 4711 — Abfahrt siehe Ticket")).toEqual([]);
  });

  it("does not read a time that belongs to the next sentence", () => {
    const far = `Abfahrt ${"x".repeat(80)} 17:45`;
    expect(hardTimesIn(far)).toEqual([]);
  });

  it("refuses an impossible clock", () => {
    expect(hardTimesIn("Abfahrt 27:99")).toEqual([]);
  });

  it("says nothing about a document with no times", () => {
    expect(hardTimesIn("Hotelrechnung, vielen Dank für Ihren Aufenthalt")).toEqual([]);
    expect(hardTimesIn(null)).toEqual([]);
  });

  it("mentions the same time once, however often it is printed", () => {
    expect(hardTimesIn("Abfahrt 17:45\nAbfahrt 17:45")).toHaveLength(1);
  });
});

describe("does this document belong to this trip", () => {
  const trip = { dates: ["2026-07-12", "2026-07-13"], places: ["Lissabon"] };

  it("offers a booking that names one of the trip's dates", () => {
    const match = matchesTrip(
      { title: "Hotelbuchung", summary: "Anreise am 12.07.2026" },
      trip,
    );
    expect(match?.role).toBe("lodging");
    expect(match?.reasons).toContain("nennt den 12.07.2026");
  });

  it("offers a booking that names the place, whatever its own date", () => {
    const match = matchesTrip(
      { title: "Hotelbuchung Lissabon", summary: "Übernachtung, gebucht im Januar" },
      trip,
    );
    expect(match?.reasons).toContain("nennt Lissabon");
  });

  it("leaves out a phone bill from the same week", () => {
    // Naming the date is not enough — travel paperwork it must be, or
    // the list fills with everything and nobody reads it.
    expect(matchesTrip({ title: "Rechnung Mobilfunk", summary: "12.07.2026" }, trip)).toBeNull();
  });

  it("leaves out travel paperwork for a different holiday", () => {
    expect(matchesTrip({ title: "Hotelbuchung Rom", summary: "Anreise 03.03.2027" }, trip))
      .toBeNull();
  });

  it("ignores a place name too short to mean anything", () => {
    expect(matchesTrip({ title: "Hotelbuchung", summary: "Bad" }, { dates: [], places: ["Bad"] }))
      .toBeNull();
  });

  it("knows the ways a date is written on paper", () => {
    const forms = writtenForms("2026-07-12");
    expect(forms).toContain("12.07.2026");
    expect(forms).toContain("12.07.26");
    expect(forms).toContain("12. juli 2026");
    expect(germanDate("2026-07-12")).toBe("12.07.2026");
  });
});
