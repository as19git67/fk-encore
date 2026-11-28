import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { groupMembers, groups, homeSystemGuideRevisions, homeSystemNotes, users } from "../db/schema";
import { setHousehold } from "../meter/household.service";
import {
  createGuide,
  createItem,
  createNote,
  createSystem,
  deleteGuide,
  deleteItem,
  deleteNote,
  deleteSystem,
  getSystemDetail,
  listGuideRevisions,
  listSystems,
  normalizeAttributes,
  restoreGuideRevision,
  todayInHouse,
  updateGuide,
  updateNote,
  updateSystem,
} from "./systems.service";

// Every system, guide and item here is invented.

const cleanupUserIds: number[] = [];
const cleanupGroupIds: number[] = [];

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `home-test-${label}-${Date.now()}-${Math.random()}@example.test`,
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
    .values({ slug: `home-${Date.now()}-${Math.random()}`, name: "Familie" })
    .returning({ id: groups.id });
  cleanupGroupIds.push(row.id);
  await db.insert(groupMembers).values({ group_id: row.id, user_id: ownerId, role: "owner" });
  for (const userId of memberIds) {
    await db.insert(groupMembers).values({ group_id: row.id, user_id: userId, role: "member" });
  }
  return row.id;
}

let owner: number;
let member: number;
let outsider: number;
let groupId: number;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "0", permissions: [] });
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
  vi.restoreAllMocks();
});

