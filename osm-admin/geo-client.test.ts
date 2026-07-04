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
