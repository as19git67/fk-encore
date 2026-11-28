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
import { mediaFile, uploadMedia, uploadPartMedia } from "./media.service";
import {
  adjustStock,
  createPart,
  deletePart,
  getPartDetail,
  listParts,
  normalizeEan,
  normalizeUrl,
  updatePart,
} from "./parts.service";
import {
  createItem,
  createSystem,
  getSystemDetail,
  listSystems,
  setSystemParts,
  updateItem,
} from "./systems.service";

// Every system and part here is invented.

const cleanupUserIds: number[] = [];
const cleanupGroupIds: number[] = [];
let mediaDir: string;

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `home-parts-${label}-${Date.now()}-${Math.random()}@example.test`,
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
    .values({ slug: `home-parts-${Date.now()}-${Math.random()}`, name: "Familie" })
    .returning({ id: groups.id });
  cleanupGroupIds.push(row.id);
  await db.insert(groupMembers).values({ group_id: row.id, user_id: ownerId, role: "owner" });
  for (const userId of memberIds) {
    await db.insert(groupMembers).values({ group_id: row.id, user_id: userId, role: "member" });
  }
  return row.id;
}

async function drawnJpeg(): Promise<Buffer> {
  return await sharp({ create: { width: 800, height: 600, channels: 3, background: "#5a6b7c" } })
    .jpeg()
    .toBuffer();
}

async function exists(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => null)) !== null;
}

let owner: number;
let member: number;
let outsider: number;
let groupId: number;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "0", permissions: [] });
  mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-parts-"));
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

