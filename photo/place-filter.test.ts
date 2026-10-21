/**
 * "Fotos aus Beispielland": a place is matched by its other spellings and by the
 * coordinates inside its outline, and "die besten" orders by quality.
 * Places and coordinates are synthetic squares, not real outlines.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { photos, users } from "../db/schema";
import { placeContains, placeFromHit, type ResolvedPlace } from "./place-resolve";
import { photosInPlace } from "./place-filter";
import { listPhotosLogic } from "./photo.service";

/** A 10°×10° square from (30 N, 130 E), with a 2°×2° hole at its centre. */
const SQUARE = [[130, 30], [140, 30], [140, 40], [130, 40], [130, 30]];
const HOLE = [[134, 34], [136, 34], [136, 36], [134, 36], [134, 34]];

describe("placeFromHit", () => {
  it("takes the other spellings, never the term itself, and the outline", () => {
    const place = placeFromHit({
      category: "boundary", type: "administrative", addresstype: "country",
      boundingbox: ["30", "40", "130", "140"],
      namedetails: { name: "Pays d'exemple", "name:de": "Beispielland", "name:en": "Exampleland", "name:fr": "Pays", int_name: "Exampleland" },
      geojson: { type: "Polygon", coordinates: [SQUARE] },
    }, "beispielland");
    expect(place?.names).toEqual(["Pays d'exemple", "Exampleland"]);
    expect(place?.bbox).toEqual([30, 40, 130, 140]);
    expect(place?.polygons).toHaveLength(1);
  });

  it("keeps a city's box when there is no outline, but never a country's", () => {
    const city = placeFromHit({ category: "place", type: "city", addresstype: "city", boundingbox: ["1", "2", "3", "4"], namedetails: { name: "Musterstadt" } }, "Musterstadt");
    expect(city).toEqual({ names: [], bbox: [1, 2, 3, 4] });
    const country = placeFromHit({ category: "boundary", type: "administrative", addresstype: "country", boundingbox: ["1", "2", "3", "4"], namedetails: {} }, "x");
    expect(country?.bbox).toBeUndefined();
  });

  it("knows nothing for a hit that is not a place, or no hit", () => {
    expect(placeFromHit({ category: "amenity", type: "restaurant", namedetails: { name: "Beispiel-Grill" } }, "Beispielland")).toBeNull();
    expect(placeFromHit(undefined, "Beispielland")).toBeNull();
  });
});

describe("placeContains", () => {
  const place: ResolvedPlace = { names: [], bbox: [30, 40, 130, 140], polygons: [[SQUARE, HOLE]] };

  it("is inside the outline and outside its holes", () => {
    expect(placeContains(place, 32, 132)).toBe(true);
    expect(placeContains(place, 35, 135)).toBe(false);
    expect(placeContains(place, 45, 135)).toBe(false);
  });

  it("falls back to the box without an outline", () => {
    expect(placeContains({ names: [], bbox: [30, 40, 130, 140] }, 35, 135)).toBe(true);
    expect(placeContains({ names: [] }, 35, 135)).toBe(false);
  });
});

describe("place filter and quality order in the photo list", () => {
  let u: number;
  const ids: Record<string, number> = {};

  async function makePhoto(key: string, values: Partial<typeof photos.$inferInsert>) {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: u, filename: `place-${key}-${Math.random().toString(36).slice(2)}.jpg`, original_name: "p.jpg",
        mime_type: "image/jpeg", size: 1000, ...values,
      }).returning({ id: photos.id }),
    );
    ids[key] = row!.id;
  }

  beforeAll(async () => {
    const user = await dbInsertReturning<{ id: number }>(
      db.insert(users).values({ email: "place-filter@test.com", name: "Test", password_hash: "x" }).returning({ id: users.id }),
    );
    u = user!.id;
    // Geocoded in the native spelling, with no coordinates.
    await makePhoto("native", { location_country: "Pays d'exemple", taken_at: "2024-04-01T10:00:00Z", ai_quality_score: 0.4 });
    // Coordinates inside, but no geocoded name at all.
    await makePhoto("gps", { latitude: 32, longitude: 132, taken_at: "2024-04-02T10:00:00Z", ai_quality_score: 0.9 });
    // Inside the box, but in the hole of the outline.
    await makePhoto("hole", { latitude: 35, longitude: 135, taken_at: "2024-04-03T10:00:00Z" });
    // Elsewhere.
    await makePhoto("elsewhere", { latitude: 50, longitude: 10, location_country: "Deutschland", taken_at: "2024-04-04T10:00:00Z", ai_quality_score: 0.95 });
  });

  afterAll(async () => {
    await db.delete(photos).where(eq(photos.user_id, u));
    await db.delete(users).where(eq(users.id, u));
  });

  it("finds a place's photos by its other names and by coordinates in the outline", async () => {
    const place: ResolvedPlace = { names: ["Pays d'exemple"], bbox: [30, 40, 130, 140], polygons: [[SQUARE, HOLE]] };
    const inPlace = await photosInPlace(u, place);
    expect(inPlace).toEqual([ids.gps]);

    const res = await listPhotosLogic(u, { locationText: "Beispielland", locationNames: place.names, locationPhotoIds: inPlace });
    expect(res.photos.map((p) => p.id).sort()).toEqual([ids.native, ids.gps].sort());
  });

  it("matches the term alone when the place is unknown", async () => {
    const res = await listPhotosLogic(u, { locationText: "Deutschland" });
    expect(res.photos.map((p) => p.id)).toEqual([ids.elsewhere]);
  });

  it("filters by description, keyword, file name and shape", async () => {
    await db.update(photos).set({ description: "Tempel am Morgen", keywords: ["Reise", "Tempel"], width: 3000, height: 4000 }).where(eq(photos.id, ids.gps));
    await db.update(photos).set({ description: "   ", original_name: "tempel.jpg", width: 4000, height: 3000 }).where(eq(photos.id, ids.native));
    const byIds = async (f: Parameters<typeof listPhotosLogic>[1]) => (await listPhotosLogic(u, f)).photos.map((p) => p.id).sort();
    expect(await byIds({ hasDescription: true })).toEqual([ids.gps]);
    expect(await byIds({ hasDescription: false })).toEqual([ids.native, ids.hole, ids.elsewhere].sort());
    expect(await byIds({ keyword: "reise" })).toEqual([ids.gps]);
    expect(await byIds({ text: "tempel" })).toEqual([ids.native, ids.gps].sort());
    expect(await byIds({ orientation: "portrait" })).toEqual([ids.gps]);
    expect(await byIds({ orientation: "landscape" })).toEqual([ids.native]);
  });

  it("orders by quality, unscored last", async () => {
    const res = await listPhotosLogic(u, {}, { sortBy: "quality" });
    expect(res.photos.map((p) => p.id)).toEqual([ids.elsewhere, ids.gps, ids.native, ids.hole]);
  });
});
