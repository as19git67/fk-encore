import { describe, expect, it } from "vitest";
import { probePbfSizeMb } from "./pbf-probe";

function fakeFetch(
  status: number,
  headers: Record<string, string>,
): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
  })) as unknown as typeof fetch;
}

describe("probePbfSizeMb", () => {
  it("returns content-length rounded to MB", async () => {
    const fetcher = fakeFetch(200, { "content-length": "634_217_728".replace(/_/g, "") });
    const mb = await probePbfSizeMb("https://example.com/x.pbf", { fetcher });
    expect(mb).toBe(634);
  });

  it("returns null on non-2xx", async () => {
    const fetcher = fakeFetch(404, {});
    const mb = await probePbfSizeMb("https://example.com/x.pbf", { fetcher });
    expect(mb).toBeNull();
  });

  it("returns null when header is missing", async () => {
    const fetcher = fakeFetch(200, {});
    const mb = await probePbfSizeMb("https://example.com/x.pbf", { fetcher });
    expect(mb).toBeNull();
  });

  it("returns null when header is non-numeric", async () => {
    const fetcher = fakeFetch(200, { "content-length": "huge" });
    const mb = await probePbfSizeMb("https://example.com/x.pbf", { fetcher });
    expect(mb).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetcher = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const mb = await probePbfSizeMb("https://example.com/x.pbf", { fetcher });
    expect(mb).toBeNull();
  });
});
