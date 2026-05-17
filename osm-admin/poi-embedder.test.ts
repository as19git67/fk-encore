import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { poiReferences } from "../db/schema";
import { ensurePoiEmbeddings } from "./poi-embedder";

function makeFetcher(
  imageResponder: (url: string) => { ok: boolean; status: number; bytes?: Uint8Array },
  embedderResponder: () => { ok: boolean; status: number; embedding?: number[] },
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/dino/embed")) {
      const r = embedderResponder();
      return {
        ok: r.ok,
        status: r.status,
        json: async () => ({ embedding: r.embedding ?? [], dim: r.embedding?.length ?? 0 }),
      };
    }
    const r = imageResponder(u);
    return {
      ok: r.ok,
      status: r.status,
      arrayBuffer: async () =>
        r.bytes ? r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) : new ArrayBuffer(0),
    };
    void init;
  }) as unknown as typeof fetch;
}

const tinyImg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // fake JPEG-ish

beforeEach(async () => {
  await db.delete(poiReferences);
});

describe("ensurePoiEmbeddings", () => {
  it("embeds rows whose embedded_at is null and persists the vector", async () => {
    await db.insert(poiReferences).values({
      qid: "Q161819",
      name: "Marienplatz",
      commons_image_url: "https://example.com/m.jpg",
    });
    const vec = Array.from({ length: 768 }, (_, i) => i * 0.001);
    const fetcher = makeFetcher(
      () => ({ ok: true, status: 200, bytes: tinyImg }),
      () => ({ ok: true, status: 200, embedding: vec }),
    );

    const r = await ensurePoiEmbeddings(["Q161819"], { fetcher });
    expect(r).toEqual([{ qid: "Q161819", embedded: true }]);

    const row = (
      await db.select().from(poiReferences).where(eq(poiReferences.qid, "Q161819"))
    )[0];
    expect(row.embedded_at).not.toBeNull();

    // Pull the vector back as text and verify it's a non-empty pgvector literal.
    const raw = await db.execute(
      sql`SELECT embedding::text AS v FROM poi_references WHERE qid = 'Q161819'`,
    );
    const text = (raw.rows[0] as { v: string }).v;
    expect(text).toMatch(/^\[/);
    expect(text.length).toBeGreaterThan(100);
  });

  it("is a no-op for rows already embedded", async () => {
    await db.insert(poiReferences).values({
      qid: "Q161819",
      name: "Marienplatz",
      commons_image_url: "https://example.com/m.jpg",
      embedded_at: new Date().toISOString(),
    });
    let imageCalls = 0;
    let embedCalls = 0;
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith("/dino/embed")) embedCalls++;
      else imageCalls++;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
    }) as unknown as typeof fetch;

    const r = await ensurePoiEmbeddings(["Q161819"], { fetcher });
    expect(r).toEqual([{ qid: "Q161819", embedded: true }]);
    expect(imageCalls).toBe(0);
    expect(embedCalls).toBe(0);
  });

  it("reports invalid_qid without making any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const r = await ensurePoiEmbeddings(["not-a-qid"], { fetcher });
    expect(r).toEqual([{ qid: "not-a-qid", embedded: false, reason: "invalid_qid" }]);
    expect(called).toBe(false);
  });

  it("reports not_in_cache when the QID has no poi_references row", async () => {
    const fetcher = makeFetcher(
      () => ({ ok: true, status: 200, bytes: tinyImg }),
      () => ({ ok: true, status: 200, embedding: [] }),
    );
    const r = await ensurePoiEmbeddings(["Q99999999"], { fetcher });
    expect(r).toEqual([{ qid: "Q99999999", embedded: false, reason: "not_in_cache" }]);
  });

  it("reports no_image when the cached row has no Commons URL", async () => {
    await db.insert(poiReferences).values({ qid: "Q1", name: "X" });
    const fetcher = makeFetcher(
      () => ({ ok: true, status: 200, bytes: tinyImg }),
      () => ({ ok: true, status: 200, embedding: [] }),
    );
    const r = await ensurePoiEmbeddings(["Q1"], { fetcher });
    expect(r).toEqual([{ qid: "Q1", embedded: false, reason: "no_image" }]);
  });

  it("captures Commons fetch failures without persisting an embedding", async () => {
    await db.insert(poiReferences).values({
      qid: "Q161819",
      name: "Marienplatz",
      commons_image_url: "https://example.com/m.jpg",
    });
    const fetcher = makeFetcher(
      () => ({ ok: false, status: 404 }),
      () => ({ ok: true, status: 200, embedding: [0.1] }),
    );
    const r = await ensurePoiEmbeddings(["Q161819"], { fetcher });
    expect(r[0].embedded).toBe(false);
    expect(r[0].reason).toContain("commons HTTP 404");

    const row = (
      await db.select().from(poiReferences).where(eq(poiReferences.qid, "Q161819"))
    )[0];
    expect(row.embedded_at).toBeNull();
  });

  it("captures empty embedding_service responses", async () => {
    await db.insert(poiReferences).values({
      qid: "Q161819",
      name: "Marienplatz",
      commons_image_url: "https://example.com/m.jpg",
    });
    const fetcher = makeFetcher(
      () => ({ ok: true, status: 200, bytes: tinyImg }),
      () => ({ ok: true, status: 200, embedding: [] }),
    );
    const r = await ensurePoiEmbeddings(["Q161819"], { fetcher });
    expect(r[0].embedded).toBe(false);
    expect(r[0].reason).toContain("empty response");
  });
});
