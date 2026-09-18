/**
 * One human, two records (§3.5).
 *
 * The case this exists for: the organiser is "Max Beispiel (Ehemann)"
 * in their own household and "Max" as an account, and was offered
 * twice. Names invented.
 */

import { describe, expect, it } from "vitest";
import { samePerson } from "./same-person";

const ME = 7;

describe("samePerson", () => {
  it("knows the owner's own entry is the owner, whatever the names say", () => {
    const self = { ownerId: ME, relationKind: "self", name: "Max Beispiel" };
    expect(samePerson(self, { id: ME, name: "Max" })).toBe(true);
    expect(samePerson(self, { id: ME, name: "maxi" })).toBe(true);
  });

  it("never mistakes the owner's entry for another account", () => {
    // Two people called Max: the self entry belongs to one of them and
    // the name must not hand it to the other.
    const self = { ownerId: ME, relationKind: "self", name: "Max" };
    expect(samePerson(self, { id: 8, name: "Max" })).toBe(false);
  });

  it("falls back on the name for everybody else", () => {
    const spouse = { ownerId: ME, relationKind: "spouse", name: "Erika Beispiel" };
    expect(samePerson(spouse, { id: 8, name: "Erika Beispiel" })).toBe(true);
    expect(samePerson(spouse, { id: 8, name: "Erika" })).toBe(false);
  });

  it("does not let case or spacing decide", () => {
    const spouse = { ownerId: ME, relationKind: "spouse", name: "  Erika  Beispiel " };
    expect(samePerson(spouse, { id: 8, name: "erika beispiel" })).toBe(true);
  });

  it("recognises a planner by the full name their own household gives them", () => {
    // The second reported case: the spouse plans along as "Erika" (the
    // account) and is "Erika Beispiel (Ehefrau)" in the organiser's
    // household. Their own household's self entry says "Erika
    // Beispiel" — that is the key.
    const spouse = { ownerId: ME, relationKind: "spouse", name: "Erika Beispiel" };
    expect(samePerson(spouse, { id: 8, name: "Erika", selfName: "Erika Beispiel" })).toBe(true);
    expect(samePerson(spouse, { id: 8, name: "Erika", selfName: "Erika Muster" })).toBe(false);
    expect(samePerson(spouse, { id: 8, name: "Erika", selfName: null })).toBe(false);
  });

  it("tells two namesakes apart by their birth dates", () => {
    const spouse = {
      ownerId: ME, relationKind: "spouse", name: "Erika Beispiel", birthDate: "1986-04-03",
    };
    expect(samePerson(spouse, {
      id: 8, name: "Erika", selfName: "Erika Beispiel", selfBirthDate: "1986-04-03",
    })).toBe(true);
    expect(samePerson(spouse, {
      id: 8, name: "Erika", selfName: "Erika Beispiel", selfBirthDate: "1990-01-01",
    })).toBe(false);
    // A date missing on either side decides nothing.
    expect(samePerson(spouse, {
      id: 8, name: "Erika", selfName: "Erika Beispiel", selfBirthDate: null,
    })).toBe(true);
    expect(samePerson({ ...spouse, birthDate: null }, {
      id: 8, name: "Erika", selfName: "Erika Beispiel", selfBirthDate: "1990-01-01",
    })).toBe(true);
  });
});
