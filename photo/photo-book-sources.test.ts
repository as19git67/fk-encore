import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import {
  albumPhotos,
  albums,
  collectionMembers,
  documentCollections,
  faces,
  photoBook,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photoPoiMatches,
  photos,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import type { BookPhoto } from "./photo-book-layout";
import {
  SUBJECT_WEIGHT_POINTS,
  cleanWeights,
  combineShares,
  keepSeriesPicks,
  setZeroShotScorer,
  weightedScore,
} from "./photo-book-subjects";
import { createPhotoBook, getPhotoBookView, rebuildPhotoBook } from "./photo-book.service";

function photo(id: number, score = 50): BookPhoto {
  return { id, takenAt: `2024-06-01 1${id % 10}:00:00`, width: 3000, height: 2000, score, city: null };
}

describe("photo book subjects", () => {
  it("moves a score by its subjects within 0..100", () => {
    const shares = { people: 1, landscape: 0, nature: 0, buildings: 0.5 };
    expect(weightedScore(50, shares, { people: 1 })).toBe(50 + SUBJECT_WEIGHT_POINTS);
    expect(weightedScore(50, shares, { people: -1, buildings: 1 })).toBe(50 - SUBJECT_WEIGHT_POINTS + SUBJECT_WEIGHT_POINTS / 2);
    expect(weightedScore(90, shares, { people: 1 })).toBe(100);
    expect(weightedScore(50, undefined, { people: 1 })).toBe(50);
    expect(cleanWeights({ people: 3, landscape: 0, nature: -0.5 })).toEqual({ people: 1, nature: -0.5 });
    expect(cleanWeights({ people: 0 })).toBeNull();
  });

  it("reads people from faces and buildings from a landmark as well as from CLIP", () => {
    expect(combineShares({ people: 0.1, buildings: 0.2 }, { recognisable: true, any: true }, false)).toMatchObject({ people: 1, buildings: 0.2 });
    expect(combineShares({ people: 0.1 }, { recognisable: false, any: true }, true)).toMatchObject({ people: 0.35, buildings: 0.7 });
    expect(combineShares(undefined, undefined, false)).toEqual({ people: 0, landscape: 0, nature: 0, buildings: 0 });
  });

  it("keeps one photo of a series: the model's pick, else the best", () => {
    const list = [photo(1, 40), photo(2, 70), photo(3, 60), photo(4), photo(5)];
    const kept = keepSeriesPicks(list, [
      { group_id: 1, photo_id: 1, picks: [1] },
      { group_id: 1, photo_id: 2, picks: [1] },
      { group_id: 2, photo_id: 3, picks: null },
      { group_id: 2, photo_id: 4, picks: null },
      { group_id: 3, photo_id: 5, picks: null }, // alone in the book: stays
      { group_id: 3, photo_id: 99, picks: null },
    ]);
    expect(kept.map((p) => p.id)).toEqual([1, 3, 5]);
  });
});

describe("photo book sources and weighting", () => {
  let user: { id: number };
  let other: { id: number };

  beforeEach(async () => {
    await db.delete(photoBook);
    await db.delete(collectionMembers);
    await db.delete(documentCollections);
    await db.delete(photoGroups);
    await db.delete(albumPhotos);
    await db.delete(albums);
    await db.delete(photoPoiMatches);
    await db.delete(faces);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(users);
    user = await createUserLogic({ email: "book-src@test.com", name: "U", password: "pw" });
    other = await createUserLogic({ email: "book-src-o@test.com", name: "O", password: "pw" });
  });

  afterEach(() => setZeroShotScorer(null));

  let seq = 0;
  async function upload(owner: number, takenAt: string, values: Partial<typeof photos.$inferInsert> = {}) {
    seq += 1;
    const p = await service.uploadPhotoLogic(owner, { data: Buffer.from([seq % 256, seq >> 8, 11]), name: `src${seq}.jpg`, mimeType: "image/jpeg" });
    await db.update(photos).set({ taken_at: takenAt, width: 3000, height: 2000, ai_quality_score: 0.5, ...values }).where(eq(photos.id, p.id));
    return p;
  }

  function bookIds(view: Awaited<ReturnType<typeof getPhotoBookView>>): number[] {
    return [...new Set(view.pages.flatMap((p) => p.slots.map((s) => s.photo_id)))].sort((a, b) => a - b);
  }

  it("keeps the photos of the weighted subject when it narrows", async () => {
    const land = [];
    const town = [];
    for (let i = 0; i < 4; i++) land.push(await upload(user.id, `2024-06-01 0${i}:00:00`));
    for (let i = 0; i < 4; i++) town.push(await upload(user.id, `2024-06-01 1${i}:00:00`));
    const landIds = new Set(land.map((p) => p.id));
    setZeroShotScorer(async (ids) => new Map(ids.map((id) => [id, landIds.has(id)
      ? { landscape: 0.9, buildings: 0.05, other: 0.05 }
      : { landscape: 0.05, buildings: 0.9, other: 0.05 }])));
    const all = [...land, ...town].map((p) => p.id);

    const moreLand = await createPhotoBook(user.id, { title: "Land", photoIds: all, maxPhotos: 4, weights: { landscape: 1 } });
    expect(bookIds(await getPhotoBookView(user.id, moreLand))).toEqual([...landIds].sort((a, b) => a - b));
    const fewerLand = await createPhotoBook(user.id, { title: "Stadt", photoIds: all, maxPhotos: 4, weights: { landscape: -1, buildings: 0.5 } });
    expect(bookIds(await getPhotoBookView(user.id, fewerLand))).toEqual(town.map((p) => p.id).sort((a, b) => a - b));

    // The weights travel with the source, so "Neu verteilen" keeps them.
    await rebuildPhotoBook(user.id, moreLand);
    expect(bookIds(await getPhotoBookView(user.id, moreLand))).toEqual([...landIds].sort((a, b) => a - b));
  });

  it("changes the narrowing of a book afterwards and keeps it for the next rebuild", async () => {
    const good = await upload(user.id, "2024-06-01 10:00:00", { ai_quality_score: 0.9 });
    const weak = await upload(user.id, "2024-06-01 11:00:00", { ai_quality_score: 0.2 });
    setZeroShotScorer(async () => new Map());
    const id = await createPhotoBook(user.id, { title: "Später", photoIds: [good.id, weak.id] });
    expect(bookIds(await getPhotoBookView(user.id, id))).toHaveLength(2);

    await rebuildPhotoBook(user.id, id, { qualityMin: 50 });
    let view = await getPhotoBookView(user.id, id);
    expect(view.source).toMatchObject({ kind: "photos", photo_ids: [good.id, weak.id], quality_min: 50 });
    expect(bookIds(view)).toEqual([good.id]);
    await rebuildPhotoBook(user.id, id);
    expect(bookIds(await getPhotoBookView(user.id, id))).toEqual([good.id]);

    // Nothing left: the book stays as it was.
    await expect(rebuildPhotoBook(user.id, id, { qualityMin: 99 })).rejects.toThrow(/no photos left/);
    view = await getPhotoBookView(user.id, id);
    expect(view.source.quality_min).toBe(50);
    expect(bookIds(view)).toEqual([good.id]);
  });

  it("builds without the embedding service, from faces alone", async () => {
    const withFace = await upload(user.id, "2024-06-01 10:00:00");
    const plain = await upload(user.id, "2024-06-01 11:00:00");
    await db.insert(faces).values({ photo_id: withFace.id, bbox: JSON.stringify({ x: 0.3, y: 0.3, width: 0.3, height: 0.3 }), embedding: "[]" });
    setZeroShotScorer(async () => new Map());
    const id = await createPhotoBook(user.id, { title: "Leute", photoIds: [withFace.id, plain.id], maxPhotos: 1, weights: { people: 1 } });
    expect(bookIds(await getPhotoBookView(user.id, id))).toEqual([withFace.id]);
  });

  it("takes only the pick of a series of near-duplicates, unless asked for all", async () => {
    const a = await upload(user.id, "2024-06-01 10:00:00", { ai_quality_score: 0.9 });
    const b = await upload(user.id, "2024-06-01 10:00:01", { ai_quality_score: 0.4 });
    const c = await upload(user.id, "2024-06-01 12:00:00");
    const [g] = await db.insert(photoGroups).values({ user_id: user.id, ai_picked_photo_ids: [b.id] }).returning();
    await db.insert(photoGroupMembers).values([{ group_id: g.id, photo_id: a.id }, { group_id: g.id, photo_id: b.id }]);

    const picks = await createPhotoBook(user.id, { title: "Serie", photoIds: [a.id, b.id, c.id] });
    expect(bookIds(await getPhotoBookView(user.id, picks))).toEqual([b.id, c.id].sort((x, y) => x - y));
    const all = await createPhotoBook(user.id, { title: "Alle", photoIds: [a.id, b.id, c.id], groupPicksOnly: false });
    expect(bookIds(await getPhotoBookView(user.id, all))).toHaveLength(3);
  });

  it("builds from a collection: its photos and its albums' photos, as far as the owner may see them", async () => {
    const own = await upload(user.id, "2024-06-01 10:00:00");
    const inAlbum = await upload(user.id, "2024-06-01 11:00:00");
    const foreign = await upload(other.id, "2024-06-01 12:00:00");
    const album = await service.createAlbumLogic(user.id, { name: "Ausflug" });
    await service.addPhotoToAlbumLogic(user.id, { albumId: album.id, photoId: inAlbum.id });
    const [col] = await db.insert(documentCollections).values({ user_id: user.id, title: "Mappe", entity_type: null }).returning();
    await db.insert(collectionMembers).values([
      { collection_id: col.id, entity_type: "photo", entity_id: own.id },
      { collection_id: col.id, entity_type: "photo", entity_id: foreign.id },
      { collection_id: col.id, entity_type: "album", entity_id: album.id },
    ]);

    const id = await createPhotoBook(user.id, { title: "Aus der Mappe", collectionId: col.id });
    const view = await getPhotoBookView(user.id, id);
    expect(view.source).toMatchObject({ kind: "collection", collection_id: col.id });
    expect(bookIds(view)).toEqual([own.id, inAlbum.id].sort((a, b) => a - b));

    // A collection the caller may not read is not a source.
    await expect(createPhotoBook(other.id, { title: "Fremd", collectionId: col.id })).rejects.toThrow(/collection not found/);

    // The basket is copied: a book made from it keeps what it held then.
    const [basket] = await db.insert(documentCollections).values({ user_id: user.id, title: "Basket", kind: "basket", entity_type: null }).returning();
    await db.insert(collectionMembers).values({ collection_id: basket.id, entity_type: "photo", entity_id: own.id });
    const fromBasket = await createPhotoBook(user.id, { title: "Basket", collectionId: basket.id });
    expect((await getPhotoBookView(user.id, fromBasket)).source).toMatchObject({ kind: "photos", photo_ids: [own.id] });

    // The book reads the collection again on rebuild.
    await db.delete(collectionMembers).where(eq(collectionMembers.entity_id, own.id));
    await rebuildPhotoBook(user.id, id);
    expect(bookIds(await getPhotoBookView(user.id, id))).toEqual([inAlbum.id]);
  });
});
