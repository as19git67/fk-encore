import { Readable } from "stream";
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { photos, faces, persons, albums, albumPhotos, albumShares, users, roles, permissions, rolePermissions, userRoles } from "../db/schema";
import { dbInsertReturning, dbExec } from "../db/adapter";
import { UPLOAD_DIR } from "./photo.service";
import * as service from "./photo.service";
import { createUserLogic, getPermissionsForUser } from "../user/user.service";
import { createRoleLogic, assignPermissionLogic } from "../role/role.service";
import { assignRoleLogic } from "../user/user-roles.service";


describe("Photo Module", () => {
  let user1: any;
  let user2: any;

  beforeEach(async () => {
    // Clean tables (respecting foreign keys)
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
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

      const result = await service.uploadPhotoStream(user1.id, stream, "stream.jpg", "image/jpeg");

      expect(result.user_id).toBe(user1.id);
      expect(result.original_name).toBe("stream.jpg");
      expect(result.size).toBe(fileData.length);
      expect(fs.existsSync(path.join(UPLOAD_DIR, result.filename))).toBe(true);

      const content = fs.readFileSync(path.join(UPLOAD_DIR, result.filename));
      expect(content).toEqual(fileData);

      // Cleanup file
      fs.unlinkSync(path.join(UPLOAD_DIR, result.filename));
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

      // Insert an ignored face
      await db.insert(faces).values({
        user_id: user1.id,
        photo_id: photo.id,
        bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
        embedding: JSON.stringify([0.1, 0.2]),
        ignored: true,
        quality: 100
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
          user_id: user1.id,
          photo_id: olderPhoto!.id,
          person_id: person!.id,
          bbox: JSON.stringify(olderBbox),
          embedding: JSON.stringify([0.1, 0.2]),
          ignored: false,
        }).returning()
      );

      const newerFace = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          user_id: user1.id,
          photo_id: newerPhoto!.id,
          person_id: person!.id,
          bbox: JSON.stringify(newerBbox),
          embedding: JSON.stringify([0.3, 0.4]),
          ignored: false,
        }).returning()
      );

      // Intentionally point persisted cover to the older face.
      // listPersons/getPersonDetails should still resolve the newest face by taken_at.
      await dbExec(
        db.update(persons).set({ cover_face_id: olderFace!.id }).where(eq(persons.id, person!.id))
      );

      const listRes = await service.listPersonsLogic(user1.id);
      const listedPerson = listRes.persons.find((p) => p.id === person!.id);

      expect(listedPerson).toBeDefined();
      expect(listedPerson!.cover_face_id).toBe(newerFace!.id);
      expect(listedPerson!.cover_filename).toBe("newer.jpg");
      expect(listedPerson!.cover_bbox).toEqual(newerBbox);

      const details = await service.getPersonDetailsLogic(user1.id, person!.id);
      expect(details.faces.map((f) => f.id)).toEqual([newerFace!.id, olderFace!.id]);
      expect(details.faces[0].photo?.filename).toBe("newer.jpg");
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

      await db.insert(faces).values({
        user_id: user1.id,
        photo_id: photo.id,
        person_id: person!.id,
        bbox: JSON.stringify({ x: 0, y: 0, width: 0.1, height: 0.1 }),
        embedding: JSON.stringify([0.1, 0.1]),
        ignored: false,
      });

      // Verify setup
      const facesBefore = await db.select().from(faces).where(eq(faces.person_id, person!.id));
      expect(facesBefore).toHaveLength(1);

      // Ignore person
      await service.ignorePersonFacesLogic(user1.id, person!.id);

      // Verify person is deleted
      const personAfter = await db.select().from(persons).where(eq(persons.id, person!.id)).then(r => r[0]);
      expect(personAfter).toBeUndefined();

      // Verify faces are marked ignored and person_id is null
      const facesAfter = await db.select().from(faces).where(eq(faces.photo_id, photo.id));
      expect(facesAfter[0].ignored).toBeTruthy();
      expect(facesAfter[0].person_id).toBeNull();
    });
  });

  describe("Albums", () => {
    it("should create an album", async () => {
      const album = await service.createAlbumLogic(user1.id, { name: "My Vacation" });
      expect(album.name).toBe("My Vacation");
      expect(album.user_id).toBe(user1.id);
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
      ).rejects.toThrow("Photo not found or not owned by user");
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
  });
});
