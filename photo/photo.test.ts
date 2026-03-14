import { Readable } from "stream";
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  users,
  roles,
  permissions,
  rolePermissions,
  userRoles,
} from "../db/schema";
import * as service from "./photo.service";
import { createUserLogic, getPermissionsForUser } from "../user/user.service";
import { createRoleLogic, assignPermissionLogic } from "../role/role.service";
import { assignRoleLogic } from "../user/user-roles.service";

const UPLOAD_DIR = "uploads/photos";

describe("Photo Module", () => {
  let user1: any;
  let user2: any;

  beforeEach(() => {
    // Clean tables (respecting foreign keys)
    db.delete(albumPhotos).run();
    db.delete(albumShares).run();
    db.delete(albums).run();
    db.delete(photos).run();
    db.delete(rolePermissions).run();
    db.delete(userRoles).run();
    db.delete(users).run();
    db.delete(roles).run();
    db.delete(permissions).run();

    user1 = createUserLogic({ email: "u1@test.com", name: "User 1", password: "pw" });
    user2 = createUserLogic({ email: "u2@test.com", name: "User 2", password: "pw" });
    
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  });

  describe("Module Permissions", () => {
    it("should resolve module.photos permission for user with correct role", () => {
      // 1. Create permission
      db.insert(permissions).values({ key: "module.photos", description: "Enable photos" }).run();
      const perm = db.select().from(permissions).where(eq(permissions.key, "module.photos")).get()!;

      // 2. Create role and assign permission
      const role = createRoleLogic({ name: "PhotoUser" });
      assignPermissionLogic(role.id, perm.id);

      // 3. Assign role to user
      assignRoleLogic({ userId: user1.id, roleId: role.id });

      // 4. Verify user has permission
      const userPerms = getPermissionsForUser(user1.id);
      expect(userPerms).toContain("module.photos");
      
      const user2Perms = getPermissionsForUser(user2.id);
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

      const list1 = service.listPhotosLogic(user1.id);
      expect(list1.photos).toHaveLength(1);
      expect(list1.photos[0].original_name).toBe("u1.jpg");

      const list2 = service.listPhotosLogic(user2.id);
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
      const idsRes = service.getPhotosToRefreshMetadataLogic(user1.id);
      expect(idsRes.ids).toContain(photo.id);

      const refreshRes = await service.refreshPhotoMetadataLogic(user1.id, photo.id);
      expect(refreshRes.success).toBe(true);

      // Verify it's still in the DB
      const list = service.listPhotosLogic(user1.id);
      expect(list.photos[0].id).toBe(photo.id);
      
      // Cleanup
      fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
    });
  });

  describe("Albums", () => {
    it("should create an album", () => {
      const album = service.createAlbumLogic(user1.id, { name: "My Vacation" });
      expect(album.name).toBe("My Vacation");
      expect(album.user_id).toBe(user1.id);
    });

    it("should add a photo to an album", async () => {
      const album = service.createAlbumLogic(user1.id, { name: "Vacation" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "photo.jpg",
        mimeType: "image/jpeg",
      });

      service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      const albumDetails = service.getAlbumLogic(user1.id, album.id);
      expect(albumDetails.photos).toHaveLength(1);
      expect(albumDetails.photos[0].id).toBe(photo.id);
    });

    it("should not allow adding another user's photo to an album", async () => {
      const album = service.createAlbumLogic(user1.id, { name: "Vacation" });
      const photo = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([1, 2, 3]),
        name: "u2_photo.jpg",
        mimeType: "image/jpeg",
      });

      expect(() =>
        service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id })
      ).toThrow("Photo not found or not owned by user");
    });
  });

  describe("Album Sharing", () => {
    it("should allow read access to shared album", async () => {
      const album = service.createAlbumLogic(user1.id, { name: "Shared Read" });
      const photo = await service.uploadPhotoLogic(user1.id, {
        data: Buffer.from([1, 2, 3]),
        name: "p.jpg",
        mimeType: "image/jpeg",
      });
      service.addPhotoToAlbumLogic(user1.id, { albumId: album.id, photoId: photo.id });

      // Share with user 2 (read access)
      service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "read" });

      // User 2 should be able to see it
      const albumDetails = service.getAlbumLogic(user2.id, album.id);
      expect(albumDetails.name).toBe("Shared Read");
      expect(albumDetails.photos).toHaveLength(1);

      // User 2 should NOT be able to rename it
      expect(() =>
        service.updateAlbumLogic(user2.id, { id: album.id, name: "Hacked" })
      ).toThrow("Unauthorized to update album");
    });

    it("should allow write access to shared album", async () => {
      const album = service.createAlbumLogic(user1.id, { name: "Shared Write" });

      // Share with user 2 (write access)
      service.shareAlbumLogic(user1.id, { albumId: album.id, userId: user2.id, accessLevel: "write" });

      // User 2 should be able to rename it
      const updated = service.updateAlbumLogic(user2.id, { id: album.id, name: "Renamed by U2" });
      expect(updated.name).toBe("Renamed by U2");

      // User 2 can add their OWN photo to U1's album because they have write access
      const photo2 = await service.uploadPhotoLogic(user2.id, {
        data: Buffer.from([4, 5]),
        name: "u2_p.jpg",
        mimeType: "image/jpeg",
      });
      service.addPhotoToAlbumLogic(user2.id, { albumId: album.id, photoId: photo2.id });

      const albumDetails = service.getAlbumLogic(user1.id, album.id);
      expect(albumDetails.photos).toHaveLength(1);
    });
  });
});
