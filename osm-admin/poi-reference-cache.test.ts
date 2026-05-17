import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { poiReferences } from "../db/schema";
import { ensurePoiReferences } from "./poi-reference-cache";

// Helper: build a fake fetch that responds with SPARQL JSON for
// known QIDs and with sitelink JSON for the wbgetentities endpoint.
function makeWikidataFetcher(
  pois: Array<{ qid: string; label: string; labelDe?: string; image?: string; dewiki?: string }>,
): typeof fetch {
  const byQid = new Map(pois.map((p) => [p.qid, p]));
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://query.wikidata.org")) {
      const body = String(init?.body ?? "");
      const match = body.match(/wd:(Q\d+)/);
      const qid = match?.[1];
      const poi = qid ? byQid.get(qid) : undefined;
      if (!poi) {
        return { ok: true, status: 200, json: async () => ({ results: { bindings: [] } }) };
      }
      const bindings: Record<string, { value: string; type: string }> = {
        item: { value: `http://www.wikidata.org/entity/${poi.qid}`, type: "uri" },
        itemLabel: { value: poi.label, type: "literal" },
      };
      if (poi.labelDe) bindings.itemLabelDe = { value: poi.labelDe, type: "literal" };
      if (poi.image) {
        bindings.image = {
          value: `http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(poi.image)}`,
          type: "uri",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: { bindings: [bindings] } }),
      };
    }
    // Sitelinks API
    const idsMatch = u.match(/ids=(Q\d+)/);
    const qid = idsMatch?.[1];
    const poi = qid ? byQid.get(qid) : undefined;
    if (!poi?.dewiki) {
      return { ok: true, status: 200, json: async () => ({ entities: { [qid ?? "X"]: {} } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        entities: {
          [poi.qid]: { sitelinks: { dewiki: { url: poi.dewiki } } },
        },
      }),
    };
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await db.delete(poiReferences);
});

describe("ensurePoiReferences", () => {
  it("creates new rows for QIDs not yet cached and returns the full set", async () => {
    const fetcher = makeWikidataFetcher([
      {
        qid: "Q161819",
        label: "Marienplatz",
        labelDe: "Marienplatz",
        image: "Marienplatz München.jpg",
        dewiki: "https://de.wikipedia.org/wiki/Marienplatz",
      },
      { qid: "Q5074", label: "Frauenkirche" },
    ]);
    const result = await ensurePoiReferences(["Q161819", "Q5074"], {
      wikidata: { fetcher },
    });
    expect(result).toHaveLength(2);
    expect(result[0].qid).toBe("Q161819");
    expect(result[0].commonsImageUrl).toContain("Marienplatz");
    expect(result[0].wikipediaUrl).toBe("https://de.wikipedia.org/wiki/Marienplatz");
    expect(result[1].commonsImageUrl).toBeNull();

    const rows = await db.select().from(poiReferences);
    expect(rows).toHaveLength(2);
  });

  it("returns cached rows without hitting wikidata again", async () => {
    await db.insert(poiReferences).values({
      qid: "Q161819",
      name: "Marienplatz",
      name_de: "Marienplatz",
      wikipedia_url: "https://de.wikipedia.org/wiki/Marienplatz",
      commons_image_url:
        "https://commons.wikimedia.org/wiki/Special:FilePath/Marienplatz%20M%C3%BCnchen.jpg?width=800",
    });
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ results: { bindings: [] } }) };
    }) as unknown as typeof fetch;
    const result = await ensurePoiReferences(["Q161819"], {
      wikidata: { fetcher },
    });
    expect(result).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it("dedupes the input list of QIDs", async () => {
    let sparqlCalls = 0;
    const fetcher = (async (url: string | URL) => {
      if (String(url).startsWith("https://query.wikidata.org")) sparqlCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            bindings: [
              {
                item: { value: "http://www.wikidata.org/entity/Q161819", type: "uri" },
                itemLabel: { value: "Marienplatz", type: "literal" },
              },
            ],
          },
          entities: { Q161819: {} },
        }),
      };
    }) as unknown as typeof fetch;
    await ensurePoiReferences(["Q161819", "Q161819", "Q161819"], {
      wikidata: { fetcher },
    });
    expect(sparqlCalls).toBe(1);
  });

  it("silently skips QIDs Wikidata cannot resolve", async () => {
    const fetcher = makeWikidataFetcher([]); // empty responder
    const result = await ensurePoiReferences(["Q99999999"], {
      wikidata: { fetcher },
    });
    expect(result).toEqual([]);
    const rows = await db.select().from(poiReferences).where(eq(poiReferences.qid, "Q99999999"));
    expect(rows).toEqual([]);
  });

  it("rejects malformed QIDs without making any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const result = await ensurePoiReferences(["not-a-qid", "QABC"], {
      wikidata: { fetcher },
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});
