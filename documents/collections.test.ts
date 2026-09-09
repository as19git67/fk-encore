import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  addCollectionDocuments,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  listCollectionsForDocument,
  membersFitVisibility,
  removeCollectionDocument,
  reorderCollection,
  resolveOrder,
  updateCollection,
  updateCollectionItem,
  collectionPdfFilename,
} from "./collections";
import { refreshStaleCollectionSummaries } from "./collection-summary-cron";

const OWNER_ID = 940_101;
const MEMBER_ID = 940_102;
const STRANGER_ID = 940_103;
const GROUP_ID = 940_201;

const PERMISSIONS = ["module.documents", "documents.view", "documents.edit"];

function auth(userId: number, extra: string[] = []): void {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: [...PERMISSIONS, ...extra],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@collections.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
/** Insert a document and return its id. */
async function insertDoc(opts: {
  userId?: number;
  title?: string;
  sender?: string | null;
  visibility?: "private" | "group";
  groupId?: number | null;
} = {}): Promise<number> {
  seq += 1;
  const sha = `col-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, title, sender, doc_date, summary, visibility, group_id)
    VALUES
      (${opts.userId ?? OWNER_ID}, ${sha}, ${`doc-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/col-${seq}.pdf`}, 'ready',
       ${opts.title ?? `Dokument ${seq}`}, ${opts.sender ?? "Beispiel GmbH"},
       '2024-05-06', ${`Zusammenfassung ${seq}`},
       ${opts.visibility ?? "private"}, ${opts.groupId ?? null})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM document_collections
     WHERE user_id IN (${OWNER_ID}, ${MEMBER_ID}, ${STRANGER_ID})
  `);
  await db.execute(sql`
    DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${MEMBER_ID}, ${STRANGER_ID})
  `);
  await db.execute(sql`DELETE FROM group_members WHERE group_id = ${GROUP_ID}`);
  await db.execute(sql`DELETE FROM groups WHERE id = ${GROUP_ID}`);
  await db.execute(
    sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${MEMBER_ID}, ${STRANGER_ID})`,
  );
}

async function seedGroup(): Promise<void> {
  await db.execute(sql`
    INSERT INTO groups (id, slug, name) VALUES (${GROUP_ID}, ${`g${GROUP_ID}`}, 'Haushalt')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO group_members (group_id, user_id, role)
    VALUES (${GROUP_ID}, ${OWNER_ID}, 'owner'), (${GROUP_ID}, ${MEMBER_ID}, 'member')
    ON CONFLICT DO NOTHING
  `);
}

beforeEach(async () => {
  await cleanup();
  await ensureUser(OWNER_ID);
  await ensureUser(MEMBER_ID);
  await ensureUser(STRANGER_ID);
  auth(OWNER_ID);
});

afterAll(async () => {
  await cleanup();
});

describe("resolveOrder", () => {
  it("takes the requested order", () => {
    const current = [{ document_id: 1 }, { document_id: 2 }, { document_id: 3 }];
    expect(resolveOrder(current, [3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("appends members the caller did not mention, in their existing order", () => {
    // A client list that predates somebody else's addition must reorder what
    // it knows about without dropping the newcomer.
    const current = [{ document_id: 1 }, { document_id: 2 }, { document_id: 3 }];
    expect(resolveOrder(current, [3])).toEqual([3, 1, 2]);
  });

  it("ignores ids that are not in the collection, and duplicates", () => {
    const current = [{ document_id: 1 }, { document_id: 2 }];
    expect(resolveOrder(current, [2, 2, 99, 1])).toEqual([2, 1]);
  });
});

describe("membersFitVisibility", () => {
  it("accepts anything in a private collection", () => {
    expect(
      membersFitVisibility({ visibility: "private", group_id: null }, [
        { id: 1, visibility: "private", group_id: null },
      ]),
    ).toEqual([]);
  });

  it("names the members a group collection would hide from its readers", () => {
    expect(
      membersFitVisibility({ visibility: "group", group_id: 7 }, [
        { id: 1, visibility: "group", group_id: 7 },
        { id: 2, visibility: "private", group_id: null },
        { id: 3, visibility: "group", group_id: 8 },
      ]),
    ).toEqual([2, 3]);
  });
});

describe("collectionPdfFilename", () => {
  it("derives a safe filename from the title", () => {
    expect(collectionPdfFilename("Steuer 2024 / Belege")).toBe("Steuer-2024-Belege.pdf");
  });

  it("falls back when the title has nothing usable", () => {
    expect(collectionPdfFilename("///")).toBe("sammelmappe.pdf");
  });
});

describe("collections CRUD", () => {
  it("creates a collection and seeds it in the given order", async () => {
    const a = await insertDoc({ title: "Erstes" });
    const b = await insertDoc({ title: "Zweites" });
    const detail = await createCollection({
      title: "  Steuer 2024  ",
      notes: "Für den Steuerberater",
      document_ids: [b, a],
    });
    expect(detail.title).toBe("Steuer 2024");
    expect(detail.notes).toBe("Für den Steuerberater");
    expect(detail.visibility).toBe("private");
    expect(detail.items.map((i) => i.document_id)).toEqual([b, a]);
    expect(detail.items.map((i) => i.position)).toEqual([0, 1]);
    expect(detail.item_count).toBe(2);
    expect(detail.included_count).toBe(2);
    expect(detail.summary_stale).toBe(true);
  });

  it("refuses an empty title", async () => {
    await expect(createCollection({ title: "   " })).rejects.toThrow(/title/);
  });

  it("lists only what the caller may read", async () => {
    const mine = await createCollection({ title: "Meine Mappe" });
    auth(STRANGER_ID);
    const seen = await listCollections({});
    expect(seen.items.map((c) => c.id)).not.toContain(mine.id);
    await expect(getCollection({ id: mine.id })).rejects.toThrow(/not found/);
  });

  it("lets a data admin read a foreign collection", async () => {
    const mine = await createCollection({ title: "Meine Mappe" });
    auth(STRANGER_ID, ["data.manage"]);
    const detail = await getCollection({ id: mine.id });
    expect(detail.title).toBe("Meine Mappe");
  });

  it("deletes a collection without touching its documents", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Weg damit", document_ids: [doc] });
    await deleteCollection({ id: collection.id });
    await expect(getCollection({ id: collection.id })).rejects.toThrow(/not found/);
    const remaining = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM documents WHERE id = ${doc}`,
    );
    expect(remaining.rows[0]!.count).toBe(1);
  });
});

