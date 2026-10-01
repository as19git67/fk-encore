/**
 * The router client against Valhalla's wire format — what it sends,
 * how it reads the answer, and that every failure becomes null.
 */

import { describe, expect, it } from "vitest";
import { HttpRouterClient, costingFor } from "./router-client";

function fetcher(handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = await handler(u, init);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const A = { lat: 48.37, lon: 10.9 };
const B = { lat: 48.4, lon: 11.0 };

describe("HttpRouterClient", () => {
  it("names Valhalla's costing for each mode and none for transit", () => {
    expect(costingFor("car")).toBe("auto");
    expect(costingFor("bike")).toBe("bicycle");
    expect(costingFor("foot")).toBe("pedestrian");
    expect(costingFor("transit")).toBeNull();
  });

  it("reads a matrix: seconds to minutes, kilometres to metres, null where there is no way", async () => {
    const { fn, calls } = fetcher(() => ({
      sources_to_targets: [[{ time: 0, distance: 0 }, { time: 900, distance: 12.3 }],
                           [{ time: null, distance: null }, { time: 0, distance: 0 }]],
    }));
    const client = new HttpRouterClient({ baseUrl: "http://r", fetcher: fn });
    const cells = await client.matrix([A, B], [A, B], "car");
    expect(calls[0].url).toBe("http://r/sources_to_targets");
    expect(calls[0].body).toMatchObject({ costing: "auto", sources: [A, B], targets: [A, B] });
    expect(cells?.[0][1]).toEqual({ minutes: 15, distanceM: 12300 });
    expect(cells?.[1][0]).toBeNull();
  });

  it("asks nothing for transit and answers null", async () => {
    const { fn, calls } = fetcher(() => ({}));
    const client = new HttpRouterClient({ baseUrl: "http://r", fetcher: fn });
    expect(await client.matrix([A], [B], "transit")).toBeNull();
    expect(await client.route(A, B, "transit")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reads a route and its shape", async () => {
    const { fn } = fetcher(() => ({ trip: { summary: { time: 1230, length: 18.4 }, legs: [{ shape: "abc" }] } }));
    const client = new HttpRouterClient({ baseUrl: "http://r", fetcher: fn });
    expect(await client.route(A, B, "bike")).toEqual({ minutes: 21, distanceM: 18400, shape: "abc" });
  });

  it("turns a refusal or an outage into null, never a throw", async () => {
    const refusing = new HttpRouterClient({
      baseUrl: "http://r", fetcher: fetcher(() => new Response("no", { status: 400 })).fn,
    });
    expect(await refusing.route(A, B, "car")).toBeNull();
    const away = new HttpRouterClient({
      baseUrl: "http://r", fetcher: fetcher(() => { throw new TypeError("fetch failed"); }).fn,
    });
    expect(await away.matrix([A], [B], "car")).toBeNull();
    expect(await away.status()).toEqual({
      reachable: false, reason: "fetch failed", version: null, hasTiles: false, tilesBuiltAt: null,
    });
  });

  it("reads the status with the tile set's age", async () => {
    const { fn, calls } = fetcher(() => ({ version: "3.5.1", has_tiles: true, tileset_last_modified: 1758067200 }));
    const client = new HttpRouterClient({ baseUrl: "http://r", fetcher: fn });
    expect(await client.status()).toEqual({
      reachable: true, reason: null, version: "3.5.1", hasTiles: true, tilesBuiltAt: "2025-09-17T00:00:00.000Z",
    });
    expect(calls[0].url).toBe("http://r/status");
  });

  it("takes the tile set's age as proof of tiles when has_tiles is not said", async () => {
    const built = new HttpRouterClient({
      baseUrl: "http://r", fetcher: fetcher(() => ({ version: "3.5.1", tileset_last_modified: 1758067200 })).fn,
    });
    expect(await built.status()).toMatchObject({ hasTiles: true, tilesBuiltAt: "2025-09-17T00:00:00.000Z" });
    const empty = new HttpRouterClient({
      baseUrl: "http://r", fetcher: fetcher(() => ({ version: "3.5.1", tileset_last_modified: 0 })).fn,
    });
    expect(await empty.status()).toMatchObject({ hasTiles: false, tilesBuiltAt: null });
  });
});
