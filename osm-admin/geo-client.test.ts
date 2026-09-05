import { describe, expect, it, vi } from "vitest";
import { HttpGeoClient } from "./geo-client";

describe("HttpGeoClient replication API", () => {
  it("reads replication status through the internal Geo endpoint with a timeout", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        postgresDb: "nom_sachsen",
        initialized: false,
        sequence: null,
        timestamp: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HttpGeoClient({
      baseUrl: "http://geo:8080",
      sharedSecret: "secret",
      fetcher: fetcher as typeof fetch,
    });

    const status = await client.getReplicationStatus("nom_sachsen");

    expect(status.initialized).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      "http://geo:8080/replication/status/nom_sachsen",
      expect.objectContaining({
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("adds the long-running refresh timeout", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        postgresDb: "nom_sachsen",
        appliedDiffs: 0,
        sequence: 10,
        timestamp: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HttpGeoClient({ fetcher: fetcher as typeof fetch });

    await client.refresh("nom_sachsen", "https://download.geofabrik.de/x-latest.osm.pbf");

    expect(fetcher).toHaveBeenCalledWith(
      "http://geo:8080/refresh",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("HttpGeoClient POI search", () => {
  /**
   * The corridor search was unreachable for a while: geo understood it,
   * the planner sent it, and this client quietly dropped it on the way
   * — every corridor request arrived without an area and came back a
   * 400. Nothing noticed, because the planner's own tests use a fake
   * client and geo's tests call the search function directly.
   *
   * So this test does not assert one field. It walks the query object
   * and insists every key of it reaches the wire, which is the property
   * that was actually violated and the one that breaks again the next
   * time a search option is added.
   */
  it("forwards every field of the query to the geo service", async () => {
    let sent: Record<string, unknown> = {};
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ database: "nom_bayern", spots: [], hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HttpGeoClient({ fetcher: fetcher as typeof fetch });

    const query = {
      corridor: {
        from: { lat: 48.1, lon: 11.5 },
        to: { lat: 49.4, lon: 11.0 },
        detourBudgetM: 4000,
      },
      categories: ["museum"],
      name: "Beispielmuseum",
      limit: 25,
      offset: 50,
    };
    await client.searchPois("nom_bayern", query);

    expect(sent.database).toBe("nom_bayern");
    for (const [key, value] of Object.entries(query)) {
      expect(sent[key], `query.${key} never reached the request body`).toEqual(value);
    }
  });
});