describe("who sees and changes a part", () => {
  it("group members see and edit it, only the owner shares or deletes it, others see nothing", async () => {
    const { id } = await createPart(owner, {
      name: "Dichtung 3/4 Zoll",
      storageLocation: "Hauswirtschaftsraum, Schublade 2",
      stock: 4,
      groupId,
    });

    expect((await listParts(member)).map((p) => p.id)).toContain(id);
    await updatePart(member, id, { specification: "EPDM, 24 × 17 mm" });
    expect((await getPartDetail(owner, id)).specification).toBe("EPDM, 24 × 17 mm");
    await expect(updatePart(member, id, { groupId: null })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(deletePart(member, id)).rejects.toMatchObject({ code: "permission_denied" });

    expect((await listParts(outsider)).map((p) => p.id)).not.toContain(id);
    await expect(getPartDetail(outsider, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updatePart(outsider, id, { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(adjustStock(outsider, id, -1)).rejects.toMatchObject({ code: "not_found" });
    await expect(deletePart(outsider, id)).rejects.toMatchObject({ code: "not_found" });

    await deletePart(owner, id);
    await expect(getPartDetail(owner, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks the web address and the EAN", () => {
    expect(normalizeUrl("https://shop.example.test/teil?nr=1")).toBe("https://shop.example.test/teil?nr=1");
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/http/);
    expect(() => normalizeUrl("kein link")).toThrow();
    expect(normalizeEan("4006 3810 0000 1")).toBe("4006381000001");
    expect(() => normalizeEan("12-34")).toThrow();
  });
});

describe("stock", () => {
  it("takes out and puts back in one step and never goes below zero", async () => {
    const { id } = await createPart(owner, { name: "Filterkartusche", stock: 1 });
    expect(await adjustStock(owner, id, -1)).toBe(0);
    await expect(adjustStock(owner, id, -1)).rejects.toMatchObject({ code: "failed_precondition" });
    expect((await listParts(owner, { empty: true })).map((p) => p.id)).toEqual([id]);
    expect(await adjustStock(owner, id, 3)).toBe(3);
    expect(await listParts(owner, { empty: true })).toEqual([]);
  });

  it("a part that is not counted refuses a delta, a number can be set later", async () => {
    const { id } = await createPart(owner, { name: "Schrauben 4 × 30" });
    await expect(adjustStock(owner, id, -1)).rejects.toMatchObject({ code: "failed_precondition" });
    await updatePart(owner, id, { stock: 20 });
    expect(await adjustStock(owner, id, -2)).toBe(18);
    await expect(updatePart(owner, id, { stock: -1 })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("parts and systems", () => {
  it("a part fits several systems and shows up on each, the search finds the system by the part", async () => {
    const { id: pump } = await createSystem(owner, { name: "Gartenpumpe", category: "garden", groupId });
    const { id: heater } = await createSystem(owner, { name: "Heizung", category: "heating", groupId });
    const { id: seal } = await createPart(owner, { name: "O-Ring 20 × 3", partNumber: "OR-2030", groupId });

    await setSystemParts(member, pump, [seal]);
    await setSystemParts(member, heater, [seal]);
    expect((await getSystemDetail(owner, pump)).parts.map((p) => p.name)).toEqual(["O-Ring 20 × 3"]);
    expect((await getPartDetail(owner, seal)).systems.map((s) => s.name)).toEqual(["Gartenpumpe", "Heizung"]);
    expect((await listParts(owner, { systemId: heater })).map((p) => p.id)).toEqual([seal]);

    const found = (await listSystems(member, { q: "OR-2030" })).map((s) => [s.name, s.matches]);
    expect(found).toEqual([
      ["Gartenpumpe", ["Ersatzteil „O-Ring 20 × 3“"]],
      ["Heizung", ["Ersatzteil „O-Ring 20 × 3“"]],
    ]);
    expect(await listSystems(outsider, { q: "OR-2030" })).toEqual([]);

    await setSystemParts(owner, pump, []);
    expect((await getSystemDetail(owner, pump)).parts).toEqual([]);
  });

  it("a part someone else cannot see stays linked when they change the links", async () => {
    const { id: system } = await createSystem(owner, { name: "Enthärtung", category: "water", groupId });
    const { id: privatePart } = await createPart(owner, { name: "Salztabletten", groupId: null });
    const { id: shared } = await createPart(owner, { name: "Dichtung", groupId });
    await setSystemParts(owner, system, [privatePart, shared]);

    expect((await getSystemDetail(member, system)).parts.map((p) => p.name)).toEqual(["Dichtung"]);
    await setSystemParts(member, system, []);
    expect((await getSystemDetail(owner, system)).parts.map((p) => p.name)).toEqual(["Salztabletten"]);
    await expect(setSystemParts(member, system, [privatePart])).rejects.toMatchObject({ code: "not_found" });
  });

  it("an item names its part, which then fits the system; a deleted part leaves the item", async () => {
    const { id: system } = await createSystem(owner, { name: "Wasserhähne", category: "sanitary", groupId });
    const { id: aerator } = await createPart(owner, { name: "Perlator M24", groupId });
    const { id: item } = await createItem(member, system, { label: "Küche", partId: aerator });
    await createItem(member, system, { label: "Bad" });

    let detail = await getSystemDetail(owner, system);
    expect(detail.items.map((i) => [i.label, i.partName])).toEqual([["Küche", "Perlator M24"], ["Bad", null]]);
    expect(detail.parts.map((p) => p.id)).toEqual([aerator]);
    expect((await getPartDetail(owner, aerator)).items.map((i) => i.label)).toEqual(["Küche"]);

    const { id: hidden } = await createPart(outsider, { name: "Fremdes Teil" });
    await expect(updateItem(member, system, item, { partId: hidden })).rejects.toMatchObject({ code: "not_found" });

    await deletePart(owner, aerator);
    detail = await getSystemDetail(owner, system);
    expect(detail.items.map((i) => [i.label, i.partId])).toEqual([["Küche", null], ["Bad", null]]);
    expect(detail.parts).toEqual([]);
  });
});

describe("photos of a part", () => {
  it("follow the part, go with it and are cleaned up by the sweep", async () => {
    const { id } = await createPart(owner, { name: "Pumpenrad", groupId });
    const media = await uploadPartMedia(member, id, { bytes: await drawnJpeg() });
    expect(media).toMatchObject({ targetKind: "part", targetId: id });
    expect((await getPartDetail(owner, id)).media.map((m) => m.id)).toEqual([media.id]);
    expect((await listParts(owner)).find((p) => p.id === id)?.coverMediaId).toBe(media.id);

    await expect(mediaFile(member, media.id, "small")).resolves.toBeTruthy();
    await expect(mediaFile(outsider, media.id, "small")).rejects.toMatchObject({ code: "not_found" });
    await expect(uploadPartMedia(outsider, id, { bytes: await drawnJpeg() })).rejects.toMatchObject({
      code: "not_found",
    });

    const { id: system } = await createSystem(owner, { name: "Pumpe", category: "garden" });
    await expect(
      uploadMedia(owner, system, { targetKind: "part", targetId: id, bytes: await drawnJpeg() }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    const [row] = await db.select().from(homeMedia).where(eq(homeMedia.id, media.id));
    await deletePart(owner, id);
    expect(await exists(mediaFilePath(row.object_key, "full"))).toBe(false);
    expect(await db.select().from(homeMedia).where(eq(homeMedia.id, media.id))).toEqual([]);
  });

  it("the sweep removes a part's photo whose part is gone", async () => {
    const [orphan] = await db
      .insert(homeMedia)
      .values({ system_id: null, target_kind: "part", target_id: 2_000_000_000, object_key: "part-2000000000/verwaist", width: 1, height: 1 })
      .returning();
    await fs.mkdir(path.dirname(mediaFilePath(orphan.object_key, "full")), { recursive: true });
    await fs.writeFile(mediaFilePath(orphan.object_key, "full"), "x");

    expect((await sweepHomeMedia(new Date())).rows).toBeGreaterThanOrEqual(1);
    expect(await exists(mediaFilePath(orphan.object_key, "full"))).toBe(false);
  });
});
