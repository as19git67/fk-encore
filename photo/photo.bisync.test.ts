import { Readable } from "stream";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { eq, and } from "drizzle-orm";
import db from "../db/database";
import {
  photos, photoCuration, faces, userFaceAssignments, persons,
  albums, albumPhotos, albumShares, users, roles, permissions,
  rolePermissions, userRoles,
} from "../db/schema";
import { dbFirst } from "../db/adapter";
import { UPLOAD_DIR } from "./photo.service";
import * as service from "./photo.service";
import { stopImagePool } from "./image-pool";
import { createUserLogic } from "../user/user.service";

/**
 * End-to-end **bi-sync scenario** coverage on the server side. Each `describe`
 * maps to one of the bi-sync scenarios; the iOS client-side decision logic for
 * the same scenarios lives in `ios/Tests/FKPhotosTests/BiSyncReconcileTests.swift`
 * (run by the xcode CI job), and the hash/dedup identity contract in
 * `HashContractTests.swift`.
 *
 *  S1  Foto in iOS aufgenommen → in Ordner gesynct        (upload + dedup)
 *  S2  Foto im Web hochgeladen → zu iOS gesynct            (album membership + ETag flip)
 *  S3  Foto in iOS gelöscht → verschwindet aus Web-Album   (batch remove)
 *  S4  Foto im Web ausgeblendet/gelöscht → aus iOS-Album   (removal reflected + ETag flip)
 *  S5  Favorit in iOS gesetzt/entfernt → nach Web          (tryMetadataOnlySync isFavorite)
 *  S6  Favorit im Web gesetzt/entfernt → nach iOS          (curation_status exposed on album photo)
 *  S7  iOS-Untertitel → Web-Beschreibung (one-way)         (tryMetadataOnlySync description)
 *  S8  Web-Beschreibung wird NICHT nach iOS übernommen     (description edit keeps image_data_hash stable)
 *  S9  Konflikt: iOS-Subtitle + Web-Beschreibung geändert  (device authoritative — overwrite, documented)
 */
