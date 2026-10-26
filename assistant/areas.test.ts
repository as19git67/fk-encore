/**
 * The areas (assistent-wegfindung.md, stage 1): every tool of the catalog
 * has exactly one home, every tool an area names exists, and the prompt
 * sections are built from them.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import { AREAS, AREA_IDS, areaById, areasOfTools, homeOf, toolsOfArea } from "./areas/index";
import { allTools } from "./catalog";
import { areaPackage, areaRulesSection, examplesSection, otherAreasSection } from "./agent";

describe("the areas", () => {
  const catalog = allTools();
  const names = new Set(catalog.map((t) => t.name));

  it("give every tool of the catalog exactly one home", () => {
    const homes = new Map<string, string[]>();
    for (const area of AREAS) for (const name of area.tools) homes.set(name, [...(homes.get(name) ?? []), area.id]);
    for (const tool of catalog) {
      expect(homes.get(tool.name), `${tool.name} has no area`).toHaveLength(1);
    }
    for (const [name, areas] of homes) expect(areas, `${name} in ${areas.join(", ")}`).toHaveLength(1);
  });

  it("name only tools the catalog has, and borrow only tools of other areas", () => {
    for (const area of AREAS) {
      for (const name of toolsOfArea(area)) expect(names.has(name), `${area.id}: ${name}`).toBe(true);
      for (const name of area.borrows ?? []) {
        expect(homeOf(name), `${area.id} borrows ${name}`).toBeDefined();
        expect(homeOf(name), `${area.id} borrows its own ${name}`).not.toBe(area.id);
      }
    }
  });

  it("have distinct ids, a description, keywords, and at least one example each", () => {
    expect(new Set(AREA_IDS).size).toBe(AREAS.length);
    for (const area of AREAS) {
      expect(area.description.length, area.id).toBeGreaterThan(20);
      expect(area.keywords.length, area.id).toBeGreaterThan(5);
      expect(area.examples.length, area.id).toBeGreaterThan(0);
      expect(() => new RegExp(area.keywords, "iu"), area.id).not.toThrow();
    }
  });

  it("know the home of a tool and the areas behind a set of tools", () => {
    expect(homeOf("list_photos")).toBe("photos");
    expect(homeOf("tax_worksheet")).toBe("tax");
    expect(homeOf("describe_tools")).toBeUndefined();
    expect(areasOfTools(["list_meters", "list_transactions", "describe_tools", "list_transactions"])).toEqual(["finance", "meters"]);
  });

  it("render their rules, examples and the list of other areas for the prompt", () => {
    const photos = areaById("photos")!;
    expect(areaRulesSection(photos)).toMatch(/^Rules for photos:\n- Photos \(list_photos, search_photos\) appear as a grid/);
    expect(areaRulesSection(areaById("meters")!)).toBeNull();
    const examples = examplesSection([areaById("meters")!, areaById("depot")!])!;
    expect(examples.split("\n")).toHaveLength(3);
    expect(examples).toContain("1. \"Wie viel Strom haben wir letztes Jahr verbraucht?\"");
    expect(examples).toContain("2. \"Wie steht mein Depot");
    expect(otherAreasSection([areaById("trips")!])).toContain("- trips: Reisen:");
    expect(otherAreasSection([])).toBeNull();
  });

  it("describe an area's package with the tools this user may use", () => {
    const text = areaPackage(areaById("tax")!, catalog.filter((t) => t.permissions.every((p) => ["module.documents", "documents.view"].includes(p))));
    expect(text).toContain("Rules for tax:");
    expect(text).toContain("- tax_documents:");
    // list_transactions is borrowed, but this user has no finance permission.
    expect(text).not.toContain("- list_transactions:");
    expect(text).toContain("Examples of chained calls:");
    expect(areaPackage(areaById("meters")!, [])).toContain("The user may use no tool of meters.");
  });
});
