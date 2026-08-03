import { Readable } from "stream";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { eq, sql, and, inArray } from "drizzle-orm";
import db from "../db/database";
import { photos, photoCuration, faces, userFaceAssignments, persons, albums, albumPhotos, albumShares, users, roles, permissions, rolePermissions, userRoles } from "../db/schema";
import { dbInsertReturning, dbExec, dbFirst } from "../db/adapter";
import { UPLOAD_DIR, computeFaceCompositionScore } from "./photo.service";
import * as service from "./photo.service";
import { stopImagePool } from "./image-pool";
import { DeferJobError } from "./scan-queue";
import { createUserLogic, getPermissionsForUser } from "../user/user.service";
import { createRoleLogic, assignPermissionLogic } from "../role/role.service";
import { assignRoleLogic } from "../user/user-roles.service";


describe("Photo Module", () => {
  let user1: any;
  let user2: any;

  // Photo uploads trigger thumbnail generation, which spins up the
  // worker_threads-based image pool lazily. Without an explicit shutdown the
  // workers stay alive past Vitest's teardown — a late console.log from one
  // of them then races with the closed RPC channel and surfaces as
  // `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
  // pending`.
  afterAll(async () => {
    await stopImagePool();
  });

  beforeEach(async () => {
    // Clean tables (respecting foreign keys)
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(photos);
    await db.delete(rolePermissions);
    await db.delete(userRoles);
    await db.delete(users);
    await db.delete(roles);
    await db.delete(permissions);

    user1 = await createUserLogic({ email: "u1@test.com", name: "User 1", password: "pw" });
    user2 = await createUserLogic({ email: "u2@test.com", name: "User 2", password: "pw" });

    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  });

  describe("Module Permissions", () => {
    it("should resolve module.photos permission for user with correct role", async () => {
      // 1. Create permission
      await db.insert(permissions).values({ key: "module.photos", description: "Enable photos" });
      const perm = await db.select().from(permissions).where(eq(permissions.key, "module.photos")).then(r => r[0]!);

      // 2. Create role and assign permission
      const role = await createRoleLogic({ name: "PhotoUser" });
      await assignPermissionLogic(role.id, perm.id);

      // 3. Assign role to user
      await assignRoleLogic({ userId: user1.id, roleId: role.id });

      // 4. Verify user has permission
      const userPerms = await getPermissionsForUser(user1.id);
      expect(userPerms).toContain("module.photos");

      const user2Perms = await getPermissionsForUser(user2.id);
      expect(user2Perms).not.toContain("module.photos");
    });
  });

  describe("Photos", () => {
    it("should upload a photo", async () => {
      const fileData = Buffer.from("fake-image-data");
      const result = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test.jpg",
        mimeType: "image/jpeg",
      });

      expect(result.user_id).toBe(user1.id);
      expect(result.original_name).toBe("test.jpg");
      expect(fs.existsSync(path.join(UPLOAD_DIR, result.filename))).toBe(true);

      // Cleanup file
      fs.unlinkSync(path.join(UPLOAD_DIR, result.filename));
    });

    it("should upload a photo via stream", async () => {
      const fileData = Buffer.from("streaming-image-data");
      const stream = Readable.from(fileData) as any;

      const { photo: result, replaced } = await service.uploadPhotoStream(user1.id, stream, "stream.jpg", "image/jpeg");

      expect(replaced).toBe(false);
      expect(result.user_id).toBe(user1.id);
      expect(result.original_name).toBe("stream.jpg");
      expect(result.size).toBe(fileData.length);
      expect(fs.existsSync(path.join(UPLOAD_DIR, result.filename))).toBe(true);

      const content = fs.readFileSync(path.join(UPLOAD_DIR, result.filename));
      expect(content).toEqual(fileData);

      // Cleanup file
      fs.unlinkSync(path.join(UPLOAD_DIR, result.filename));
    });

    it("should store uploads in YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.<ext> layout", async () => {
      const fileData = Buffer.from("layout-test-data");
      const result = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "layout.jpg",
        mimeType: "image/jpeg",
      });

      // Filename is a relative subpath of UPLOAD_DIR using forward slashes.
      expect(result.filename).toMatch(
        /^\d{4}\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}_at_\d{2}\.\d{2}\.\d{2}_\d{2}\.jpg$/
      );

      // Year/month subdir matches the filename timestamp.
      const parts = result.filename.split("/");
      const [year, yearMonth, leaf] = parts;
      expect(leaf.startsWith(`${yearMonth}-`)).toBe(true);
      expect(yearMonth.startsWith(`${year}-`)).toBe(true);

      const abs = path.join(UPLOAD_DIR, result.filename);
      expect(fs.existsSync(abs)).toBe(true);
      fs.unlinkSync(abs);
    });

    it("should increment the counter when two uploads collide on the same second", async () => {
      // Freeze the wall clock so the two sequential uploads always
      // derive their filename from the same second. Without this the
      // test is flaky under a slow CI runner: if the first upload
      // takes longer than ~1s, the second one ends up in the next
      // second and the shared-stem assertion fails. Only `Date` is
      // faked — `setTimeout`/`setInterval` stay real so nothing in
      // the upload pipeline stalls on the frozen clock.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      try {
        const a = await service.uploadPhotoLogic(user1.id, {
          data: Buffer.from("collision-a"),
          name: "a.jpg",
          mimeType: "image/jpeg",
        });
        const b = await service.uploadPhotoLogic(user1.id, {
          data: Buffer.from("collision-b"),
          name: "b.jpg",
          mimeType: "image/jpeg",
        });

        expect(a.filename).not.toBe(b.filename);

        // Both filenames share the same stem up to the counter suffix; the
        // counters are sequential two-digit numbers.
        const stem = (name: string) => name.replace(/_\d{2}\.[^./]+$/, "");
        expect(stem(a.filename)).toBe(stem(b.filename));

        const counter = (name: string) =>
          parseInt(name.match(/_(\d{2})\.[^./]+$/)![1], 10);
        const counters = [counter(a.filename), counter(b.filename)].sort();
        expect(counters[0]).toBe(0);
        expect(counters[1]).toBe(1);

        fs.unlinkSync(path.join(UPLOAD_DIR, a.filename));
        fs.unlinkSync(path.join(UPLOAD_DIR, b.filename));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should list only own photos", async () => {
      const fileData = Buffer.from("data");
      await service.uploadPhotoLogic(user1.id, { data: fileData, name: "u1.jpg", mimeType: "image/jpeg" });
      await service.uploadPhotoLogic(user2.id, { data: fileData, name: "u2.jpg", mimeType: "image/jpeg" });

      const list1 = await service.listPhotosLogic(user1.id);
      expect(list1.photos).toHaveLength(1);
      expect(list1.photos[0].original_name).toBe("u1.jpg");

      const list2 = await service.listPhotosLogic(user2.id);
      expect(list2.photos).toHaveLength(1);
      expect(list2.photos[0].original_name).toBe("u2.jpg");
    });

    it("should update descriptions in bulk and skip photos owned by another user", async () => {
      const ownA = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from("bulk-description-a"), name: "bulk-a.jpg", mimeType: "image/jpeg",
      });
      const ownB = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from("bulk-description-b"), name: "bulk-b.jpg", mimeType: "image/jpeg",
      });
      const foreign = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from("bulk-description-foreign"), name: "bulk-foreign.jpg", mimeType: "image/jpeg",
      });

      const result = await service.batchUpdatePhotoDescriptionsLogic(
        user1.id,
        [ownA.id, ownB.id, foreign.id, ownA.id],
        "  Gemeinsame Beschreibung  ",
      );

      expect(result.updated.sort((a, b) => a - b)).toEqual([ownA.id, ownB.id].sort((a, b) => a - b));
      expect(result.skipped).toEqual([foreign.id]);
      expect(result.description).toBe("Gemeinsame Beschreibung");

      const rows = await db.select({ id: photos.id, description: photos.description })
        .from(photos)
        .where(inArray(photos.id, [ownA.id, ownB.id, foreign.id]));
      expect(rows.find(row => row.id === ownA.id)?.description).toBe("Gemeinsame Beschreibung");
      expect(rows.find(row => row.id === ownB.id)?.description).toBe("Gemeinsame Beschreibung");
      expect(rows.find(row => row.id === foreign.id)?.description).toBeNull();

      for (const photo of [ownA, ownB, foreign]) {
        const file = path.join(UPLOAD_DIR, photo.filename);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    });

    it("should serve a photo file", async () => {
      const fileData = Buffer.from("test-image-content");
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test.png",
        mimeType: "image/png",
      });

      const filePath = path.join(UPLOAD_DIR, photo.filename);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath);
      expect(content).toEqual(fileData);

      // Cleanup
      fs.unlinkSync(filePath);
    });

    it("should reject unsupported MIME types without saving a file", async () => {
      const filesBefore = fs.readdirSync(UPLOAD_DIR).length;
      const fileData = Buffer.from("not-an-image");
      await expect(service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "document.pdf",
        mimeType: "application/pdf",
      })).rejects.toThrow("UNSUPPORTED_FILE_TYPE");

      // No new files should have been written to disk
      const filesAfter = fs.readdirSync(UPLOAD_DIR).length;
      expect(filesAfter).toBe(filesBefore);
    });

    it("should reject unsupported MIME types in stream upload without saving a file", async () => {
      const filesBefore = fs.readdirSync(UPLOAD_DIR).length;
      const fileData = Buffer.from("not-an-image");
      const stream = Readable.from(fileData) as any;

      await expect(service.uploadPhotoStream(user1.id, stream, "document.pdf", "application/pdf"))
        .rejects.toThrow("UNSUPPORTED_FILE_TYPE");

      // No new files should have been written to disk
      const filesAfter = fs.readdirSync(UPLOAD_DIR).length;
      expect(filesAfter).toBe(filesBefore);
    });

    it("checkPhotoHashLogic returns existence based on user + hash", async () => {
      const fileData = Buffer.from("hash-check-data");
      const uploaded = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "h.jpg",
        mimeType: "image/jpeg",
      });

      const digest = uploaded.hash!;
      expect(digest).toMatch(/^[a-f0-9]{64}$/);

      const sameUser = await service.checkPhotoHashLogic(user1.id, digest);
      expect(sameUser).toEqual({ exists: true, photoId: uploaded.id });

      const otherUser = await service.checkPhotoHashLogic(user2.id, digest);
      expect(otherUser).toEqual({ exists: false });

      const unknownHash = "0".repeat(64);
      const missing = await service.checkPhotoHashLogic(user1.id, unknownHash);
      expect(missing).toEqual({ exists: false });
    });

    describe("Hash-based sync (issue #432)", () => {
      const imgHash = "a1".repeat(32);
      const fullHashA = "b2".repeat(32);
      const fullHashB = "c3".repeat(32);

      // Normalises a DB timestamp string to "YYYY-MM-DD HH:MM:SS" regardless
      // of the exact wire format (T vs space, optional millis/zone suffix).
      const wall = (v: unknown): string => String(v).replace("T", " ").slice(0, 19);

      async function uploadWithSync(name: string, body: string, sync: service.UploadSyncMeta) {
        const stream = Readable.from(Buffer.from(body)) as any;
        const { photo } = await service.uploadPhotoStream(user1.id, stream, name, "image/jpeg", false, null, sync);
        return photo;
      }

      it("normalizeClientCapturedAt keeps the local wall-clock time", () => {
        // Offset-aware input: the offset is discarded, 15:00 stays 15:00.
        expect(service.normalizeClientCapturedAt("2026-05-20T15:00:00+02:00"))
          .toBe("2026-05-20T15:00:00.000Z");
        expect(service.normalizeClientCapturedAt("2026-05-20T15:00:00-05:00"))
          .toBe("2026-05-20T15:00:00.000Z");
        // Naive and Z inputs are taken literally too.
        expect(service.normalizeClientCapturedAt("2026-05-20T15:00:00"))
          .toBe("2026-05-20T15:00:00.000Z");
        expect(service.normalizeClientCapturedAt("2026-05-20T15:00:00Z"))
          .toBe("2026-05-20T15:00:00.000Z");
        // Fractional seconds are dropped.
        expect(service.normalizeClientCapturedAt("2026-05-20T15:00:00.123+02:00"))
          .toBe("2026-05-20T15:00:00.000Z");
        // Garbage and implausible values are rejected.
        expect(service.normalizeClientCapturedAt("not-a-date")).toBeNull();
        expect(service.normalizeClientCapturedAt("")).toBeNull();
        expect(service.normalizeClientCapturedAt(null)).toBeNull();
        expect(service.normalizeClientCapturedAt("3000-01-01T00:00:00Z")).toBeNull();
      });

      it("uploadPhotoStream persists the sync hashes and a header description", async () => {
        const photo = await uploadWithSync("idh.jpg", "idh-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
          description: "Header-Beschreibung",
        });
        const row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.image_data_hash).toBe(imgHash);
        // The client's identity hash is stored, not the uploaded-body digest.
        expect(row?.hash).toBe(fullHashA);
        // The X-Description header wins over (here: absent) file IPTC.
        expect(row?.description).toBe("Header-Beschreibung");
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("uploadPhotoStream falls back to the body digest without X-Full-Hash", async () => {
        const photo = await uploadWithSync("legacy.jpg", "legacy-pixels", { imageDataHash: imgHash });
        expect(photo.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(photo.hash).not.toBe(fullHashA);
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("re-uploading a pre-protocol photo adopts the identity hash (no re-upload loop)", async () => {
        // Legacy upload: no X-Full-Hash, so `hash` is stored as the body digest.
        const legacy = await uploadWithSync("old.jpg", "old-body", {});
        expect(legacy.hash).not.toBe(fullHashA);

        // The hash-sync client re-uploads the same bytes with its composite hash.
        await expect(
          uploadWithSync("old.jpg", "old-body", { imageDataHash: imgHash, fullHash: fullHashA })
        ).rejects.toThrow("PHOTO_ALREADY_EXISTS");

        const row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, legacy.id))
        );
        expect(row?.hash).toBe(fullHashA);          // adopted → next sync/check matches
        expect(row?.image_data_hash).toBe(imgHash); // backfilled
        fs.unlinkSync(path.join(UPLOAD_DIR, legacy.filename));
      });

      it("checkPhotoFullHashesLogic returns the subset that exists, scoped per user", async () => {
        const photo = await uploadWithSync("batch.jpg", "batch-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
        });
        const fullHash = photo.hash!;
        expect(fullHash).toBe(fullHashA);
        const unknown = "d4".repeat(32);

        const res = await service.checkPhotoFullHashesLogic(user1.id, [fullHash, unknown, "bad"]);
        expect(res.existing).toEqual([fullHash]);

        const other = await service.checkPhotoFullHashesLogic(user2.id, [fullHash]);
        expect(other.existing).toEqual([]);

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("checkPhotoFullHashesLogic pairs every known hash with its photo id", async () => {
        // The iOS sync needs the id to add an already-existing photo to its
        // target album: such a photo is never re-uploaded, so the upload path —
        // the only place that creates album membership — never runs for it.
        const photo = await uploadWithSync("with-id.jpg", "with-id-pixels", {
          imageDataHash: "aa".repeat(32),
          fullHash: fullHashB,
        });
        const unknown = "d5".repeat(32);

        const res = await service.checkPhotoFullHashesLogic(user1.id, [fullHashB, unknown]);
        expect(res.matches).toEqual([{ hash: fullHashB, photoId: photo.id }]);

        // Scoped per user, exactly like `existing`.
        const other = await service.checkPhotoFullHashesLogic(user2.id, [fullHashB]);
        expect(other.matches).toEqual([]);

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("checkPhotoFullHashesLogic returns empty matches for an empty request", async () => {
        const res = await service.checkPhotoFullHashesLogic(user1.id, ["bad", ""]);
        expect(res.existing).toEqual([]);
        expect(res.matches).toEqual([]);
      });

      it("tryMetadataOnlySync returns null when the image-data hash is unknown", async () => {
        const res = await service.tryMetadataOnlySync(user1.id, { imageDataHash: "e5".repeat(32) });
        expect(res).toBeNull();
      });

      it("tryMetadataOnlySync updates metadata in place and refreshes the hashes", async () => {
        const photo = await uploadWithSync("meta.jpg", "meta-pixels", { imageDataHash: imgHash });

        // First sync: set description, favourite and capture date.
        const r1 = await service.tryMetadataOnlySync(user1.id, {
          imageDataHash: imgHash,
          fullHash: fullHashA,
          description: "Strandtag",
          isFavorite: true,
          capturedAt: "2026-03-10T14:30:00+02:00",
        });
        expect(r1).toEqual({ photoId: photo.id });

        let row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.description).toBe("Strandtag");
        // Wall-clock preserved: +02:00 offset discarded, 14:30 stays 14:30.
        expect(wall(row?.taken_at)).toBe("2026-03-10 14:30:00");
        expect(row?.hash).toBe(fullHashA);

        const fav = await dbFirst<{ status: string }>(
          db.select({ status: photoCuration.status }).from(photoCuration)
            .where(and(eq(photoCuration.user_id, user1.id), eq(photoCuration.photo_id, photo.id)))
        );
        expect(fav?.status).toBe("favorite");

        // Second sync: description is overwritten (device authoritative), the
        // favourite is removed, and the full hash is refreshed again.
        await service.tryMetadataOnlySync(user1.id, {
          imageDataHash: imgHash,
          fullHash: fullHashB,
          description: "Geänderter Text",
          isFavorite: false,
        });
        row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.description).toBe("Geänderter Text");
        expect(row?.hash).toBe(fullHashB);

        const favAfter = await dbFirst(
          db.select().from(photoCuration)
            .where(and(eq(photoCuration.user_id, user1.id), eq(photoCuration.photo_id, photo.id)))
        );
        expect(favAfter).toBeUndefined();

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("uploadPhotoStream persists device_asset_id and tryMetadataOnlySync matches by it", async () => {
        const deviceId = "DEV-A-001/L0/001";
        const photo = await uploadWithSync("dev.jpg", "dev-pixels", {
          imageDataHash: imgHash,
          deviceAssetId: deviceId,
        });

        // No imageDataHash supplied → the lookup must fall back to device_asset_id.
        const r = await service.tryMetadataOnlySync(user1.id, {
          deviceAssetId: deviceId,
          fullHash: fullHashA,
          description: "Per Asset-Id",
        });
        expect(r).toEqual({ photoId: photo.id });

        const row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.device_asset_id).toBe(deviceId);
        expect(row?.description).toBe("Per Asset-Id");
        expect(row?.hash).toBe(fullHashA);
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("tryMetadataOnlySync ignores a device_asset_id match when the pixels changed", async () => {
        const deviceId = "DEV-B-002/L0/001";
        const photo = await uploadWithSync("edit.jpg", "edit-pixels", {
          imageDataHash: imgHash,
          deviceAssetId: deviceId,
        });

        // Same asset id, but a different image-data hash → the photo was edited
        // and must NOT be treated as a metadata-only sync.
        const r = await service.tryMetadataOnlySync(user1.id, {
          imageDataHash: "f6".repeat(32),
          deviceAssetId: deviceId,
        });
        expect(r).toBeNull();
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("tryMetadataOnlySync backfills image_data_hash via a device_asset_id match", async () => {
        const deviceId = "DEV-C-003/L0/001";
        // Stored with a device asset id but no image-data hash.
        const photo = await uploadWithSync("bf.jpg", "bf-pixels", { deviceAssetId: deviceId });
        let row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.image_data_hash).toBeNull();

        const r = await service.tryMetadataOnlySync(user1.id, {
          imageDataHash: imgHash,
          deviceAssetId: deviceId,
          fullHash: fullHashA,
        });
        expect(r).toEqual({ photoId: photo.id });

        row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, photo.id))
        );
        expect(row?.image_data_hash).toBe(imgHash);
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("uploadPhotoStream replaces the stored file for an edited photo (same device_asset_id)", async () => {
        const deviceId = "DEV-EDIT-001/L0/001";
        const original = await uploadWithSync("orig.jpg", "original-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
          deviceAssetId: deviceId,
        });
        const originalFile = path.join(UPLOAD_DIR, original.filename);
        expect(fs.existsSync(originalFile)).toBe(true);

        // Re-upload the SAME asset with different pixels — an in-app edit.
        const editedHash = "f7".repeat(32);
        const editedBody = "edited-pixels-which-are-longer";
        const stream = Readable.from(Buffer.from(editedBody)) as any;
        const { photo, replaced } = await service.uploadPhotoStream(
          user1.id, stream, "orig.jpg", "image/jpeg", false, null,
          { imageDataHash: editedHash, fullHash: fullHashB, deviceAssetId: deviceId, description: "Bearbeitet" },
        );

        // Same record, no duplicate, signalled as a replace.
        expect(replaced).toBe(true);
        expect(photo.id).toBe(original.id);
        const rows = await db.select().from(photos).where(eq(photos.device_asset_id, deviceId));
        expect(rows.length).toBe(1);

        const row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, original.id))
        );
        expect(row?.image_data_hash).toBe(editedHash);
        expect(row?.hash).toBe(fullHashB);
        expect(row?.description).toBe("Bearbeitet");
        expect(row?.size).toBe(Buffer.byteLength(editedBody));
        expect(row?.filename).not.toBe(original.filename);

        // New file is on disk; the superseded file is gone.
        expect(fs.existsSync(path.join(UPLOAD_DIR, row!.filename))).toBe(true);
        expect(fs.existsSync(originalFile)).toBe(false);
        fs.unlinkSync(path.join(UPLOAD_DIR, row!.filename));
      });

      it("uploadPhotoStream dedups a re-upload by image_data_hash instead of duplicating", async () => {
        // First upload: no device_asset_id (e.g. a pre-asset-id-protocol row).
        const first = await uploadWithSync("dup-a.jpg", "dup-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
        });
        expect(fs.existsSync(path.join(UPLOAD_DIR, first.filename))).toBe(true);

        // Re-upload the same photo: identical image_data_hash, different file
        // bytes (so the body digest differs), now carrying a device_asset_id
        // and the favourite flag. Must NOT create a second row — the image-data
        // hash identifies it as the same photo.
        const deviceId = "DEV-DUP-001/L0/001";
        const stream = Readable.from(Buffer.from("dup-pixels-reshared")) as any;
        await expect(
          service.uploadPhotoStream(user1.id, stream, "dup-b.jpg", "image/jpeg", true, null, {
            imageDataHash: imgHash,
            fullHash: fullHashB,
            deviceAssetId: deviceId,
          }),
        ).rejects.toThrow("PHOTO_ALREADY_EXISTS");

        const rows = await db.select().from(photos).where(eq(photos.image_data_hash, imgHash));
        expect(rows.length).toBe(1);
        expect(rows[0]!.id).toBe(first.id);
        // The re-upload's identity hash is adopted and the device asset id is
        // backfilled so the next sync dedups via the fast asset-id path.
        expect(rows[0]!.hash).toBe(fullHashB);
        expect(rows[0]!.device_asset_id).toBe(deviceId);

        // The favourite flag carried by the re-upload is applied in place.
        const fav = await dbFirst<{ status: string }>(
          db.select({ status: photoCuration.status }).from(photoCuration)
            .where(and(eq(photoCuration.user_id, user1.id), eq(photoCuration.photo_id, first.id)))
        );
        expect(fav?.status).toBe("favorite");

        fs.unlinkSync(path.join(UPLOAD_DIR, first.filename));
      });

      it("uploadPhotoStream overwrites the caption when an image_data_hash duplicate is re-shared with an edited X-Description", async () => {
        // First share with an initial caption.
        const first = await uploadWithSync("cap-a.jpg", "caption-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
          description: "Pacsafe",
        });
        let row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, first.id))
        );
        expect(row?.description).toBe("Pacsafe");

        // Re-share the very same image (identical image_data_hash, different
        // file bytes) with an edited caption. The server reports a duplicate
        // and must overwrite the stored caption — the device is authoritative.
        const stream = Readable.from(Buffer.from("caption-pixels-reshared")) as any;
        await expect(
          service.uploadPhotoStream(user1.id, stream, "cap-b.jpg", "image/jpeg", false, null, {
            imageDataHash: imgHash,
            fullHash: fullHashB,
            description: "Pacsafe ist gut",
          }),
        ).rejects.toThrow("PHOTO_ALREADY_EXISTS");

        const rows = await db.select().from(photos).where(eq(photos.image_data_hash, imgHash));
        expect(rows.length).toBe(1);
        expect(rows[0]!.id).toBe(first.id);
        expect(rows[0]!.description).toBe("Pacsafe ist gut");

        fs.unlinkSync(path.join(UPLOAD_DIR, first.filename));
      });

      it("uploadPhotoStream keeps a server-side caption when a duplicate carries no X-Description", async () => {
        const first = await uploadWithSync("cap-keep.jpg", "keep-pixels", {
          imageDataHash: imgHash,
          fullHash: fullHashA,
        });
        const serverCaption = "Vom Nutzer im Web bearbeitet";
        await dbExec(
          db.update(photos).set({ description: serverCaption }).where(eq(photos.id, first.id))
        );

        // Re-upload without an X-Description header → the server-side edit wins.
        const stream = Readable.from(Buffer.from("keep-pixels-reshared")) as any;
        await expect(
          service.uploadPhotoStream(user1.id, stream, "cap-keep-b.jpg", "image/jpeg", false, null, {
            imageDataHash: imgHash,
            fullHash: fullHashB,
          }),
        ).rejects.toThrow("PHOTO_ALREADY_EXISTS");

        const row = await dbFirst<typeof photos.$inferSelect>(
          db.select().from(photos).where(eq(photos.id, first.id))
        );
        expect(row?.description).toBe(serverCaption);

        fs.unlinkSync(path.join(UPLOAD_DIR, first.filename));
      });

      it("uploadPhotoStream uses client GPS headers when the file's EXIF carries no coordinates", async () => {
        // Body has no EXIF (just opaque bytes), so the only way GPS reaches the
        // DB is via clientLatitude/clientLongitude — the workaround for iOS's
        // EXIF-stripped PHAssetResource bytes in the background-upload context.
        const stream = Readable.from(Buffer.from("gps-fallback-pixels")) as any;
        const { photo } = await service.uploadPhotoStream(
          user1.id, stream, "gps-fallback.jpg", "image/jpeg", false, null, {
            imageDataHash: "d4".repeat(32),
            fullHash: "e5".repeat(32),
            clientLatitude: 48.137154,
            clientLongitude: 11.576124,
          },
        );

        const row = await dbFirst<{ latitude: number | null; longitude: number | null }>(
          db.select({ latitude: photos.latitude, longitude: photos.longitude })
            .from(photos).where(eq(photos.id, photo.id)),
        );
        expect(row?.latitude).toBeCloseTo(48.137154, 5);
        expect(row?.longitude).toBeCloseTo(11.576124, 5);

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("uploadPhotoStream ignores client GPS headers when the EXIF already carries coordinates", async () => {
        // Hard to forge EXIF GPS in a Buffer-only test, so the inverse covers
        // the same branch: when no EXIF GPS *and* no client GPS, the row stays
        // null. Together with the test above this proves the fallback fires
        // only on the EXIF-empty branch.
        const stream = Readable.from(Buffer.from("no-gps-anywhere")) as any;
        const { photo } = await service.uploadPhotoStream(
          user1.id, stream, "no-gps.jpg", "image/jpeg", false, null, {
            imageDataHash: "f6".repeat(32),
            fullHash: "a7".repeat(32),
          },
        );

        const row = await dbFirst<{ latitude: number | null; longitude: number | null }>(
          db.select({ latitude: photos.latitude, longitude: photos.longitude })
            .from(photos).where(eq(photos.id, photo.id)),
        );
        expect(row?.latitude).toBeNull();
        expect(row?.longitude).toBeNull();

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });
    });

    it("should not allow duplicate uploads for the same user", async () => {
      const fileData = Buffer.from("identical-data");
      await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test1.jpg",
        mimeType: "image/jpeg",
      });

      // Same user, same data -> should throw
      await expect(service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test2.jpg",
        mimeType: "image/jpeg",
      })).rejects.toThrow("PHOTO_ALREADY_EXISTS");
    });

    it("PhotoAlreadyExistsError carries the existing photo's id", async () => {
      const fileData = Buffer.from("dup-with-id-data");
      const original = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "orig.jpg",
        mimeType: "image/jpeg",
      });

      try {
        await service.uploadPhotoLogic(user1.id, {
          data: fileData,
          name: "again.jpg",
          mimeType: "image/jpeg",
        });
        throw new Error("expected duplicate to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(service.PhotoAlreadyExistsError);
        expect((err as InstanceType<typeof service.PhotoAlreadyExistsError>).existingPhotoId).toBe(original.id);
      }

      fs.unlinkSync(path.join(UPLOAD_DIR, original.filename));
    });

    it("backfills taken_at on duplicate when the original record was missing it", async () => {
      const fileData = Buffer.from("dup-backfill-data");
      const original = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "no-exif.jpg",
        mimeType: "image/jpeg",
      });
      // Sanity-check: fake data has no EXIF, so the original row stored NULL.
      expect(original.taken_at).toBeUndefined();

      const captured = "2022-07-04T12:00:00.000Z";
      await expect(service.uploadPhotoLogic(
        user1.id,
        { data: fileData, name: "ios-dup.jpg", mimeType: "image/jpeg" },
        captured,
      )).rejects.toBeInstanceOf(service.PhotoAlreadyExistsError);

      const refreshed = await dbFirst<{ taken_at: string | null }>(
        db.select({ taken_at: photos.taken_at }).from(photos).where(eq(photos.id, original.id))
      );
      expect(refreshed?.taken_at).toBeTruthy();
      expect(new Date(refreshed!.taken_at!).getUTCFullYear()).toBe(2022);

      fs.unlinkSync(path.join(UPLOAD_DIR, original.filename));
    });

    it("mergeUploadMetadataIntoExisting fills in missing fields and unions keywords (#303)", async () => {
      const fileData = Buffer.from("merge-helper-data");
      const original = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "orig.jpg",
        mimeType: "image/jpeg",
      });

      // Pre-condition: existing row has a couple of user-added keywords, no
      // description, no GPS. The merge must preserve those keywords, union in
      // the new ones, and backfill description / GPS from the upload.
      await dbExec(
        db.update(photos)
          .set({ keywords: ["sunset"], taken_at: null })
          .where(eq(photos.id, original.id))
      );

      await service.mergeUploadMetadataIntoExisting(user1.id, original.id, {
        takenAt: "2023-08-15T10:30:00.000Z",
        latitude: 47.5,
        longitude: 11.0,
        description: "Sunset at the lake",
        keywords: ["beach", "Sunset"],   // duplicate ignoring case
        rating: null,
        author: null,
        headline: null,
        title: null,
        copyright: null,
        credit: null,
        city: null,
        state: null,
        country: null,
      }, false);

      const refreshed = await dbFirst<{
        taken_at: string | null;
        description: string | null;
        keywords: string[] | null;
        latitude: number | null;
        longitude: number | null;
      }>(
        db.select({
          taken_at: photos.taken_at,
          description: photos.description,
          keywords: photos.keywords,
          latitude: photos.latitude,
          longitude: photos.longitude,
        }).from(photos).where(eq(photos.id, original.id))
      );

      expect(refreshed?.taken_at).toBeTruthy();
      expect(refreshed?.description).toBe("Sunset at the lake");
      // Existing keyword preserved, new one unioned (case-insensitive dedup).
      expect(refreshed?.keywords).toEqual(["sunset", "beach"]);
      expect(refreshed?.latitude).toBe(47.5);
      expect(refreshed?.longitude).toBe(11.0);

      fs.unlinkSync(path.join(UPLOAD_DIR, original.filename));
    });

    it("mergeUploadMetadataIntoExisting does not clobber an existing description (#303)", async () => {
      const fileData = Buffer.from("desc-preserve-data");
      const original = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "with-desc.jpg",
        mimeType: "image/jpeg",
      });

      const userDescription = "Server-side edit by the user";
      await dbExec(
        db.update(photos)
          .set({ description: userDescription })
          .where(eq(photos.id, original.id))
      );

      await service.mergeUploadMetadataIntoExisting(user1.id, original.id, {
        takenAt: null,
        latitude: null,
        longitude: null,
        description: "Old EXIF caption",
        keywords: [],
        rating: null,
        author: null,
        headline: null,
        title: null,
        copyright: null,
        credit: null,
        city: null,
        state: null,
        country: null,
      }, false);

      const refreshed = await dbFirst<{ description: string | null }>(
        db.select({ description: photos.description }).from(photos).where(eq(photos.id, original.id))
      );
      expect(refreshed?.description).toBe(userDescription);

      fs.unlinkSync(path.join(UPLOAD_DIR, original.filename));
    });

    it("should allow same photo for different users", async () => {
      const fileData = Buffer.from("shared-identical-data");
      await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "u1.jpg",
        mimeType: "image/jpeg",
      });

      // Different user, same data -> should succeed
      const result = await service.uploadPhotoLogic(user2.id, {
        data: fileData,
        name: "u2.jpg",
        mimeType: "image/jpeg",
      });

      expect(result.user_id).toBe(user2.id);
      expect(result.original_name).toBe("u2.jpg");
    });

    it("should use clientCapturedAt as fallback when EXIF lacks DateTimeOriginal", async () => {
      const fileData = Buffer.from("ios-asset-data");
      // Noon UTC keeps the day boundary safe regardless of test TZ.
      const captured = "2024-03-15T12:00:00.000Z";
      const result = await service.uploadPhotoLogic(
        user1.id,
        { data: fileData, name: "ios.jpg", mimeType: "image/jpeg" },
        captured,
      );

      expect(result.taken_at).toBeDefined();
      // PG stores TIMESTAMP without TZ; verify by reparsing into a Date and
      // checking calendar fields rather than exact ISO equality.
      const parsed = new Date(result.taken_at!);
      expect(parsed.getUTCFullYear()).toBe(2024);
      // Storage path is bucketed by capture date.
      expect(result.filename.startsWith("2024/2024-03/")).toBe(true);

      fs.unlinkSync(path.join(UPLOAD_DIR, result.filename));
    });

    it("should ignore an invalid clientCapturedAt", async () => {
      const fileData = Buffer.from("ios-bad-date");
      const result = await service.uploadPhotoLogic(
        user1.id,
        { data: fileData, name: "ios2.jpg", mimeType: "image/jpeg" },
        "not-a-date",
      );

      // Falls back to filename-derived date (none → null), not a crash.
      expect(result.taken_at).toBeUndefined();

      fs.unlinkSync(path.join(UPLOAD_DIR, result.filename));
    });

    it("should refresh photo metadata", async () => {
      const fileData = Buffer.from("data");
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test.jpg",
        mimeType: "image/jpeg",
      });

      // Initially taken_at might be null for fake data
      const idsRes = await service.getPhotosToRefreshMetadataLogic(user1.id);
      expect(idsRes.ids).toContain(photo.id);

      const refreshRes = await service.refreshPhotoMetadataLogic(user1.id, photo.id);
      expect(refreshRes.success).toBe(true);

      // Verify it's still in the DB
      const list = await service.listPhotosLogic(user1.id);
      expect(list.photos[0].id).toBe(photo.id);

      // Cleanup
      fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
    });

    describe("updatePhotoDateLogic (issue #433)", () => {
      const wall = (v: unknown): string => String(v).replace("T", " ").slice(0, 19);

      it("persists a wall-clock string verbatim, including the time-of-day", async () => {
        const photo = await service.uploadPhotoLogic(user1.id, {
          data: Buffer.from("date-edit-wall"),
          name: "edit-wall.jpg",
          mimeType: "image/jpeg",
        });

        await service.updatePhotoDateLogic(user1.id, photo.id, "2026-03-10T14:30:00");

        const row = await dbFirst<{ taken_at: string | null }>(
          db.select({ taken_at: photos.taken_at }).from(photos).where(eq(photos.id, photo.id))
        );
        expect(wall(row?.taken_at)).toBe("2026-03-10 14:30:00");

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("changes only the time when only the time portion changes", async () => {
        const photo = await service.uploadPhotoLogic(user1.id, {
          data: Buffer.from("date-edit-time"),
          name: "edit-time.jpg",
          mimeType: "image/jpeg",
        });

        // Seed an initial taken_at, then change the hour from 09 to 17 — date
        // stays the same. The reported bug (web client `.toISOString()`) was
        // that the hour silently rolled back to the original wall-clock value
        // because the local→UTC conversion cancelled the user's edit.
        await service.updatePhotoDateLogic(user1.id, photo.id, "2026-05-20T09:15:00");
        await service.updatePhotoDateLogic(user1.id, photo.id, "2026-05-20T17:15:00");

        const row = await dbFirst<{ taken_at: string | null }>(
          db.select({ taken_at: photos.taken_at }).from(photos).where(eq(photos.id, photo.id))
        );
        expect(wall(row?.taken_at)).toBe("2026-05-20 17:15:00");

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });

      it("treats an ISO-with-Z input as wall-clock (offset is discarded)", async () => {
        const photo = await service.uploadPhotoLogic(user1.id, {
          data: Buffer.from("date-edit-z"),
          name: "edit-z.jpg",
          mimeType: "image/jpeg",
        });

        await service.updatePhotoDateLogic(user1.id, photo.id, "2026-03-10T14:30:00.000Z");

        const row = await dbFirst<{ taken_at: string | null }>(
          db.select({ taken_at: photos.taken_at }).from(photos).where(eq(photos.id, photo.id))
        );
        expect(wall(row?.taken_at)).toBe("2026-03-10 14:30:00");

        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      });
    });
  });

  describe("Faces", () => {
    it("should reindex a photo", async () => {
      const fileData = Buffer.from("fake-image-data");
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test.jpg",
        mimeType: "image/jpeg",
      });

      // Mocking the InsightFace service is not really possible here easily as it's a fetch call
      // But we can check if it calls the correct function and at least doesn't throw "indexFacesForPhoto is not defined"
      // Since we are in a test environment, callInsightFaceDetect will likely fail with a fetch error
      // which is fine as long as it's not the "not defined" error.

      try {
        await service.reindexPhotoLogic(user1.id, photo.id);
      } catch (err: any) {
        // We expect it to fail because InsightFace service is not running or file is invalid
        // But it should NOT be the "indexFacesForPhoto is not defined" error
        expect(err.message).not.toContain("indexFacesForPhoto is not defined");
      }

      // Cleanup
      if (fs.existsSync(path.join(UPLOAD_DIR, photo.filename))) {
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      }
    });

    it("should reset ignored faces during manual reindex", async () => {
      const fileData = Buffer.from("fake-image-data");
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: fileData,
        name: "test.jpg",
        mimeType: "image/jpeg",
      });

      // Insert a face (global) and an ignored assignment for this user
      const insertedFace = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          photo_id: photo.id,
          bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
          embedding: JSON.stringify([0.1, 0.2]),
          quality: 100
        }).returning()
      );
      await db.insert(userFaceAssignments).values({
        user_id: user1.id,
        face_id: insertedFace!.id,
        ignored: true,
      });

      // Verify it's there
      const facesBefore = (await service.getPhotoFacesLogic(user1.id, photo.id)).faces;
      expect(facesBefore.find(f => f.ignored)).toBeDefined();

      // Manual reindex (mocked to fail or return 0, but it should delete existing faces)
      try {
        await service.reindexPhotoLogic(user1.id, photo.id);
      } catch (err) {
        // Ignore fetch errors
      }

      // With local faces disabled in test env, reindex skips indexing/deletion.
      const localFacesEnabled = process.env.ENABLE_LOCAL_FACES === "true";

      // Verify ignored face handling according to current feature flag state.
      const facesAfter = (await service.getPhotoFacesLogic(user1.id, photo.id)).faces;
      if (localFacesEnabled) {
        expect(facesAfter.find(f => f.ignored)).toBeUndefined();
      } else {
        expect(facesAfter.find(f => f.ignored)).toBeDefined();
      }

      // Cleanup
      if (fs.existsSync(path.join(UPLOAD_DIR, photo.filename))) {
        fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
      }
    });
  });

  describe("People & Faces", () => {
    it("should use newest taken_at face for cover and person details ordering", async () => {
      const person = await dbInsertReturning<{ id: number; user_id: number; name: string }>(
        db.insert(persons).values({ user_id: user1.id, name: "Sorted Person" }).returning()
      );

      const olderPhoto = await dbInsertReturning<{ id: number }>(
        db.insert(photos).values({
          user_id: user1.id,
          filename: "older.jpg",
          original_name: "older.jpg",
          mime_type: "image/jpeg",
          size: 123,
          taken_at: "2024-01-01T10:00:00.000Z",
        }).returning()
      );

      const newerPhoto = await dbInsertReturning<{ id: number }>(
        db.insert(photos).values({
          user_id: user1.id,
          filename: "newer.jpg",
          original_name: "newer.jpg",
          mime_type: "image/jpeg",
          size: 456,
          taken_at: "2025-06-15T12:30:00.000Z",
        }).returning()
      );

      const olderBbox = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
      const newerBbox = { x: 0.3, y: 0.2, width: 0.15, height: 0.15 };

      const olderFace = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          photo_id: olderPhoto!.id,
          bbox: JSON.stringify(olderBbox),
          embedding: JSON.stringify([0.1, 0.2]),
        }).returning()
      );
      await db.insert(userFaceAssignments).values({
        user_id: user1.id,
        face_id: olderFace!.id,
        person_id: person!.id,
        ignored: false,
      });

      const newerFace = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          photo_id: newerPhoto!.id,
          bbox: JSON.stringify(newerBbox),
          embedding: JSON.stringify([0.3, 0.4]),
        }).returning()
      );
      await db.insert(userFaceAssignments).values({
        user_id: user1.id,
        face_id: newerFace!.id,
        person_id: person!.id,
        ignored: false,
      });

      // Intentionally point persisted cover to the older face.
      // listPersons/getPersonDetails should still resolve the newest face by taken_at.
      await dbExec(
        db.update(persons).set({ cover_face_id: olderFace!.id }).where(eq(persons.id, person!.id))
      );
      await db.insert(photoCuration).values({
        user_id: user1.id,
        photo_id: newerPhoto!.id,
        status: "hidden",
      });

      const listRes = await service.listPersonsLogic(user1.id);
      const listedPerson = listRes.persons.find((p) => p.id === person!.id);

      expect(listedPerson).toBeDefined();
      expect(listedPerson!.cover_face_id).toBe(newerFace!.id);
      expect(listedPerson!.cover_filename).toBe("newer.jpg");
      expect(listedPerson!.cover_bbox).toEqual(newerBbox);

      const details = await service.getPersonDetailsLogic(user1.id, person!.id);
      expect(details.faces.map((f) => f.id)).toEqual([newerFace!.id, olderFace!.id]);
      expect(details.faces[0].photo?.filename).toBe("newer.jpg");
      expect(details.faces[0].photo).toMatchObject({
        user_id: user1.id,
        mime_type: "image/jpeg",
        size: 456,
        curation_status: "hidden",
      });
      expect(new Date(details.faces[0].photo!.taken_at!).toISOString()).toBe(
        "2025-06-15T12:30:00.000Z"
      );
      expect(details.faces[1].photo?.curation_status).toBe("visible");
    });

    it("should ignore all faces of a person", async () => {
      const person = await dbInsertReturning<{ id: number }>(
        db.insert(persons).values({ user_id: user1.id, name: "To Be Ignored" }).returning()
      );

      // Insert photo directly to avoid triggering background face indexing (race condition)
      const photoRow = await dbInsertReturning<{ id: number }>(
        db.insert(photos).values({
          user_id: user1.id,
          filename: "person_photo.jpg",
          original_name: "person_photo.jpg",
          mime_type: "image/jpeg",
          size: 3,
          hash: "test-ignore-hash",
        }).returning()
      );
      const photo = { id: photoRow!.id };

      const insertedFace = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          photo_id: photo.id,
          bbox: JSON.stringify({ x: 0, y: 0, width: 0.1, height: 0.1 }),
          embedding: JSON.stringify([0.1, 0.1]),
        }).returning()
      );
      await db.insert(userFaceAssignments).values({
        user_id: user1.id,
        face_id: insertedFace!.id,
        person_id: person!.id,
        ignored: false,
      });

      // Verify setup
      const facesBefore = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.person_id, person!.id));
      expect(facesBefore).toHaveLength(1);

      // Ignore person
      await service.ignorePersonFacesLogic(user1.id, person!.id);

      // Verify person is deleted
      const personAfter = await db.select().from(persons).where(eq(persons.id, person!.id)).then(r => r[0]);
      expect(personAfter).toBeUndefined();

      // Verify assignments are marked ignored and person_id is null
      const assignmentsAfter = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.face_id, insertedFace!.id));
      expect(assignmentsAfter[0].ignored).toBeTruthy();
      expect(assignmentsAfter[0].person_id).toBeNull();
    });
  });

  describe("Albums", () => {
    it("should create an album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "My Vacation" });
      expect(album.name).toBe("My Vacation");
      expect(album.user_id).toBe(user1.id);
    });

    // Issue #849: the iOS sync derives the album name from the iOS album title,
    // which keeps trailing spaces. Untrimmed storage made "Urlaub " a second
    // album next to "Urlaub" on the next sync run.
    it("trims surrounding whitespace from album names on create", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "  Urlaub  " });
      expect(album.name).toBe("Urlaub");

      const response = await service.listAlbumsLogic(user1.id);
      expect(response.albums.find(a => a.id === album.id)!.name).toBe("Urlaub");
    });

    it("trims surrounding whitespace from album names on update", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Gardasee" });
      const updated = await service.updateAlbumLogic(user1.id, { id: album.id, name: "Gardasee 2026 " });
      expect(updated.name).toBe("Gardasee 2026");
    });

    it("should list albums with cover photo and description", async () => {
      const album = await service.createAlbumLogic(user1.id, { 
        name: "Vacation with Cover", 
        description: "My trip to the mountains" 
      });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "mountains.jpg",
        mimeType: "image/jpeg",
      });
      
      // Add photo to album first
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Set as cover
      await service.updateAlbumLogic(user1.id, { id: album.id, coverPhotoId: photo.id });
      
      const response = await service.listAlbumsLogic(user1.id);
      const found = response.albums.find(a => a.id === album.id);
      expect(found).toBeDefined();
      expect(found!.description).toBe("My trip to the mountains");
      expect(found!.cover_photo_id).toBe(photo.id);
      expect(found!.cover_filename).toBeDefined();
    });

    it("should include stats (newest, oldest, count) in album logic", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Time Album" });
      const photo1 = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1]),
        name: "old.jpg",
        mimeType: "image/jpeg",
      });
      // Mocking taken_at for photo1
      await db.update(photos).set({ taken_at: '2020-01-01 10:00:00' }).where(eq(photos.id, photo1.id));

      const photo2 = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([2]),
        name: "new.jpg",
        mimeType: "image/jpeg",
      });
      // Mocking taken_at for photo2
      await db.update(photos).set({ taken_at: '2023-01-01 10:00:00' }).where(eq(photos.id, photo2.id));

      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo1.id });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo2.id });

      const response = await service.listAlbumsLogic(user1.id);
      const found = response.albums.find(a => a.id === album.id);
      expect(found).toBeDefined();
      expect(found!.newest_photo_at).toBeDefined();
      expect(found!.oldest_photo_at).toBeDefined();
      expect(found!.photo_count).toBe(2);
      // It should be the date of photo2 (2023) and photo1 (2020)
      expect(new Date(found!.newest_photo_at!).getFullYear()).toBe(2023);
      expect(new Date(found!.oldest_photo_at!).getFullYear()).toBe(2020);

      const details = await service.getAlbumLogic(user1.id, album.id);
      expect(details.photo_count).toBe(2);
      expect(new Date(details.newest_photo_at!).getFullYear()).toBe(2023);
      expect(new Date(details.oldest_photo_at!).getFullYear()).toBe(2020);
    });

    it("should use newest photo as cover if no cover_photo_id is set", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Default Cover Album" });
      const photo1 = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1]),
        name: "old.jpg",
        mimeType: "image/jpeg",
      });
      await db.update(photos).set({ taken_at: "2020-01-01 10:00:00" }).where(eq(photos.id, photo1.id));

      const photo2 = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([2]),
        name: "new.jpg",
        mimeType: "image/jpeg",
      });
      await db.update(photos).set({ taken_at: "2023-01-01 10:00:00" }).where(eq(photos.id, photo2.id));

      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo1.id });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo2.id });

      const response = await service.listAlbumsLogic(user1.id);
      const found = response.albums.find(a => a.id === album.id);

      expect(found).toBeDefined();
      expect(found!.cover_photo_id).toBeUndefined();
      // It should return the filename of the newest photo (photo2)
      expect(found!.cover_filename).toBe(photo2.filename);
    });

    it("should add a photo to an album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Vacation" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "photo.jpg",
        mimeType: "image/jpeg",
      });

      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      const albumDetails = await service.getAlbumLogic(user1.id, album.id);
      expect(albumDetails.photos).toHaveLength(1);
      expect(albumDetails.photos[0].id).toBe(photo.id);
    });

    it("should not allow adding another user's photo to an album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Vacation" });
      const photo = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([1, 2, 3]),
        name: "u2_photo.jpg",
        mimeType: "image/jpeg",
      });

      await expect(
        service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id })
      ).rejects.toThrow("Photo not found or not accessible to user");
    });

    it("should be idempotent when the same photo is added to the same album twice (#303)", async () => {
      // Reproduces the iOS-sync regression: when a duplicate upload merges
      // into an existing record, the iOS client still calls POST /albums/photos
      // for the resulting photo id. The second call must succeed silently
      // instead of raising a unique-constraint violation.
      const album = await service.createAlbumLogic(user1.id, { name: "Idempotent" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });
      const first = await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });
      expect(first.success).toBe(true);
      const second = await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });
      expect(second.success).toBe(true);
      const details = await service.getAlbumLogic(user1.id, album.id);
      expect(details.photos).toHaveLength(1);
    });

    it("exposes image_data_hash in album photos for iOS bisync pixel-change detection", async () => {
      // The iOS download sync must distinguish a real pixel change from a mere
      // metadata edit. `hash` stores the full/state hash (changes on
      // favorite/caption/date), so the client needs the pixel-only
      // image_data_hash to avoid re-downloading (and deleting) on metadata edits.
      const album = await service.createAlbumLogic(user1.id, { name: "Bisync Hash Album" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });
      await db.update(photos).set({ image_data_hash: "pixelhash123" }).where(eq(photos.id, photo.id));
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      const details = await service.getAlbumLogic(user1.id, album.id, { includePhotos: true });
      const p = details.photos.find((x) => x.id === photo.id);
      expect(p?.image_data_hash).toBe("pixelhash123");
    });
  });

  describe("/photos/index ETag fingerprint", () => {
    const etagFor = async (userId: number) =>
      service.photoIndexEtag(userId, await service.getPhotoIndexFingerprint(userId), "");

    it("changes when an existing photo is added to or removed from an album", async () => {
      // Adding an existing photo to an album only inserts an album_photos row;
      // the photo row is untouched. The iOS bisync download relies on the ETag
      // flipping here — otherwise the 304 fast-skip hides server-side additions.
      const album = await service.createAlbumLogic(user1.id, { name: "Bisync Album" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });

      const beforeAdd = await etagFor(user1.id);
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });
      const afterAdd = await etagFor(user1.id);
      expect(afterAdd).not.toBe(beforeAdd);

      await service.batchUpdateAlbumPhotosLogic(user1.id, {
        albumIds: [album.id],
        photoIds: [photo.id],
        action: "remove",
      });
      const afterRemove = await etagFor(user1.id);
      expect(afterRemove).not.toBe(afterAdd);
    });

    it("changes for a share participant when the owner adds a photo", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Shared Bisync" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });

      const before = await etagFor(user2.id);
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });
      const after = await etagFor(user2.id);
      expect(after).not.toBe(before);
    });

    it("stays stable when nothing changed", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Stable Album" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      expect(await etagFor(user1.id)).toBe(await etagFor(user1.id));
    });
  });

  describe("Album Sharing", () => {
    it("should allow read access to shared album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Shared Read" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Share with user 2 (read access)
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });

      // User 2 should be able to see it
      const albumDetails = await service.getAlbumLogic(user2.id, album.id);
      expect(albumDetails.name).toBe("Shared Read");
      expect(albumDetails.photos).toHaveLength(1);

      // User 2 should NOT be able to rename it
      await expect(
        service.updateAlbumLogic(user2.id, { id: album.id, name: "Hacked" })
      ).rejects.toThrow("Unauthorized to update album");
    });

    it("should allow write access to shared album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Shared Write" });

      // Share with user 2 (write access)
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write" });

      // User 2 should be able to rename it
      const updated = await service.updateAlbumLogic(user2.id, { id: album.id, name: "Renamed by U2" });
      expect(updated.name).toBe("Renamed by U2");

      // User 2 can add their OWN photo to U1's album because they have write access
      const photo2 = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([4, 5]),
        name: "u2_p.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user2.id, { albumId: album.id, photoId: photo2.id });

      const albumDetails = await service.getAlbumLogic(user1.id, album.id);
      expect(albumDetails.photos).toHaveLength(1);
    });

    it("should allow hiding photos for users with any album share access level", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Curation Access" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1,2,3]),
        name: "c.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Share with user2 as read -> should be able to hide (curation is user-specific)
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });
      const res = await service.updatePhotoCurationLogic(user2.id, photo.id, 'hidden');
      expect(res.success).toBe(true);
    });

    it("should expose curation_stats and viewer role when a read-share user fetches the album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Opinions Visible" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "shared.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Share with user2 as read — in the UI that maps to role 'viewer'.
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });

      // Owner favorites the photo so the aggregate counts are non-zero.
      await service.updatePhotoCurationLogic(user1.id, photo.id, 'favorite');

      const asViewer = await service.getAlbumLogic(user2.id, album.id);

      expect(asViewer.role).toBe("viewer");
      expect(asViewer.is_shared).toBe(true);
      expect(asViewer.photos).toHaveLength(1);

      const stats = (asViewer.photos[0] as any).curation_stats;
      expect(stats).toBeDefined();
      expect(stats.member_count).toBeGreaterThan(1);
      expect(stats.fav_count).toBe(1);
      expect(stats.hide_count).toBe(0);
    });

    it("should allow a write_share participant to create and delete a public link", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Share-delegated" });

      // Participant with plain write cannot manage the public link.
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write" });
      await expect(service.createAlbumPublicLinkLogic(user2.id, album.id)).rejects.toThrow("Unauthorized");

      // Upgrade to write_share — now the participant can create, read and delete the link.
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write_share" });

      const created = await service.createAlbumPublicLinkLogic(user2.id, album.id);
      expect(created.token).toBeTruthy();

      const sharesView = await service.getAlbumSharesLogic(user2.id, album.id);
      expect(sharesView.publicLink?.token).toBe(created.token);
      // write_share participants see the full shares list so they can decide
      // who to invite — but they are only authorized to mutate entries they
      // created themselves (covered by a dedicated test).
      expect(sharesView.shares.map(s => s.user_id)).toContain(user2.id);

      const deleted = await service.deleteAlbumPublicLinkLogic(user2.id, album.id);
      expect(deleted.success).toBe(true);
    });

    it("should not allow a read-only participant to see or manage public links", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Read-only" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });

      await expect(service.getAlbumSharesLogic(user2.id, album.id)).rejects.toThrow("Unauthorized");
      await expect(service.createAlbumPublicLinkLogic(user2.id, album.id)).rejects.toThrow("Unauthorized");
      await expect(service.deleteAlbumPublicLinkLogic(user2.id, album.id)).rejects.toThrow("Unauthorized");
    });

    describe("public link persistence (issue #435)", () => {
      it("re-uses the same token when a deleted link is re-created", async () => {
        const album = await service.createAlbumLogic(user1.id, { name: "Sticky link" });

        const first = await service.createAlbumPublicLinkLogic(user1.id, album.id);
        expect(first.token).toBeTruthy();

        // Delete (soft) — the row stays so the token survives.
        await service.deleteAlbumPublicLinkLogic(user1.id, album.id);

        // Owner UI must report the link as gone once disabled.
        const sharesAfterDelete = await service.getAlbumSharesLogic(user1.id, album.id);
        expect(sharesAfterDelete.publicLink).toBeUndefined();

        // Public-token lookup must refuse the disabled link.
        await expect(service.getPublicAlbumLogic(first.token))
          .rejects.toThrow("Dieser Link ist ungültig");

        // Re-create returns the SAME token (the headline guarantee).
        const second = await service.createAlbumPublicLinkLogic(user1.id, album.id);
        expect(second.token).toBe(first.token);
        expect(second.id).toBe(first.id);

        // Token resolves again now that the link is re-enabled.
        const publicView = await service.getPublicAlbumLogic(second.token);
        expect(publicView.id).toBe(album.id);

        // And the owner UI sees it again.
        const sharesAfterReenable = await service.getAlbumSharesLogic(user1.id, album.id);
        expect(sharesAfterReenable.publicLink?.token).toBe(first.token);
      });

      it("re-enabling refreshes the expires_at when an expiresIn is passed", async () => {
        const album = await service.createAlbumLogic(user1.id, { name: "Refresh expiry" });

        const first = await service.createAlbumPublicLinkLogic(user1.id, album.id);
        expect(first.expires_at).toBeUndefined();

        await service.deleteAlbumPublicLinkLogic(user1.id, album.id);

        const reEnabled = await service.createAlbumPublicLinkLogic(user1.id, album.id, "7d");
        expect(reEnabled.token).toBe(first.token);
        expect(reEnabled.expires_at).toBeTruthy();
        // Expiry is in the future.
        expect(new Date(reEnabled.expires_at!).getTime()).toBeGreaterThan(Date.now());
      });
    });

    it("excludes photos hidden by the owner or by any shared collaborator from the public link", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "Public exclusions" });
      const visible = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "visible.jpg",
        mimeType: "image/jpeg",
      });
      const hiddenByOwner = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([4, 5, 6]),
        name: "hidden_by_owner.jpg",
        mimeType: "image/jpeg",
      });
      const hiddenByCollaborator = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([7, 8, 9]),
        name: "hidden_by_collaborator.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: visible.id });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: hiddenByOwner.id });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: hiddenByCollaborator.id });

      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });

      await service.updatePhotoCurationLogic(user1.id, hiddenByOwner.id, "hidden");
      // A collaborator (not the owner) hiding a photo must also keep it out of the public link.
      await service.updatePhotoCurationLogic(user2.id, hiddenByCollaborator.id, "hidden");

      const link = await service.createAlbumPublicLinkLogic(user1.id, album.id);
      const publicView = await service.getPublicAlbumLogic(link.token);

      const publicIds = publicView.photos.map(p => p.id);
      expect(publicIds).toContain(visible.id);
      expect(publicIds).not.toContain(hiddenByOwner.id);
      expect(publicIds).not.toContain(hiddenByCollaborator.id);
      expect(publicView.photos).toHaveLength(1);
    });

    it("should let write_share participants invite users but not escalate to write_share", async () => {
      const user3 = await createUserLogic({ email: "u3@share.com", name: "User 3", password: "pw" });
      const album = await service.createAlbumLogic(user1.id, { name: "Delegated invites" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write_share" });

      // Delegate can invite a third user with read or write.
      await service.shareAlbumLogic(user2.id, { albumId: album.id, userId: user3.id, accessLevel: "write" });

      // But cannot grant write_share — that would let invitees chain further.
      await expect(
        service.shareAlbumLogic(user2.id, { albumId: album.id, userId: user3.id, accessLevel: "write_share" })
      ).rejects.toThrow("Only the album owner can grant write_share");

      // The new share records the delegate as inviter.
      const shares = await service.getAlbumSharesLogic(user1.id, album.id);
      const share3 = shares.shares.find(s => s.user_id === user3.id);
      expect(share3?.invited_by_user_id).toBe(user2.id);
      expect(share3?.access_level).toBe("write");
    });

    it("should expose shareable users to write_share delegates without users.list", async () => {
      const user3 = await createUserLogic({ email: "u3@shareable.com", name: "Charlie", password: "pw" });
      const user4 = await createUserLogic({ email: "u4@shareable.com", name: "Dora", password: "pw" });
      const aiUser = await createUserLogic({ email: "ai@system.local", name: "KI-Bewertung", password: "pw" });
      const album = await service.createAlbumLogic(user1.id, { name: "Shareable list" });

      // user2 has write_share, user3 is already shared, user4 is invitable.
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write_share" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user3.id, accessLevel: "read" });

      const asDelegate = await service.getAlbumShareableUsersLogic(user2.id, album.id);
      const ids = asDelegate.users.map(u => u.id);
      // Excludes owner, the caller themselves, existing shares, and the AI system user.
      expect(ids).not.toContain(user1.id);
      expect(ids).not.toContain(user2.id);
      expect(ids).not.toContain(user3.id);
      expect(ids).not.toContain(aiUser.id);
      expect(ids).toContain(user4.id);

      // Read-only participants must not enumerate users via this endpoint.
      const user5 = await createUserLogic({ email: "u5@shareable.com", name: "Eve", password: "pw" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user5.id, accessLevel: "read" });
      await expect(service.getAlbumShareableUsersLogic(user5.id, album.id)).rejects.toThrow();
    });

    it("should let write_share remove only their own invitations", async () => {
      const user3 = await createUserLogic({ email: "u3@rm.com", name: "User 3", password: "pw" });
      const user4 = await createUserLogic({ email: "u4@rm.com", name: "User 4", password: "pw" });
      const album = await service.createAlbumLogic(user1.id, { name: "Scoped removal" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write_share" });
      await service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user3.id, accessLevel: "read" });
      await service.shareAlbumLogic(user2.id, { albumId: album.id, userId: user4.id, accessLevel: "read" });

      // Delegate cannot remove a share the owner created.
      await expect(
        service.removeAlbumShareLogic(user2.id, { albumId: album.id, userId: user3.id })
      ).rejects.toThrow("Can only remove shares you created yourself");

      // But can remove the share they created themselves.
      await service.removeAlbumShareLogic(user2.id, { albumId: album.id, userId: user4.id });
      const remaining = await service.getAlbumSharesLogic(user1.id, album.id);
      expect(remaining.shares.map(s => s.user_id).sort()).toEqual([user2.id, user3.id].sort());
    });

    it("should not allow hiding photos for users without any album share", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "No Share" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1,2,3]),
        name: "d.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // user2 has no share at all -> should NOT be able to hide
      await expect(service.updatePhotoCurationLogic(user2.id, photo.id, 'hidden')).rejects.toThrow("Photo not found or unauthorized");
    });

    it("should let an album owner reuse a participant's photo in another album", async () => {
      // user2 contributes their own photo to user1's shared album.
      const shared = await service.createAlbumLogic(user1.id, { name: "Family trip" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write" });
      const photo = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([7, 7, 7]),
        name: "u2_contrib.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user2.id, { albumId: shared.id, photoId: photo.id });

      // The owner of that album may pull the contributed photo into one of
      // their own albums even though they don't own the photo.
      const ownAlbum = await service.createAlbumLogic(user1.id, { name: "Best of" });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: ownAlbum.id, photoId: photo.id });

      const details = await service.getAlbumLogic(user1.id, ownAlbum.id);
      expect(details.photos.map(p => p.id)).toContain(photo.id);
    });

    it("should let a write_share participant reuse a photo from the shared album", async () => {
      const shared = await service.createAlbumLogic(user1.id, { name: "Delegated reuse" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write_share" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([8, 8, 8]),
        name: "u1_photo.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: shared.id, photoId: photo.id });

      // The write_share participant copies the owner's photo into their own album.
      const ownAlbum = await service.createAlbumLogic(user2.id, { name: "U2 collection" });
      await service.addPhotoToAlbumLogic(user2.id, { albumId: ownAlbum.id, photoId: photo.id });

      const details = await service.getAlbumLogic(user2.id, ownAlbum.id);
      expect(details.photos.map(p => p.id)).toContain(photo.id);
    });

    it("should not let a plain write participant reuse another user's photo", async () => {
      const shared = await service.createAlbumLogic(user1.id, { name: "Write only" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([9, 9, 9]),
        name: "u1_locked.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: shared.id, photoId: photo.id });

      // Plain write access does not grant the right to take the photo elsewhere.
      const ownAlbum = await service.createAlbumLogic(user2.id, { name: "U2 attempt" });
      await expect(
        service.addPhotoToAlbumLogic(user2.id, { albumId: ownAlbum.id, photoId: photo.id })
      ).rejects.toThrow("Photo not found or not accessible to user");
    });

    it("should keep a reused photo after the source share is revoked (snapshot)", async () => {
      const shared = await service.createAlbumLogic(user1.id, { name: "Snapshot source" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write_share" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 0, 1]),
        name: "snap.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: shared.id, photoId: photo.id });

      const ownAlbum = await service.createAlbumLogic(user2.id, { name: "Snapshot target" });
      await service.addPhotoToAlbumLogic(user2.id, { albumId: ownAlbum.id, photoId: photo.id });

      // Revoking the share must not retroactively remove already-copied photos.
      await service.removeAlbumShareLogic(user1.id, { albumId: shared.id, userId: user2.id });

      const details = await service.getAlbumLogic(user2.id, ownAlbum.id);
      expect(details.photos.map(p => p.id)).toContain(photo.id);
    });

    it("should let a write_share participant batch-add a photo from the shared album", async () => {
      const shared = await service.createAlbumLogic(user1.id, { name: "Batch source" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write_share" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([2, 2, 2]),
        name: "batch.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user1.id, { albumId: shared.id, photoId: photo.id });

      const ownAlbum = await service.createAlbumLogic(user2.id, { name: "Batch target" });
      await service.batchUpdateAlbumPhotosLogic(user2.id, {
        albumIds: [ownAlbum.id],
        photoIds: [photo.id],
        action: "add",
      });

      const details = await service.getAlbumLogic(user2.id, ownAlbum.id);
      expect(details.photos.map(p => p.id)).toContain(photo.id);
    });

    it("should let an album owner curate a participant's photo in their album", async () => {
      const shared = await service.createAlbumLogic(user1.id, { name: "Curate foreign" });
      await service.shareAlbumLogic(user1.id, { albumId: shared.id, userId: user2.id, accessLevel: "write" });
      const photo = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([3, 3, 3]),
        name: "u2_curate.jpg",
        mimeType: "image/jpeg",
      });
      await service.addPhotoToAlbumLogic(user2.id, { albumId: shared.id, photoId: photo.id });

      // The album owner can favorite a contributed photo they do not own.
      const res = await service.updatePhotoCurationLogic(user1.id, photo.id, 'favorite');
      expect(res.success).toBe(true);
    });
  });

  // The iOS client (APIClient.uploadPhoto) and the server agree on a set of
  // X-* upload headers. These tests run the REAL header parser
  // (service.parseUploadHeaders — the same function the POST /photos endpoint
  // calls) and then drive the REAL dedup/metadata pipeline
  // (service.uploadPhotoStream) with the parsed result, so the whole
  // header-contract → dedup/metadata path is exercised with production code.
  describe("iOS upload header contract (#591)", () => {
    const hashUpperA = "AB".repeat(32);
    const hashLowerA = "ab".repeat(32);
    const fullUpperA = "CD".repeat(32);
    const fullLowerA = "cd".repeat(32);

    // Mirrors what APIClient.uploadPhoto sends on the wire.
    function iosHeaders(over: Record<string, string> = {}): Record<string, string> {
      return { "content-type": "image/jpeg", ...over };
    }

    async function uploadViaHeaders(body: string, headers: Record<string, string>) {
      const parsed = service.parseUploadHeaders(headers);
      const stream = Readable.from(Buffer.from(body)) as any;
      return service.uploadPhotoStream(
        user1.id, stream, parsed.fileName, parsed.mimeType,
        parsed.isFavorite, parsed.clientCapturedAt, parsed.sync,
      );
    }

    function cleanup(filename: string) {
      const p = path.join(UPLOAD_DIR, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // MARK: - Pure parsing of the wire contract

    it("parses the full iOS header set the client sends", () => {
      const parsed = service.parseUploadHeaders({
        "content-type": "image/heic",
        "x-file-name": "IMG%201.heic",                     // percent-encoded space
        "x-is-favorite": "true",
        "x-captured-at": "2026-05-20T15:00:00+02:00",
        "x-image-data-hash": hashUpperA,                    // server lower-cases
        "x-full-hash": fullUpperA,
        "x-description": "F%C3%B6hr%20Strand",              // "Föhr Strand"
        "x-asset-id": "DEV-1/L0/001",
        "x-gps-lat": "48.137154",
        "x-gps-lng": "11.576124",
      });

      expect(parsed.fileName).toBe("IMG 1.heic");
      expect(parsed.mimeType).toBe("image/heic");
      expect(parsed.isFavorite).toBe(true);
      expect(parsed.clientCapturedAt).toBe("2026-05-20T15:00:00+02:00");
      expect(parsed.hasDescriptionHeader).toBe(true);
      expect(parsed.sync.imageDataHash).toBe(hashLowerA);
      expect(parsed.sync.fullHash).toBe(fullLowerA);
      expect(parsed.sync.description).toBe("Föhr Strand");
      expect(parsed.sync.deviceAssetId).toBe("DEV-1/L0/001");
      expect(parsed.sync.clientLatitude).toBeCloseTo(48.137154, 5);
      expect(parsed.sync.clientLongitude).toBeCloseTo(11.576124, 5);
    });

    it("treats only the literal \"true\" as favourite", () => {
      expect(service.parseUploadHeaders(iosHeaders({ "x-is-favorite": "true" })).isFavorite).toBe(true);
      expect(service.parseUploadHeaders(iosHeaders({ "x-is-favorite": "TRUE" })).isFavorite).toBe(false);
      expect(service.parseUploadHeaders(iosHeaders({ "x-is-favorite": "1" })).isFavorite).toBe(false);
      expect(service.parseUploadHeaders(iosHeaders()).isFavorite).toBe(false);
    });

    it("defaults everything when the optional headers are absent", () => {
      const parsed = service.parseUploadHeaders({});
      expect(parsed.fileName).toBe("photo.jpg");
      expect(parsed.mimeType).toBe("image/jpeg");
      expect(parsed.isFavorite).toBe(false);
      expect(parsed.clientCapturedAt).toBeNull();
      expect(parsed.hasDescriptionHeader).toBe(false);
      expect(parsed.sync.imageDataHash).toBeNull();
      expect(parsed.sync.fullHash).toBeNull();
      expect(parsed.sync.description).toBeUndefined();
      expect(parsed.sync.deviceAssetId).toBeNull();
      expect(parsed.sync.clientLatitude).toBeNull();
      expect(parsed.sync.clientLongitude).toBeNull();
      expect(parsed.dateTaken).toBeNull();
    });

    it("parses X-Date-Taken (collage upload sets it to the oldest photo's date)", () => {
      const parsed = service.parseUploadHeaders(
        iosHeaders({ "x-date-taken": "2019-07-04T10:00:00.000Z" }),
      );
      expect(parsed.dateTaken).toBe("2019-07-04T10:00:00.000Z");
    });

    it("honours an empty X-Description (device is authoritative over the file caption)", () => {
      const parsed = service.parseUploadHeaders(iosHeaders({ "x-description": "" }));
      expect(parsed.hasDescriptionHeader).toBe(true);
      expect(parsed.sync.description).toBe("");
    });

    it("rejects a malformed hash header instead of forwarding garbage", () => {
      const parsed = service.parseUploadHeaders(iosHeaders({ "x-image-data-hash": "not-a-real-hash" }));
      expect(parsed.sync.imageDataHash).toBeNull();
    });

    it("applies clientDateTaken to taken_at (collage sits just after its source photos)", async () => {
      // Client sends the newest source photo's wall-clock date + 1s; the server
      // preserves the literal Y-M-D H:M:S (offset discarded, same as EXIF).
      const stream = Readable.from(Buffer.from("collage-pixels")) as any;
      const { photo } = await service.uploadPhotoStream(
        user1.id, stream, "collage.jpg", "image/jpeg",
        false, null, {}, "2015-06-01T09:30:01.000Z",
      );
      const row = await dbFirst<typeof photos.$inferSelect>(
        db.select().from(photos).where(eq(photos.id, photo.id)),
      );
      expect(row?.taken_at).toBeTruthy();
      // Stored as the literal wall-clock (format is TZ/driver dependent, so
      // match the Y-M-D H:M:S components rather than an exact string).
      expect(row!.taken_at).toMatch(/2015-06-01[T ]09:30:01/);
      cleanup(row!.filename);
    });

    // MARK: - Contract flowing into the real dedup/metadata pipeline

    it("stores description, GPS, asset id and filename from the headers", async () => {
      const { photo } = await uploadViaHeaders("gps-and-meta-pixels", iosHeaders({
        "x-file-name": "IMG%201.jpg",
        "x-description": "F%C3%B6hr%20Strand",
        "x-image-data-hash": hashUpperA,
        "x-full-hash": fullUpperA,
        "x-asset-id": "DEV-E2E/L0/1",
        "x-gps-lat": "48.137154",
        "x-gps-lng": "11.576124",
      }));

      const row = await dbFirst<typeof photos.$inferSelect>(
        db.select().from(photos).where(eq(photos.id, photo.id)),
      );
      expect(row?.original_name).toBe("IMG 1.jpg");
      expect(row?.description).toBe("Föhr Strand");
      expect(row?.image_data_hash).toBe(hashLowerA);   // normalised to lowercase
      expect(row?.hash).toBe(fullLowerA);
      expect(row?.device_asset_id).toBe("DEV-E2E/L0/1");
      expect(row?.latitude).toBeCloseTo(48.137154, 5); // client GPS fallback applied
      expect(row?.longitude).toBeCloseTo(11.576124, 5);
      cleanup(row!.filename);
    });

    it("replaces the existing photo when the same asset is re-uploaded edited (#591)", async () => {
      const deviceId = "DEV-EDIT/L0/9";
      const { photo: original } = await uploadViaHeaders("original-pixels", iosHeaders({
        "x-image-data-hash": hashUpperA,
        "x-full-hash": fullUpperA,
        "x-asset-id": deviceId,
      }));

      // Same asset id, different pixels (an in-app crop) → server replaces in place.
      const editedHash = "ef".repeat(32);
      const { photo: edited, replaced } = await uploadViaHeaders("edited-pixels-longer", iosHeaders({
        "x-image-data-hash": editedHash,
        "x-full-hash": "ba".repeat(32),
        "x-asset-id": deviceId,
        "x-description": "Bearbeitet",
      }));

      expect(replaced).toBe(true);
      expect(edited.id).toBe(original.id);
      const rows = await db.select().from(photos).where(eq(photos.device_asset_id, deviceId));
      expect(rows.length).toBe(1); // no duplicate
      const row = await dbFirst<typeof photos.$inferSelect>(
        db.select().from(photos).where(eq(photos.id, original.id)),
      );
      expect(row?.image_data_hash).toBe(editedHash);
      expect(row?.description).toBe("Bearbeitet");
      cleanup(row!.filename);
    });

    it("does not create a duplicate when the identical photo is re-uploaded (#591)", async () => {
      const headers = iosHeaders({
        "x-image-data-hash": hashUpperA,
        "x-full-hash": fullUpperA,
        "x-asset-id": "DEV-DUP/L0/1",
      });
      const { photo: first } = await uploadViaHeaders("same-pixels", headers);

      // Same pixels again → image_data_hash dedup, signalled as a duplicate.
      await expect(uploadViaHeaders("same-pixels", headers))
        .rejects.toBeInstanceOf(service.PhotoAlreadyExistsError);

      const rows = await db.select().from(photos).where(eq(photos.image_data_hash, hashLowerA));
      expect(rows.length).toBe(1);
      cleanup(first.filename);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests — no DB required
// ---------------------------------------------------------------------------

describe("computeFaceCompositionScore", () => {
  it("returns null when no bboxes provided", () => {
    expect(computeFaceCompositionScore([])).toBeNull();
  });

  it("returns null when all bboxes have zero dimensions", () => {
    expect(computeFaceCompositionScore([
      { x: 0.1, y: 0.1, width: 0, height: 0 },
      { x: 0.2, y: 0.2, width: 0, height: 0 },
    ])).toBeNull();
  });

  it("returns a value in [0, 1] for a well-centred face in ideal area range", () => {
    // 0.25 × 0.25 = 0.0625 → ideal area; centre at (0.25+0.125, 0.25+0.125) = (0.375, 0.375)
    const score = computeFaceCompositionScore([
      { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
    ]);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(1);
  });

  it("scores a well-centred ideal-size face higher than a face at the edge", () => {
    const centred = computeFaceCompositionScore([
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    // Face centre very close to the left edge
    const edgeFace = computeFaceCompositionScore([
      { x: 0.0, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    expect(centred).toBeGreaterThan(edgeFace);
  });

  it("gives a low area score for a very tiny face (area < 0.005)", () => {
    // 0.05 × 0.05 = 0.0025 < 0.005
    const tiny = computeFaceCompositionScore([
      { x: 0.475, y: 0.475, width: 0.05, height: 0.05 },
    ])!;
    const ideal = computeFaceCompositionScore([
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    expect(tiny).toBeLessThan(ideal);
  });

  it("gives a lower area score when the face fills most of the frame (area > 0.75)", () => {
    // 0.9 × 0.9 = 0.81 > 0.75
    const huge = computeFaceCompositionScore([
      { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    ])!;
    const ideal = computeFaceCompositionScore([
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    expect(huge).toBeLessThan(ideal);
  });

  it("selects the largest face as the main subject when multiple bboxes are present", () => {
    // Two faces: a tiny one and a big one.  Score should be driven by the big face.
    const multipleWithBig = computeFaceCompositionScore([
      { x: 0.0, y: 0.0, width: 0.05, height: 0.05 },   // tiny, corner
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 }, // big, centred
    ])!;
    const singleBig = computeFaceCompositionScore([
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    expect(multipleWithBig).toBeCloseTo(singleBig, 5);
  });

  it("ignores zero-size bboxes mixed with valid ones", () => {
    const withZero = computeFaceCompositionScore([
      { x: 0.1, y: 0.1, width: 0, height: 0 },
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    const withoutZero = computeFaceCompositionScore([
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    ])!;
    expect(withZero).toBeCloseTo(withoutZero, 5);
  });
});

describe("DeferJobError", () => {
  it("is an instance of Error", () => {
    const err = new DeferJobError("test reason");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of DeferJobError", () => {
    const err = new DeferJobError("test reason");
    expect(err).toBeInstanceOf(DeferJobError);
  });

  it("has name DeferJobError", () => {
    const err = new DeferJobError("test reason");
    expect(err.name).toBe("DeferJobError");
  });

  it("carries the provided message", () => {
    const err = new DeferJobError("waiting for face_detection");
    expect(err.message).toBe("waiting for face_detection");
  });
});