describe("Photo bi-sync scenarios", () => {
  let user1: any;

  afterAll(async () => {
    await stopImagePool();
  });

  beforeEach(async () => {
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(rolePermissions);
    await db.delete(userRoles);
    await db.delete(users);
    await db.delete(roles);
    await db.delete(permissions);

    user1 = await createUserLogic({ email: "u1@test.com", name: "User 1", password: "pw" });

    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  });

  const imgHash = "a1".repeat(32);
  const fullHashA = "b2".repeat(32);
  const fullHashB = "c3".repeat(32);

  async function uploadWithSync(name: string, body: string, sync: service.UploadSyncMeta) {
    const stream = Readable.from(Buffer.from(body)) as any;
    const { photo } = await service.uploadPhotoStream(user1.id, stream, name, "image/jpeg", false, null, sync);
    return photo;
  }

  function rm(filename?: string | null) {
    if (!filename) return;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch { /* best effort */ }
  }

  const etagFor = async (userId: number) =>
    service.photoIndexEtag(userId, await service.getPhotoIndexFingerprint(userId), "");

  const readRow = (id: number) =>
    dbFirst<typeof photos.$inferSelect>(db.select().from(photos).where(eq(photos.id, id)));

  const readCuration = (photoId: number) =>
    dbFirst<{ status: string }>(
      db.select({ status: photoCuration.status }).from(photoCuration)
        .where(and(eq(photoCuration.user_id, user1.id), eq(photoCuration.photo_id, photoId))),
    );

  // ── S1: iOS photo → folder (upload + hash-based dedup) ─────────────────────
  describe("S1: Foto in iOS → Ordner gesynct", () => {
    it("stores the upload and the sync/check reports it as existing (no re-upload)", async () => {
      const photo = await uploadWithSync("s1.jpg", "s1-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      expect(photo.id).toBeGreaterThan(0);

      const res = await service.checkPhotoFullHashesLogic(user1.id, [fullHashA, fullHashB]);
      expect(res.existing).toContain(fullHashA);       // already on the server → skip
      expect(res.existing).not.toContain(fullHashB);   // unknown → the client uploads it
      rm(photo.filename);
    });

    it("re-uploading identical pixels dedups by image_data_hash instead of duplicating", async () => {
      const first = await uploadWithSync("s1a.jpg", "same-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      // Second upload of the same pixels must not create a second row.
      await expect(
        uploadWithSync("s1b.jpg", "same-pixels", { imageDataHash: imgHash, fullHash: fullHashB }),
      ).rejects.toThrow();

      const rows = await db.select().from(photos).where(eq(photos.image_data_hash, imgHash));
      expect(rows).toHaveLength(1);
      rm(first.filename);
    });
  });

  // ── S2: web upload → iOS (album membership becomes visible + ETag flips) ────
  describe("S2: Foto im Web → zu iOS gesynct", () => {
    it("a photo added to a synced album is exposed with its pixel hash and flips the index ETag", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Sync Album" });
      const photo = await uploadWithSync("s2.jpg", "s2-pixels", { imageDataHash: imgHash, fullHash: fullHashA });

      const before = await etagFor(user1.id);
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });
      const after = await etagFor(user1.id);
      expect(after).not.toBe(before); // iOS download would otherwise 304-skip the addition

      const details = await service.getAlbumLogic(user1.id, album.id, { includePhotos: true });
      const p = details.photos.find((x: any) => x.id === photo.id);
      expect(p).toBeDefined();
      expect(p?.image_data_hash).toBe(imgHash); // lets the client dedup / detect pixel changes
      rm(photo.filename);
    });
  });

  // ── S3: iOS deletion → server-album removal ────────────────────────────────
  describe("S3: Foto in iOS gelöscht → aus Web-Album entfernt", () => {
    it("the batch remove the client sends drops the album membership", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Deletion Album" });
      const photo = await uploadWithSync("s3.jpg", "s3-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // This is exactly what PhotoSyncService.syncAlbumDeletions POSTs once the
      // photo's source asset has left the iOS album.
      await service.batchUpdateAlbumPhotosLogic(user1.id, {
        albumIds: [album.id],
        photoIds: [photo.id],
        action: "remove",
      });

      const details = await service.getAlbumLogic(user1.id, album.id, { includePhotos: true });
      expect(details.photos.find((x: any) => x.id === photo.id)).toBeUndefined();
      // The photo itself still exists — only the album membership was removed.
      expect(await readRow(photo.id)).toBeDefined();
      rm(photo.filename);
    });
  });

  // ── S4: web album removal → iOS (removal visible + ETag flips) ──────────────
  describe("S4: Foto im Web aus Album entfernt → aus iOS-Album", () => {
    it("removing from the album flips the ETag so the iOS download reconciles it away", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Web Remove Album" });
      const photo = await uploadWithSync("s4.jpg", "s4-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      const afterAdd = await etagFor(user1.id);
      await service.batchUpdateAlbumPhotosLogic(user1.id, {
        albumIds: [album.id],
        photoIds: [photo.id],
        action: "remove",
      });
      const afterRemove = await etagFor(user1.id);
      expect(afterRemove).not.toBe(afterAdd);

      const details = await service.getAlbumLogic(user1.id, album.id, { includePhotos: true });
      expect(details.photos.find((x: any) => x.id === photo.id)).toBeUndefined();
      rm(photo.filename);
    });
  });

  // ── S5: favorite iOS → web ─────────────────────────────────────────────────
  describe("S5: Favorit in iOS gesetzt/entfernt → nach Web", () => {
    it("tryMetadataOnlySync sets and clears the server-side favorite", async () => {
      const photo = await uploadWithSync("s5.jpg", "s5-pixels", { imageDataHash: imgHash, fullHash: fullHashA });

      await service.tryMetadataOnlySync(user1.id, { imageDataHash: imgHash, fullHash: fullHashA, isFavorite: true });
      expect((await readCuration(photo.id))?.status).toBe("favorite");

      await service.tryMetadataOnlySync(user1.id, { imageDataHash: imgHash, fullHash: fullHashB, isFavorite: false });
      expect(await readCuration(photo.id)).toBeUndefined(); // un-favorited
      rm(photo.filename);
    });
  });

  // ── S6: favorite web → iOS ─────────────────────────────────────────────────
  describe("S6: Favorit im Web gesetzt → nach iOS", () => {
    it("exposes curation_status on the album photo so the iOS download can apply it", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Fav Album" });
      const photo = await uploadWithSync("s6.jpg", "s6-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Web sets the favorite.
      await service.updatePhotoCurationLogic(user1.id, photo.id, "favorite");

      const details = await service.getAlbumLogic(user1.id, album.id, { includePhotos: true });
      const p = details.photos.find((x: any) => x.id === photo.id);
      expect(p?.curation_status).toBe("favorite");
      rm(photo.filename);
    });
  });

  // ── S7: iOS subtitle → web description (one-way) ───────────────────────────
  describe("S7: iOS-Untertitel → Web-Beschreibung (one-way)", () => {
    it("tryMetadataOnlySync writes the iOS caption into the server description", async () => {
      const photo = await uploadWithSync("s7.jpg", "s7-pixels", { imageDataHash: imgHash, fullHash: fullHashA });
      expect((await readRow(photo.id))?.description ?? null).toBeNull();

      await service.tryMetadataOnlySync(user1.id, {
        imageDataHash: imgHash, fullHash: fullHashA, description: "Untertitel aus iOS",
      });
      expect((await readRow(photo.id))?.description).toBe("Untertitel aus iOS");
      rm(photo.filename);
    });
  });

  // ── S8: web description change does NOT propagate to iOS ────────────────────
  describe("S8: Web-Beschreibung wird NICHT nach iOS übernommen", () => {
    it("editing the description on the web leaves image_data_hash stable (no iOS re-download)", async () => {
      const photo = await uploadWithSync("s8.jpg", "s8-pixels", { imageDataHash: imgHash, fullHash: fullHashA });

      // Web-side description edit.
      await service.updatePhotoDescriptionLogic(user1.id, photo.id, "Nur im Web geändert");
      const row = await readRow(photo.id);
      expect(row?.description).toBe("Nur im Web geändert");
      // The pixel identity the iOS download reconcile keys on is untouched, so
      // the client never re-downloads (and never writes the caption back to a
      // camera original) — the iOS restriction holds. See the Swift-side
      // `reconcileAction` tests for the client half of this guarantee.
      expect(row?.image_data_hash).toBe(imgHash);
      rm(photo.filename);
    });
  });

  // ── S9: conflict resolution (device authoritative overwrite) ───────────────
  describe("S9: Konflikt iOS-Subtitle vs. Web-Beschreibung", () => {
    it("iOS is authoritative — a subsequent iOS sync overwrites a web-side description edit", async () => {
      const photo = await uploadWithSync("s9.jpg", "s9-pixels", { imageDataHash: imgHash, fullHash: fullHashA });

      // Both sides change the description: first the web...
      await service.updatePhotoDescriptionLogic(user1.id, photo.id, "Web-Beschreibung");
      // ...then iOS syncs its own subtitle.
      await service.tryMetadataOnlySync(user1.id, {
        imageDataHash: imgHash, fullHash: fullHashB, description: "iOS-Untertitel",
      });

      // Current behaviour: the device wins and OVERWRITES the web text (it does
      // NOT append). True append-on-conflict would need a protocol change — the
      // client would have to send its last-synced base description so the server
      // could detect a genuine two-sided edit — and is intentionally out of
      // scope for this test suite (documented gap, not a regression).
      expect((await readRow(photo.id))?.description).toBe("iOS-Untertitel");
      rm(photo.filename);
    });
  });
});
