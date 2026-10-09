import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { collectRelatedDocuments, RELATED_NEARBY_DAYS } from "./related";

const OWNER_ID = 948_101;
const STRANGER_ID = 948_102;
const MEMBER_ID = 948_103;
const GROUP_ID = 948_201;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@related.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function ensureGroup(): Promise<void> {
  await db.execute(sql`
    INSERT INTO groups (id, slug, name) VALUES (${GROUP_ID}, 'related-test-group', 'Related Test')
    ON CONFLICT (id) DO NOTHING
  `);
  for (const uid of [OWNER_ID, MEMBER_ID]) {
    await db.execute(sql`
      INSERT INTO group_members (group_id, user_id, role) VALUES (${GROUP_ID}, ${uid}, 'member')
      ON CONFLICT DO NOTHING
    `);
  }
}

let seq = 0;
async function insertDoc(opts: {
  userId?: number;
  title?: string;
  folder?: string | null;
  correspondent?: string | null;
  docDate?: string | null;
  visibility?: "private" | "group";
  groupId?: number | null;
}): Promise<number> {
  seq += 1;
  const sha = `rel-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status,
       title, source_folder, correspondent_slug, correspondent_display, doc_date,
       visibility, group_id)
    VALUES
      (${opts.userId ?? OWNER_ID}, ${sha}, ${`rel-${seq}.pdf`}, 'application/pdf', 10,
       ${`/tmp/rel-${seq}.pdf`}, 'ready', ${opts.title ?? `Dokument ${seq}`},
       ${opts.folder ?? null}, ${opts.correspondent ?? null},
       ${opts.correspondent ? `Versicherer ${opts.correspondent}` : null},
       ${opts.docDate ?? null}, ${opts.visibility ?? "private"}, ${opts.groupId ?? null})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function loadDoc(id: number) {
  const r = await db.execute<any>(sql`SELECT * FROM documents WHERE id = ${id}`);
  return r.rows[0]!;
}

async function insertCollection(title: string, docIds: number[], userId = OWNER_ID): Promise<number> {
  const c = await db.execute<{ id: number }>(sql`
    INSERT INTO document_collections (user_id, title, visibility) VALUES (${userId}, ${title}, 'private')
    RETURNING id
  `);
  const id = c.rows[0]!.id;
  for (let i = 0; i < docIds.length; i++) {
    await db.execute(sql`
      INSERT INTO document_collection_items (collection_id, document_id, position)
      VALUES (${id}, ${docIds[i]}, ${i})
    `);
  }
  return id;
}

const ctx = { userId: OWNER_ID, groupIds: [GROUP_ID], isAdmin: false };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${OWNER_ID}, ${STRANGER_ID}, ${MEMBER_ID})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${STRANGER_ID}, ${MEMBER_ID})`);
}

describe("collectRelatedDocuments", () => {
  beforeEach(async () => {
    await ensureUser(OWNER_ID);
    await ensureUser(STRANGER_ID);
    await ensureUser(MEMBER_ID);
    await ensureGroup();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM group_members WHERE group_id = ${GROUP_ID}`);
    await db.execute(sql`DELETE FROM groups WHERE id = ${GROUP_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${STRANGER_ID}, ${MEMBER_ID})`);
  });

  it("groups by folder, then correspondent, then collection, without repeats", async () => {
    const police = await insertDoc({
      title: "Police", folder: "Versicherungen/Hausrat", correspondent: "beispiel-ag", docDate: "2024-03-10",
    });
    // Same folder AND same correspondent nearby: shown once, under the folder.
    const terms = await insertDoc({
      title: "Bedingungen", folder: "Versicherungen/Hausrat", correspondent: "beispiel-ag", docDate: "2024-03-10",
    });
    // Same correspondent, 20 days later, different folder.
    const letter = await insertDoc({
      title: "Beitragsanpassung", folder: "Posteingang", correspondent: "beispiel-ag", docDate: "2024-03-30",
    });
    // Same correspondent, far away in time: not nearby.
    await insertDoc({
      title: "Altes Schreiben", correspondent: "beispiel-ag", docDate: "2021-01-01",
    });
    // Same folder but another correspondent: still the same folder.
    const other = await insertDoc({ title: "Nachbar", folder: "Versicherungen/Hausrat" });
    // Collection member only.
    const bundled = await insertDoc({ title: "Mappenmitglied" });
    const collectionId = await insertCollection("Hausrat-Akte", [police, bundled, terms]);

    const groups = await collectRelatedDocuments(await loadDoc(police), ctx);
    expect(groups.map((g) => g.reason)).toEqual([
      "same_folder",
      "same_correspondent_nearby",
      "same_collection",
    ]);

    const folder = groups[0]!;
    expect(folder.label).toBe("Versicherungen/Hausrat");
    expect(folder.items.map((i) => i.id).sort()).toEqual([terms, other].sort());

    const nearby = groups[1]!;
    expect(nearby.label).toBe("Versicherer beispiel-ag");
    expect(nearby.items.map((i) => i.id)).toEqual([letter]);

    const coll = groups[2]!;
    expect(coll.collection_id).toBe(collectionId);
    expect(coll.label).toBe("Hausrat-Akte");
    // `terms` already appeared under the folder, so only `bundled` is left.
    expect(coll.items.map((i) => i.id)).toEqual([bundled]);
  });

  it("never names a document the caller cannot see", async () => {
    const mine = await insertDoc({ title: "Mein Brief", folder: "Gemeinsam", correspondent: "x-ag", docDate: "2024-05-01" });
    await insertDoc({
      userId: STRANGER_ID, title: "Fremder Brief", folder: "Gemeinsam", correspondent: "x-ag", docDate: "2024-05-02",
    });
    const shared = await insertDoc({
      userId: MEMBER_ID, title: "Gruppenbrief", folder: "Gemeinsam", visibility: "group", groupId: GROUP_ID,
    });

    const groups = await collectRelatedDocuments(await loadDoc(mine), ctx);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual([shared]);
  });

  it("returns no groups for a lone document", async () => {
    const lone = await insertDoc({ title: "Allein" });
    const groups = await collectRelatedDocuments(await loadDoc(lone), ctx);
    expect(groups).toEqual([]);
  });

  it("limits the nearby window to the configured days", async () => {
    const base = await insertDoc({ correspondent: "y-ag", docDate: "2024-06-15" });
    const inside = await insertDoc({ correspondent: "y-ag", docDate: "2024-07-10" });
    await insertDoc({ correspondent: "y-ag", docDate: "2024-08-01" });
    expect(RELATED_NEARBY_DAYS).toBe(30);

    const groups = await collectRelatedDocuments(await loadDoc(base), ctx);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([inside]);
  });
});
