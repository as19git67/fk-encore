import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import db from "../db/database";
import { groupMembers, groups, homeMedia, users } from "../db/schema";
import { mediaFilePath, sweepHomeMedia } from "./media-store";
import { deleteMedia, mediaFile, updateMediaCaption, uploadMedia } from "./media.service";
import {
  createNote,
  createSystem,
  deleteNote,
  deleteSystem,
  getSystemDetail,
  listSystems,
} from "./systems.service";

// Every system and photo here is invented; the images are drawn, not taken.

const cleanupUserIds: number[] = [];
const cleanupGroupIds: number[] = [];
let mediaDir: string;

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `home-media-${label}-${Date.now()}-${Math.random()}@example.test`,
      name: `Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createGroup(ownerId: number, memberIds: number[]): Promise<number> {
  const [row] = await db
    .insert(groups)
    .values({ slug: `home-media-${Date.now()}-${Math.random()}`, name: "Familie" })
    .returning({ id: groups.id });
  cleanupGroupIds.push(row.id);
  await db.insert(groupMembers).values({ group_id: row.id, user_id: ownerId, role: "owner" });
  for (const userId of memberIds) {
    await db.insert(groupMembers).values({ group_id: row.id, user_id: userId, role: "member" });
  }
  return row.id;
}

/** A landscape JPEG that says "rotate 90°" and carries a camera position. */
async function cameraJpeg(): Promise<Buffer> {
  return await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#7a8a99" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "Beispielkamera" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "10/1 20/1 30/1", GPSLongitudeRef: "E", GPSLongitude: "1/1 2/1 3/1" },
    })
    .toBuffer();
}

async function exists(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => null)) !== null;
}

async function keyOf(mediaId: number): Promise<string> {
  const [row] = await db.select().from(homeMedia).where(eq(homeMedia.id, mediaId));
  return row.object_key;
}

let owner: number;
let member: number;
let outsider: number;
let groupId: number;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "0", permissions: [] });
  mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-media-"));
  vi.stubEnv("HOME_MEDIA_DIR", mediaDir);
  owner = await createUser("owner");
  member = await createUser("member");
  outsider = await createUser("outsider");
  groupId = await createGroup(owner, [member]);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of cleanupGroupIds.splice(0)) {
    await db.delete(groups).where(eq(groups.id, id));
  }
  await fs.rm(mediaDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("uploadMedia", () => {
  it("stores the photo upright, shrunk and without any metadata", async () => {
    const { id } = await createSystem(owner, { name: "Enthärtungsanlage", category: "water", groupId });
    const media = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });

    const input = await sharp(await cameraJpeg()).metadata();
    expect([input.orientation, !!input.exif]).toEqual([6, true]);
    expect(media).toMatchObject({ targetKind: "system", targetId: id, width: 683, height: 2048 });
    const full = await mediaFile(owner, media.id, "full");
    const meta = await sharp(await fs.readFile(full.path)).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([683, 2048]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();

    const small = await sharp(await fs.readFile((await mediaFile(owner, media.id, "small")).path)).metadata();
    expect(Math.max(small.width!, small.height!)).toBe(480);
    expect(small.exif).toBeUndefined();
  });

  it("refuses what is not an image", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    await expect(
      uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: Buffer.from("kein Bild") }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("only attaches to the system itself or its own notes", async () => {
    const { id: first } = await createSystem(owner, { name: "Heizung", category: "heating" });
    const { id: second } = await createSystem(owner, { name: "Lüftung", category: "ventilation" });
    const { id: note } = await createNote(owner, second, { body: "Filter gewechselt" });
    const bytes = await cameraJpeg();

    await expect(uploadMedia(owner, first, { targetKind: "note", targetId: note, bytes }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(uploadMedia(owner, first, { targetKind: "system", targetId: second, bytes }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(uploadMedia(owner, second, { targetKind: "note", targetId: note, bytes }))
      .resolves.toMatchObject({ targetKind: "note", targetId: note });
  });
});

describe("who sees and changes a photo", () => {
  it("follows the system: group members yes, others not even its existence", async () => {
    const { id } = await createSystem(owner, { name: "Gartenpumpe", category: "garden", groupId });
    const media = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });

    await expect(mediaFile(member, media.id, "small")).resolves.toBeTruthy();
    await expect(updateMediaCaption(member, media.id, "  Pumpe im Gartenhaus ")).resolves.toMatchObject({
      caption: "Pumpe im Gartenhaus",
    });

    await expect(mediaFile(outsider, media.id, "small")).rejects.toMatchObject({ code: "not_found" });
    await expect(updateMediaCaption(outsider, media.id, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteMedia(outsider, media.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      uploadMedia(outsider, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deleting a photo removes both files", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating", groupId });
    const media = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    const key = await keyOf(media.id);

    await deleteMedia(member, media.id);
    expect(await exists(mediaFilePath(key, "full"))).toBe(false);
    expect(await exists(mediaFilePath(key, "small"))).toBe(false);
    await expect(mediaFile(owner, media.id, "full")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("photos go with their target", () => {
  it("a deleted note takes its photos along, the system's own stay", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    const { id: note } = await createNote(owner, id, { body: "Druck nachgefüllt" });
    const own = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    const ofNote = await uploadMedia(owner, id, { targetKind: "note", targetId: note, bytes: await cameraJpeg() });
    const noteKey = await keyOf(ofNote.id);

    await deleteNote(owner, id, note);
    expect(await exists(mediaFilePath(noteKey, "full"))).toBe(false);
    const detail = await getSystemDetail(owner, id);
    expect(detail.media.map((m) => m.id)).toEqual([own.id]);
  });

  it("a deleted system takes every photo file along", async () => {
    const { id } = await createSystem(owner, { name: "Alter Boiler", category: "heating" });
    const media = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    const key = await keyOf(media.id);

    await deleteSystem(owner, id);
    expect(await exists(mediaFilePath(key, "full"))).toBe(false);
    expect(await db.select().from(homeMedia).where(eq(homeMedia.id, media.id))).toEqual([]);
  });
});

describe("list and detail", () => {
  it("the card shows the first photo of the system itself", async () => {
    const { id } = await createSystem(owner, { name: "Lüftungsanlage", category: "ventilation" });
    const { id: note } = await createNote(owner, id, { body: "Filter gewechselt" });
    await uploadMedia(owner, id, { targetKind: "note", targetId: note, bytes: await cameraJpeg() });
    expect((await listSystems(owner)).find((s) => s.id === id)?.coverMediaId).toBeNull();

    const first = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    expect((await listSystems(owner)).find((s) => s.id === id)?.coverMediaId).toBe(first.id);
    expect((await getSystemDetail(owner, id)).media).toHaveLength(3);
  });
});

describe("sweepHomeMedia", () => {
  it("removes rows whose target is gone and old files without a row", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    const kept = await uploadMedia(owner, id, { targetKind: "system", targetId: id, bytes: await cameraJpeg() });
    const [orphan] = await db
      .insert(homeMedia)
      .values({ system_id: id, target_kind: "note", target_id: 2_000_000_000, object_key: `${id}/verwaist`, width: 1, height: 1 })
      .returning();
    await fs.writeFile(mediaFilePath(orphan.object_key, "full"), "x");
    await fs.writeFile(mediaFilePath(`${id}/ohne-zeile`, "full"), "x");

    // Right after an upload a file without a row may still be getting its row.
    const soon = await sweepHomeMedia(new Date());
    expect(soon).toEqual({ rows: 1, files: 0 });
    expect(await exists(mediaFilePath(`${id}/ohne-zeile`, "full"))).toBe(true);

    const later = await sweepHomeMedia(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(later).toEqual({ rows: 0, files: 1 });
    expect(await exists(mediaFilePath(`${id}/ohne-zeile`, "full"))).toBe(false);
    expect(await exists(mediaFilePath(orphan.object_key, "full"))).toBe(false);
    await expect(mediaFile(owner, kept.id, "full")).resolves.toBeTruthy();
  });
});