describe("collection membership", () => {
  it("adds documents once, appending to the end", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [a] });
    const after = await addCollectionDocuments({ id: collection.id, document_ids: [a, b] });
    expect(after.items.map((i) => i.document_id)).toEqual([a, b]);
    expect(after.items.map((i) => i.position)).toEqual([0, 1]);
  });

  it("lets the same document sit in two collections", async () => {
    const doc = await insertDoc();
    const first = await createCollection({ title: "Steuer", document_ids: [doc] });
    const second = await createCollection({ title: "Versicherung", document_ids: [doc] });
    const refs = await listCollectionsForDocument({ id: doc });
    expect(refs.items.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("trims a document differently in each collection it is in", async () => {
    const doc = await insertDoc();
    const first = await createCollection({ title: "Ganz", document_ids: [doc] });
    const second = await createCollection({ title: "Nur letzte Seite", document_ids: [doc] });
    await updateCollectionItem({
      id: second.id,
      documentId: doc,
      excluded_pages: [1, 2],
    });
    expect((await getCollection({ id: first.id })).items[0].excluded_pages).toEqual([]);
    expect((await getCollection({ id: second.id })).items[0].excluded_pages).toEqual([1, 2]);
  });

  it("refuses to add a document the caller cannot see", async () => {
    const foreign = await insertDoc({ userId: STRANGER_ID });
    const collection = await createCollection({ title: "Mappe" });
    await expect(
      addCollectionDocuments({ id: collection.id, document_ids: [foreign] }),
    ).rejects.toThrow(/not found/);
  });

  it("removes a document and closes the gap in the order", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    const c = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [a, b, c] });
    const after = await removeCollectionDocument({ id: collection.id, documentId: b });
    expect(after.items.map((i) => i.document_id)).toEqual([a, c]);
    expect(after.items.map((i) => i.position)).toEqual([0, 1]);
  });

  it("reorders the members", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    const c = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [a, b, c] });
    const after = await reorderCollection({ id: collection.id, document_ids: [c, a, b] });
    expect(after.items.map((i) => i.document_id)).toEqual([c, a, b]);
    expect(after.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("switches a document off without forgetting its page selection", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [doc] });
    await updateCollectionItem({ id: collection.id, documentId: doc, excluded_pages: [2] });
    const off = await updateCollectionItem({
      id: collection.id,
      documentId: doc,
      included: false,
    });
    expect(off.items[0].included).toBe(false);
    expect(off.items[0].excluded_pages).toEqual([2]);
    expect(off.item_count).toBe(1);
    expect(off.included_count).toBe(0);
  });

  it("normalizes a page selection on write", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [doc] });
    const after = await updateCollectionItem({
      id: collection.id,
      documentId: doc,
      excluded_pages: [3, 1, 3, 0],
    });
    expect(after.items[0].excluded_pages).toEqual([1, 3]);
  });

  it("refuses to change a document that is not in the collection", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Mappe" });
    await expect(
      updateCollectionItem({ id: collection.id, documentId: doc, included: false }),
    ).rejects.toThrow(/not in this collection/);
  });
});

