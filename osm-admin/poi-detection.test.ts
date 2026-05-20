import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { poiReferences } from "../db/schema";
import { loadPoiReferenceEmbeddings } from "./poi-detection";

beforeEach(async () => {
  await db.delete(poiReferences);
});

// Regression guard for the `qid IN (${qids})` query in
// loadPoiReferenceEmbeddings. Drizzle's sql template expands an
// interpolated JS array into comma-separated bind params, which suits
// `IN (…)`. The original code used `ANY(${qids})`, which bound a
// scalar (single element → "malformed array literal") or emitted
// invalid SQL (multiple elements → `ANY($1, $2)`).
describe("loadPoiReferenceEmbeddings", () => {
  it("returns an empty map for an empty qid list without touching the DB", async () => {
    const result = await loadPoiReferenceEmbeddings(db, []);
    expect(result.size).toBe(0);
  });

  it("resolves a single qid (the case that threw 'malformed array literal')", async () => {
    await db.insert(poiReferences).values({
      qid: "Q41174162",
      name: "Test POI",
      name_de: "Test-POI",
    });

    const result = await loadPoiReferenceEmbeddings(db, ["Q41174162"]);
    expect(result.size).toBe(1);
    expect(result.get("Q41174162")).toEqual({
      embedding: null,
      name: "Test POI",
      nameDe: "Test-POI",
    });
  });

  it("resolves multiple qids (the case that emitted invalid `ANY($1, $2)` SQL)", async () => {
    await db.insert(poiReferences).values([
      { qid: "Q1", name: "One", name_de: null },
      { qid: "Q2", name: "Two", name_de: "Zwei" },
      { qid: "Q3", name: "Three", name_de: null },
    ]);

    const result = await loadPoiReferenceEmbeddings(db, ["Q1", "Q2", "Q3"]);
    expect(result.size).toBe(3);
    expect(result.get("Q1")?.name).toBe("One");
    expect(result.get("Q2")?.nameDe).toBe("Zwei");
    expect(result.get("Q3")?.name).toBe("Three");
  });

  it("omits qids with no matching row", async () => {
    await db.insert(poiReferences).values({ qid: "Q1", name: "One" });

    const result = await loadPoiReferenceEmbeddings(db, ["Q1", "Q-missing"]);
    expect(result.size).toBe(1);
    expect(result.has("Q1")).toBe(true);
    expect(result.has("Q-missing")).toBe(false);
  });

  it("parses a stored pgvector embedding back into a number array", async () => {
    await db.insert(poiReferences).values({ qid: "Q1", name: "One" });
    // The vector column lives outside Drizzle's typed schema (raw SQL
    // migration), so set it directly. 768 dims to match VECTOR(768).
    const vec = `[${Array.from({ length: 768 }, (_, i) => (i % 7) / 10).join(",")}]`;
    await db.execute(sql`
      UPDATE poi_references SET embedding = ${vec}::vector WHERE qid = 'Q1'
    `);

    const result = await loadPoiReferenceEmbeddings(db, ["Q1"]);
    const embedding = result.get("Q1")?.embedding;
    expect(embedding).not.toBeNull();
    expect(embedding).toHaveLength(768);
    expect(embedding?.[1]).toBeCloseTo(0.1);
  });
});
