import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { listDocuments } from "./documents";
import {
  addCollectionDocuments,
  collectionMembershipCondition,
  createCollection,
  listCollections,
} from "./collections";

const OWNER_ID = 940_301;
const OTHER_ID = 940_302;

function auth(userId: number): void {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["module.documents", "documents.view", "documents.edit"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@collection-list.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
async function insertDoc(opts: { userId?: number; title?: string } = {}): Promise<number> {
  seq += 1;
  const sha = `col-list-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, title, sender, doc_date, visibility)
    VALUES
      (${opts.userId ?? OWNER_ID}, ${sha}, ${`doc-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/col-list-${seq}.pdf`}, 'ready',
       ${opts.title ?? `Dokument ${seq}`}, 'Beispiel GmbH', '2024-05-06', 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM document_collections WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`,
  );
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_ID})`);
}

beforeEach(async () => {
  await cleanup();
  await ensureUser(OWNER_ID);
  await ensureUser(OTHER_ID);
  auth(OWNER_ID);
});

afterAll(async () => {
  await cleanup();
});

describe("collectionMembershipCondition", () => {
  it("asks for nothing when neither option is given", () => {
    expect(collectionMembershipCondition({})).toBeNull();
    expect(collectionMembershipCondition({ in_collection: undefined })).toBeNull();
  });

  it("produces a condition for each of the three requests", () => {
    expect(collectionMembershipCondition({ in_collection: true })).not.toBeNull();
    expect(collectionMembershipCondition({ in_collection: false })).not.toBeNull();
    expect(collectionMembershipCondition({ collection_id: 7 })).not.toBeNull();
  });

  it("ignores a collection_id that is not a number", () => {
    expect(collectionMembershipCondition({ collection_id: Number.NaN })).toBeNull();
  });
});

describe("documents list with Sammelmappen", () => {
  it("still lists a document that sits in a folder", async () => {
    // The point of the design: a folder is a bundle for handing over, not a
    // filing location, so nothing disappears from "Alle Dokumente".
    const doc = await insertDoc({ title: "Lohnsteuerbescheinigung" });
    await createCollection({ title: "Steuer 2024", document_ids: [doc] });

    const res = await listDocuments({ limit: 200 });
    expect(res.items.map((d) => d.id)).toContain(doc);
  });

  it("names the folders a document is in on the row", async () => {
    const doc = await insertDoc();
    const first = await createCollection({ title: "Steuer 2024", document_ids: [doc] });
    const second = await createCollection({ title: "Versicherung", document_ids: [doc] });

    const res = await listDocuments({ limit: 200 });
    const row = res.items.find((d) => d.id === doc)!;
    expect(row.collections.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(row.collections.map((c) => c.title)).toContain("Steuer 2024");
  });

  it("leaves the chip empty for a document in no folder", async () => {
    const doc = await insertDoc();
    const res = await listDocuments({ limit: 200 });
    expect(res.items.find((d) => d.id === doc)!.collections).toEqual([]);
  });

  it("does not name somebody else's private folder on a document", async () => {
    // Only reachable via a data admin, but the guard belongs in the query:
    // a folder the caller cannot open must not announce itself.
    const doc = await insertDoc();
    await createCollection({ title: "Meine Mappe", document_ids: [doc] });

    const foreign = await insertDoc({ userId: OTHER_ID });
    auth(OTHER_ID);
    await createCollection({ title: "Fremde Mappe", document_ids: [foreign] });

    auth(OWNER_ID);
    const res = await listDocuments({ limit: 200 });
    const titles = res.items.flatMap((d) => d.collections.map((c) => c.title));
    expect(titles).toContain("Meine Mappe");
    expect(titles).not.toContain("Fremde Mappe");
  });

  it("keeps only unbundled documents with in_collection=false", async () => {
    const bundled = await insertDoc({ title: "Gebündelt" });
    const loose = await insertDoc({ title: "Lose" });
    await createCollection({ title: "Mappe", document_ids: [bundled] });

    const res = await listDocuments({ in_collection: false, limit: 200 });
    const ids = res.items.map((d) => d.id);
    expect(ids).toContain(loose);
    expect(ids).not.toContain(bundled);
    expect(res.total).toBe(ids.length);
  });

  it("keeps only bundled documents with in_collection=true", async () => {
    const bundled = await insertDoc();
    const loose = await insertDoc();
    await createCollection({ title: "Mappe", document_ids: [bundled] });

    const ids = (await listDocuments({ in_collection: true, limit: 200 })).items.map((d) => d.id);
    expect(ids).toContain(bundled);
    expect(ids).not.toContain(loose);
  });

  it("keeps only the members of one named folder", async () => {
    const inFolder = await insertDoc();
    const elsewhere = await insertDoc();
    const collection = await createCollection({ title: "Steuer", document_ids: [inFolder] });
    await createCollection({ title: "Andere", document_ids: [elsewhere] });

    const ids = (
      await listDocuments({ collection_id: collection.id, limit: 200 })
    ).items.map((d) => d.id);
    expect(ids).toEqual([inFolder]);
  });

  it("lets a named folder win over the in_collection flag", async () => {
    const inFolder = await insertDoc();
    const collection = await createCollection({ title: "Steuer", document_ids: [inFolder] });

    const ids = (
      await listDocuments({ collection_id: collection.id, in_collection: false, limit: 200 })
    ).items.map((d) => d.id);
    expect(ids).toEqual([inFolder]);
  });

  it("still sees a document that was taken out of its folder", async () => {
    const doc = await insertDoc();
    const collection = await createCollection({ title: "Mappe", document_ids: [doc] });
    await db.execute(
      sql`DELETE FROM document_collection_items WHERE collection_id = ${collection.id}`,
    );

    const ids = (await listDocuments({ in_collection: false, limit: 200 })).items.map((d) => d.id);
    expect(ids).toContain(doc);
  });
});

describe("listCollections search", () => {
  it("matches a folder on its own title, note and summary", async () => {
    const created = await createCollection({
      title: "Unterlagen Steuerberater",
      notes: "Für die Einkommensteuer",
    });
    await db.execute(
      sql`UPDATE document_collections SET summary = 'Enthält Belege des Jahres.'
           WHERE id = ${created.id}`,
    );

    expect((await listCollections({ q: "steuerberater" })).items.map((c) => c.id)).toContain(
      created.id,
    );
    expect((await listCollections({ q: "Einkommensteuer" })).items.map((c) => c.id)).toContain(
      created.id,
    );
    expect((await listCollections({ q: "Belege" })).items.map((c) => c.id)).toContain(created.id);
  });

  it("does not match a folder on the words of its documents", async () => {
    // A folder that matched because one of forty documents mentions the term
    // would be a result nobody can explain — and the document itself already
    // appears in the document results.
    const doc = await insertDoc({ title: "Handwerkerrechnung" });
    const created = await createCollection({ title: "Mappe", document_ids: [doc] });
    await addCollectionDocuments({ id: created.id, document_ids: [doc] });

    expect((await listCollections({ q: "Handwerkerrechnung" })).items).toEqual([]);
  });

  it("returns everything readable when no term is given", async () => {
    const created = await createCollection({ title: "Irgendeine Mappe" });
    expect((await listCollections({})).items.map((c) => c.id)).toContain(created.id);
  });
});
