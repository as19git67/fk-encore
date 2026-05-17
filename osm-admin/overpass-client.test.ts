import { describe, expect, it } from "vitest";
import {
  buildPoiOverpassQuery,
  crowFliesMeters,
  fetchPoiCandidates,
  parseOverpassResponse,
} from "./overpass-client";

describe("buildPoiOverpassQuery", () => {
  it("produces an Overpass-QL union of nwr clauses with the configured tag filters", () => {
    const q = buildPoiOverpassQuery(48.137, 11.575, 200);
    // Must include the JSON output mode and union wrapper
    expect(q).toContain("[out:json]");
    expect(q).toMatch(/^\[out:json\]\[timeout:25\];\s*\(/);
    expect(q).toContain(`out tags center;`);
    // Filters from poi.config — at least one tourism + historic filter
    expect(q).toContain(`["tourism"~"^(`);
    expect(q).toContain(`["historic"]`); // wildcard form
    expect(q).toContain(`(around:200,48.137000,11.575000)`);
  });

  it("rounds radius to integer and clamps to at least 1m", () => {
    expect(buildPoiOverpassQuery(0, 0, 0.4)).toContain("around:1,");
    expect(buildPoiOverpassQuery(0, 0, 500.7)).toContain("around:501,");
  });
});

describe("parseOverpassResponse", () => {
  function fixture() {
    return {
      elements: [
        {
          type: "node" as const,
          id: 1,
          lat: 48.1373,
          lon: 11.5755,
          tags: {
            name: "Marienplatz",
            "name:de": "Marienplatz",
            tourism: "attraction",
            wikidata: "Q161819",
            wikipedia: "de:Marienplatz",
          },
        },
        {
          type: "way" as const,
          id: 2,
          center: { lat: 48.1382, lon: 11.5751 },
          tags: { name: "Frauenkirche", building: "cathedral" },
        },
        {
          // Missing coordinates — must be silently dropped.
          type: "way" as const,
          id: 3,
          tags: { name: "Mystery", historic: "monument" },
        },
      ],
    };
  }

  it("converts elements, computes crow-flies distance, sorts ascending", () => {
    const c = parseOverpassResponse(fixture(), 48.137, 11.575, 25);
    expect(c).toHaveLength(2);
    expect(c[0].osmRef).toBe("node:1");
    expect(c[0].name).toBe("Marienplatz");
    expect(c[0].wikidataQid).toBe("Q161819");
    // Marienplatz is roughly 50m from the query point — definitely
    // closer than Frauenkirche (~150m).
    expect(c[0].distanceM).toBeLessThan(c[1].distanceM);
    expect(c[0].primaryTag).toBe("tourism=attraction");
    expect(c[1].primaryTag).toBe("building=cathedral");
  });

  it("honours maxCandidates by truncating after the sort", () => {
    const many = {
      elements: Array.from({ length: 30 }, (_, i) => ({
        type: "node" as const,
        id: i,
        lat: 48 + i * 0.0001,
        lon: 11,
        tags: { tourism: "attraction" },
      })),
    };
    const c = parseOverpassResponse(many, 48, 11, 5);
    expect(c).toHaveLength(5);
  });

  it("handles missing `elements` array gracefully", () => {
    expect(parseOverpassResponse({}, 0, 0, 10)).toEqual([]);
  });
});

describe("fetchPoiCandidates", () => {
  it("POSTs the query and returns parsed candidates", async () => {
    let receivedUrl = "";
    let receivedBody = "";
    const fetcher = (async (url: string | URL, init: RequestInit) => {
      receivedUrl = String(url);
      receivedBody = String(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: [
            {
              type: "node",
              id: 42,
              lat: 0,
              lon: 0,
              tags: { name: "X", tourism: "viewpoint" },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const r = await fetchPoiCandidates(
      "http://overpass-bayern/api/interpreter",
      0,
      0,
      { fetcher },
    );
    expect(receivedUrl).toBe("http://overpass-bayern/api/interpreter");
    expect(receivedBody).toContain("nwr[");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].name).toBe("X");
  });

  it("throws on non-2xx", async () => {
    const fetcher = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchPoiCandidates("http://overpass-bayern/api/interpreter", 0, 0, { fetcher }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("crowFliesMeters", () => {
  it("returns 0 for identical points", () => {
    expect(crowFliesMeters(48.137, 11.575, 48.137, 11.575)).toBeCloseTo(0, 1);
  });

  it("matches a known short distance within 5%", () => {
    // Munich Marienplatz to Frauenkirche — official ~270 m
    const d = crowFliesMeters(48.1373, 11.5755, 48.1387, 11.5736);
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(300);
  });
});