describe("collection visibility", () => {
  beforeEach(async () => {
    await seedGroup();
    auth(OWNER_ID);
  });

  it("shares a collection with a group the caller belongs to", async () => {
    const doc = await insertDoc({ visibility: "group", groupId: GROUP_ID });
    const collection = await createCollection({
      title: "Haushalt",
      visibility: "group",
      group_id: GROUP_ID,
      document_ids: [doc],
    });
    auth(MEMBER_ID);
    const seen = await getCollection({ id: collection.id });
    expect(seen.title).toBe("Haushalt");
    expect(seen.items.map((i) => i.document_id)).toEqual([doc]);
  });

  it("keeps a private document out of a group collection", async () => {
    const privateDoc = await insertDoc({ visibility: "private" });
    const collection = await createCollection({
      title: "Haushalt",
      visibility: "group",
      group_id: GROUP_ID,
    });
    await expect(
      addCollectionDocuments({ id: collection.id, document_ids: [privateDoc] }),
    ).rejects.toThrow(/shared with the same group/);
  });

  it("refuses to share a collection that holds a private document", async () => {
    const privateDoc = await insertDoc({ visibility: "private" });
    const collection = await createCollection({ title: "Mappe", document_ids: [privateDoc] });
    await expect(
      updateCollection({ id: collection.id, visibility: "group", group_id: GROUP_ID }),
    ).rejects.toThrow(/shared with the same group/);
  });

  it("lets a group member edit a shared collection but not delete it", async () => {
    const doc = await insertDoc({ visibility: "group", groupId: GROUP_ID });
    const collection = await createCollection({
      title: "Haushalt",
      visibility: "group",
      group_id: GROUP_ID,
      document_ids: [doc],
    });
    auth(MEMBER_ID);
    const renamed = await updateCollection({ id: collection.id, title: "Haushalt 2024" });
    expect(renamed.title).toBe("Haushalt 2024");
    expect(renamed.can_administer).toBe(false);
    await expect(deleteCollection({ id: collection.id })).rejects.toThrow(/creator or a group owner/);
  });

  it("refuses to share into a group the caller does not belong to", async () => {
    auth(STRANGER_ID);
    await expect(
      createCollection({ title: "Fremd", visibility: "group", group_id: GROUP_ID }),
    ).rejects.toThrow(/not a member/);
  });
});

describe("collection summary staleness", () => {
  it("marks the summary stale on every change that alters the folder", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [a, b] });

    // A hand-written summary pins the text: the job must not overwrite it.
    const pinned = await updateCollection({ id: collection.id, summary: "Von Hand." });
    expect(pinned.summary).toBe("Von Hand.");
    expect(pinned.summary_stale).toBe(false);

    const reordered = await reorderCollection({ id: collection.id, document_ids: [b, a] });
    expect(reordered.summary_stale).toBe(true);
  });

  it("clears the summary of a collection that ran empty, without a model run", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Leer", document_ids: [doc] });
    await updateCollection({ id: collection.id, summary: "Beschreibt ein Dokument." });
    await removeCollectionDocument({ id: collection.id, documentId: doc });

    const result = await refreshStaleCollectionSummaries(50);
    expect(result.emptied).toBeGreaterThanOrEqual(1);
    const after = await getCollection({ id: collection.id });
    expect(after.summary).toBeNull();
    expect(after.summary_stale).toBe(false);
  });
});
