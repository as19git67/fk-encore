import { describe, expect, it } from "vitest";
import {
  commonsImageUrl,
  fetchGermanWikipediaUrl,
  fetchPoi,
  nearbyPois,
} from "./wikidata-client";

function sparqlResponder(rows: object[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: { bindings: rows } }),
  })) as unknown as typeof fetch;
}

describe("nearbyPois", () => {
  it("parses a typical SPARQL response into typed records", async () => {
    const fetcher = sparqlResponder([
      {
        item: { value: "http://www.wikidata.org/entity/Q161819", type: "uri" },
        itemLabel: { value: "Marienplatz", type: "literal" },
        itemLabelDe: { value: "Marienplatz", type: "literal" },
        image: {
          value: "http://commons.wikimedia.org/wiki/Special:FilePath/Marienplatz%20M%C3%BCnchen.jpg",
          type: "uri",
        },
      },
      {
        item: { value: "http://www.wikidata.org/entity/Q5074", type: "uri" },
        itemLabel: { value: "Frauenkirche", type: "literal" },
      },
    ]);
    const pois = await nearbyPois(48.137, 11.575, { fetcher });
    expect(pois).toHaveLength(2);
    expect(pois[0].qid).toBe("Q161819");
    expect(pois[0].name).toBe("Marienplatz");
    expect(pois[0].imageFilename).toBe("Marienplatz München.jpg");
    expect(pois[1].qid).toBe("Q5074");
    expect(pois[1].imageFilename).toBeNull();
  });

  it("returns [] when the endpoint responds non-2xx (graceful degrade)", async () => {
    const fetcher = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(await nearbyPois(0, 0, { fetcher })).toEqual([]);
  });

  it("returns [] on network failure (graceful degrade)", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await nearbyPois(0, 0, { fetcher })).toEqual([]);
  });

  it("includes both center coordinate and radius in the SPARQL body", async () => {
    let receivedBody = "";
    const fetcher = (async (_url: string, init: RequestInit) => {
      receivedBody = String(init.body);
      return { ok: true, status: 200, json: async () => ({ results: { bindings: [] } }) };
    }) as unknown as typeof fetch;
    await nearbyPois(48.137, 11.575, { fetcher, radiusKm: 0.5, limit: 10 });
    expect(receivedBody).toContain("Point(11.575 48.137)");
    expect(receivedBody).toContain('wikibase:radius "0.5"');
    expect(receivedBody).toContain("LIMIT 10");
  });
});

describe("fetchPoi", () => {
  it("returns null for an invalid QID without making a request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await fetchPoi("not-a-qid", { fetcher })).toBeNull();
    expect(called).toBe(false);
  });

  it("returns the first row when the endpoint responds with data", async () => {
    const fetcher = sparqlResponder([
      {
        item: { value: "http://www.wikidata.org/entity/Q161819", type: "uri" },
        itemLabel: { value: "Marienplatz", type: "literal" },
      },
    ]);
    const p = await fetchPoi("Q161819", { fetcher });
    expect(p?.qid).toBe("Q161819");
  });
});

describe("commonsImageUrl", () => {
  it("builds a Special:FilePath URL with URL-encoded filename + width hint", () => {
    expect(commonsImageUrl("Marienplatz München.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Marienplatz%20M%C3%BCnchen.jpg?width=800",
    );
  });

  it("honours a custom width", () => {
    expect(commonsImageUrl("Test.jpg", 1600)).toContain("?width=1600");
  });

  it("strips a leading `File:` prefix that callers sometimes include", () => {
    expect(commonsImageUrl("File:Test.jpg")).toContain("Test.jpg");
    expect(commonsImageUrl("File:Test.jpg")).not.toContain("File%3A");
  });
});

describe("fetchGermanWikipediaUrl", () => {
  it("returns the dewiki sitelink URL when one exists", async () => {
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        entities: {
          Q161819: {
            sitelinks: { dewiki: { url: "https://de.wikipedia.org/wiki/Marienplatz" } },
          },
        },
      }),
    })) as unknown as typeof fetch;
    expect(await fetchGermanWikipediaUrl("Q161819", { fetcher })).toBe(
      "https://de.wikipedia.org/wiki/Marienplatz",
    );
  });

  it("returns null when the QID has no German Wikipedia entry", async () => {
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ entities: { Q1: {} } }),
    })) as unknown as typeof fetch;
    expect(await fetchGermanWikipediaUrl("Q1", { fetcher })).toBeNull();
  });

  it("returns null for an invalid QID without making a request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await fetchGermanWikipediaUrl("nonsense", { fetcher })).toBeNull();
    expect(called).toBe(false);
  });
});