describe("visibility", () => {
  it("goes to the creator's household when no group is chosen", async () => {
    await setHousehold(owner, groupId);
    const { id } = await createSystem(member, { name: "Enthärtungsanlage", category: "water" });
    const detail = await getSystemDetail(owner, id);
    expect(detail).toMatchObject({ groupId, household: true, ownerUserId: member });
  });

  it("stays private with groupId null, and without a household", async () => {
    await setHousehold(owner, groupId);
    const { id: privateId } = await createSystem(owner, { name: "Werkbank", category: "other", groupId: null });
    expect((await getSystemDetail(owner, privateId)).groupId).toBeNull();
    await expect(getSystemDetail(member, privateId)).rejects.toMatchObject({ code: "not_found" });

    const { id: soloId } = await createSystem(outsider, { name: "Gartenpumpe", category: "garden" });
    expect((await getSystemDetail(outsider, soloId)).groupId).toBeNull();
  });

  it("refuses a group the caller is not in", async () => {
    await expect(
      createSystem(outsider, { name: "Lüftung", category: "ventilation", groupId }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  // Who sees and who may change what, in one table.
  it("follows the matrix: owner, group owner, member, outsider", async () => {
    const { id } = await createSystem(member, { name: "Lüftungsanlage", category: "ventilation", groupId });

    // Seeing it.
    expect((await listSystems(member)).map((s) => s.id)).toContain(id);
    expect((await listSystems(owner)).map((s) => s.id)).toContain(id);
    expect((await listSystems(outsider)).map((s) => s.id)).not.toContain(id);
    await expect(getSystemDetail(outsider, id)).rejects.toMatchObject({ code: "not_found" });

    // Changing the system itself: its owner (member) and the group's owner.
    expect((await getSystemDetail(member, id)).canManage).toBe(true);
    expect((await getSystemDetail(owner, id)).canManage).toBe(true);
    await updateSystem(owner, id, { location: "Dachboden" });
    expect((await getSystemDetail(member, id)).location).toBe("Dachboden");

    // A second member sees it and may write guides, items and notes, but not
    // change the system.
    const second = await createUser("second");
    await db.insert(groupMembers).values({ group_id: groupId, user_id: second, role: "member" });
    expect((await getSystemDetail(second, id)).canManage).toBe(false);
    await expect(updateSystem(second, id, { name: "Anders" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(deleteSystem(second, id)).rejects.toMatchObject({ code: "permission_denied" });
    await createGuide(second, id, { title: "Filter wechseln", body: "1. Gerät ausschalten" });
    await createItem(second, id, { label: "Zuluft Bad" });
    await createNote(second, id, { body: "Filter getauscht" });

    // The outsider can do nothing, and learns nothing about its existence.
    await expect(updateSystem(outsider, id, { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createGuide(outsider, id, { title: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createItem(outsider, id, { label: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createNote(outsider, id, { body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteSystem(outsider, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not reach a guide, item or note of another system through a visible one", async () => {
    const { id: mine } = await createSystem(outsider, { name: "Mein Boiler", category: "heating" });
    const { id: theirs } = await createSystem(owner, { name: "Heizung", category: "heating", groupId: null });
    const { id: guideId } = await createGuide(owner, theirs, { title: "Entlüften" });
    const { id: itemId } = await createItem(owner, theirs, { label: "Heizkörper Bad" });
    const { id: noteId } = await createNote(owner, theirs, { body: "Druck geprüft" });

    await expect(updateGuide(outsider, mine, guideId, { body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteGuide(outsider, mine, guideId)).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteItem(outsider, mine, itemId)).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteNote(outsider, mine, noteId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("guides", () => {
  it("keeps the earlier version of every edit and puts one back", async () => {
    const { id } = await createSystem(owner, { name: "Enthärtungsanlage", category: "water", groupId });
    const { id: guideId } = await createGuide(owner, id, { title: "Salz nachfüllen", body: "Version 1" });

    await updateGuide(member, id, guideId, { body: "Version 2" });
    await updateGuide(owner, id, guideId, { title: "Regeneriersalz nachfüllen", body: "Version 3" });
    // Only the order changes: no revision.
    await updateGuide(owner, id, guideId, { sort: 5 });

    const revisions = await listGuideRevisions(member, id, guideId);
    expect(revisions.map((r) => r.body)).toEqual(["Version 2", "Version 1"]);
    expect(revisions[0].editedByName).toBe("Tester member");

    // Undo the last edit: version 2 comes back, version 3 becomes a revision.
    await restoreGuideRevision(member, id, guideId, revisions[0].id);
    const detail = await getSystemDetail(owner, id);
    expect(detail.guides[0]).toMatchObject({
      title: "Salz nachfüllen",
      body: "Version 2",
      sort: 5,
      updatedByName: "Tester member",
      revisionCount: 3,
    });
    expect((await listGuideRevisions(owner, id, guideId))[0]).toMatchObject({
      title: "Regeneriersalz nachfüllen",
      body: "Version 3",
    });
  });

  it("refuses a revision of another guide", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    const { id: a } = await createGuide(owner, id, { title: "A", body: "a1" });
    const { id: b } = await createGuide(owner, id, { title: "B", body: "b1" });
    await updateGuide(owner, id, a, { body: "a2" });
    const [revisionOfA] = await listGuideRevisions(owner, id, a);
    await expect(restoreGuideRevision(owner, id, b, revisionOfA.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes its revisions with the guide", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    const { id: guideId } = await createGuide(owner, id, { title: "A", body: "1" });
    await updateGuide(owner, id, guideId, { body: "2" });
    await deleteGuide(owner, id, guideId);
    const left = await db
      .select()
      .from(homeSystemGuideRevisions)
      .where(eq(homeSystemGuideRevisions.guide_id, guideId));
    expect(left).toHaveLength(0);
  });

  it("numbers new guides after the existing ones", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    await createGuide(owner, id, { title: "Erste" });
    await createGuide(owner, id, { title: "Zweite" });
    expect((await getSystemDetail(owner, id)).guides.map((g) => [g.title, g.sort])).toEqual([
      ["Erste", 0],
      ["Zweite", 1],
    ]);
  });
});

describe("items and notes", () => {
  it("cleans up the key/value list of an item", () => {
    expect(
      normalizeAttributes([
        { key: " Gewinde ", value: " M24 " },
        { key: "", value: "" },
        { key: "Schlüsselweite", value: "" },
      ]),
    ).toEqual([
      { key: "Gewinde", value: "M24" },
      { key: "Schlüsselweite", value: "" },
    ]);
    expect(() => normalizeAttributes([{ key: "", value: "M24" }])).toThrow();
  });

  it("dates a note today by default and refuses the future", async () => {
    const { id } = await createSystem(owner, { name: "Gartenpumpe", category: "garden" });
    await createNote(owner, id, { body: "Winterfest gemacht" });
    await createNote(owner, id, { body: "Dichtung getauscht", notedOn: "2024-03-01" });
    const notes = (await getSystemDetail(owner, id)).notes;
    expect(notes.map((n) => n.notedOn)).toEqual([todayInHouse(), "2024-03-01"]);
    expect(notes[0].authorName).toBe("Tester owner");

    await expect(createNote(owner, id, { body: "x", notedOn: "2999-01-01" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(createNote(owner, id, { body: "x", notedOn: "2024-02-30" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await updateNote(owner, id, notes[1].id, { body: "Dichtung und Schelle getauscht" });
    expect((await getSystemDetail(owner, id)).notes[1].body).toBe("Dichtung und Schelle getauscht");
  });

  it("deletes guides, items and notes with the system", async () => {
    const { id } = await createSystem(owner, { name: "Gartenpumpe", category: "garden" });
    await createGuide(owner, id, { title: "Einwintern" });
    await createItem(owner, id, { label: "Ansaugschlauch" });
    const { id: noteId } = await createNote(owner, id, { body: "x" });
    await deleteSystem(owner, id);
    expect(await db.select().from(homeSystemNotes).where(eq(homeSystemNotes.id, noteId))).toHaveLength(0);
    await expect(getSystemDetail(owner, id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("list and search", () => {
  it("finds a system by a word in a guide, an item or a note, and says where", async () => {
    const { id: kitchen } = await createSystem(owner, { name: "Armaturen", category: "sanitary" });
    await createItem(owner, kitchen, {
      label: "Küche",
      location: "Spüle",
      attributes: [{ key: "Gewinde", value: "M24x1" }],
    });
    const { id: vent } = await createSystem(owner, { name: "Lüftungsanlage", category: "ventilation" });
    await createGuide(owner, vent, { title: "Filter wechseln", body: "Filterklasse ISO ePM1" });
    await createSystem(owner, { name: "Heizung", category: "heating" });

    const byAttr = await listSystems(owner, { q: "m24" });
    expect(byAttr.map((s) => s.id)).toEqual([kitchen]);
    expect(byAttr[0].matches).toEqual(["Einzelteil „Küche“"]);

    const byBody = await listSystems(owner, { q: "epm1" });
    expect(byBody.map((s) => s.id)).toEqual([vent]);
    expect(byBody[0]).toMatchObject({ guideCount: 1, matches: ["Anleitung „Filter wechseln“"] });

    // A % in the term is a character, not a wildcard.
    expect(await listSystems(owner, { q: "%" })).toEqual([]);

    expect((await listSystems(owner, { category: "heating" })).map((s) => s.name)).toEqual(["Heizung"]);
  });

  it("shows archived systems only when asked", async () => {
    const { id } = await createSystem(owner, { name: "Alter Boiler", category: "heating" });
    await updateSystem(owner, id, { archived: true });
    expect((await listSystems(owner)).map((s) => s.id)).not.toContain(id);
    expect((await listSystems(owner, { archived: true })).map((s) => s.id)).toEqual([id]);
    await updateSystem(owner, id, { archived: false });
    expect((await listSystems(owner)).map((s) => s.id)).toContain(id);
  });

  it("counts notes and gives the newest date", async () => {
    const { id } = await createSystem(owner, { name: "Heizung", category: "heating" });
    await createNote(owner, id, { body: "a", notedOn: "2025-01-10" });
    await createNote(owner, id, { body: "b", notedOn: "2025-06-02" });
    const [row] = await listSystems(owner);
    expect(row).toMatchObject({ noteCount: 2, lastNoteOn: "2025-06-02" });
  });
});
