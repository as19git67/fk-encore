import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";

// Keep the built files out of the working tree; must be set before the
// module computes its directory.
const exportDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || "/tmp"}/collection-export-test-${process.pid}`;
  process.env.DOCUMENTS_COLLECTIONS_DIR = dir;
  return dir;
});

import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import db from "../db/database";
import {
  awaitCollectionExport,
  createCollection,
  deleteCollection,
  getCollectionExport,
  startCollectionExport,
  updateCollection,
} from "./collections";
import {
  collectionExportFingerprint,
  collectionExportPath,
  type CollectionExportInputs,
} from "./collection-export";

/**
 * The Sammelmappe PDF is built in the background and kept: a client that
 * leaves and comes back finds the build running or its file waiting — and a
 * change to the folder throws the file away, so a stale PDF is never offered.
 *
 * The folders here have a cover and no members, so the build is pdfkit only
 * and needs neither qpdf nor real document files.
 */

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
    VALUES (${id}, ${`u${id}@collection-export.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`);
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
  fs.rmSync(exportDir, { recursive: true, force: true });
});

async function newFolder(include_cover = true): Promise<number> {
  const created = await createCollection({ title: "Unterlagen Beispiel" });
  if (!include_cover) await updateCollection({ id: created.id, include_cover: false });
  return created.id;
}

describe("collection export job", () => {
  it("has nothing to report before the first build", async () => {
    const id = await newFolder();
    expect((await getCollectionExport({ id })).status).toBe("none");
  });

  it("builds in the background and keeps the file", async () => {
    const id = await newFolder();
    const started = await startCollectionExport({ id });
    expect(["running", "done"]).toContain(started.status);

    await awaitCollectionExport(id, OWNER_ID);
    const done = await getCollectionExport({ id });
    expect(done.status).toBe("done");
    expect(done.page_count).toBe(1);
    expect(done.filename).toBe("Unterlagen-Beispiel.pdf");
    const bytes = fs.readFileSync(collectionExportPath(id, OWNER_ID));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(done.size_bytes).toBe(bytes.length);
  });

  it("throws the file away as soon as the folder changes", async () => {
    const id = await newFolder();
    await startCollectionExport({ id });
    await awaitCollectionExport(id, OWNER_ID);
    expect(fs.existsSync(collectionExportPath(id, OWNER_ID))).toBe(true);

    await updateCollection({ id, title: "Neuer Titel" });
    expect(fs.existsSync(collectionExportPath(id, OWNER_ID))).toBe(false);
    expect((await getCollectionExport({ id })).status).toBe("none");
  });

  it("throws the file away when what it was built from no longer matches", async () => {
    // A change the folder does not hear about directly — here simulated by a
    // row whose recorded inputs differ from the folder's.
    const id = await newFolder();
    await startCollectionExport({ id });
    await awaitCollectionExport(id, OWNER_ID);
    await db.execute(sql`
      UPDATE document_collection_exports SET fingerprint = 'veraltet'
       WHERE collection_id = ${id} AND user_id = ${OWNER_ID}
    `);
    expect((await getCollectionExport({ id })).status).toBe("none");
    expect(fs.existsSync(collectionExportPath(id, OWNER_ID))).toBe(false);
  });

  it("joins a build already running instead of starting a second", async () => {
    const id = await newFolder();
    const [a, b] = await Promise.all([startCollectionExport({ id }), startCollectionExport({ id })]);
    expect(a.status).not.toBe("failed");
    expect(b.status).not.toBe("failed");
    await awaitCollectionExport(id, OWNER_ID);
    expect((await getCollectionExport({ id })).status).toBe("done");
  });

  it("records a build that cannot produce anything as failed", async () => {
    const id = await newFolder(false);
    await startCollectionExport({ id });
    await awaitCollectionExport(id, OWNER_ID);
    const status = await getCollectionExport({ id });
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/keine Dokumente/);
  });

  it("reports a build cut off by a restart as interrupted", async () => {
    const id = await newFolder();
    await db.execute(sql`
      INSERT INTO document_collection_exports (collection_id, user_id, status)
      VALUES (${id}, ${OWNER_ID}, 'running')
    `);
    const status = await getCollectionExport({ id });
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/Unterbrochen/);
  });

  it("does not show one reader's build to another", async () => {
    const id = await newFolder();
    await startCollectionExport({ id });
    await awaitCollectionExport(id, OWNER_ID);
    auth(OTHER_ID);
    await expect(getCollectionExport({ id })).rejects.toThrow(/not found/);
  });

  it("removes the kept file with the folder", async () => {
    const id = await newFolder();
    await startCollectionExport({ id });
    await awaitCollectionExport(id, OWNER_ID);
    expect(fs.existsSync(collectionExportPath(id, OWNER_ID))).toBe(true);
    await deleteCollection({ id });
    expect(fs.existsSync(collectionExportPath(id, OWNER_ID))).toBe(false);
  });
});

describe("collectionExportFingerprint", () => {
  const base: CollectionExportInputs = {
    title: "Mappe",
    notes: null,
    summary: null,
    include_cover: true,
    include_toc: true,
    include_summary: true,
    members: [
      {
        document_id: 1,
        sha256: "a".repeat(64),
        disk_path: "/x/1.pdf",
        receipt_ocr_state: null,
        title: "Eins",
        original_filename: "1.pdf",
        sender: null,
        doc_date: null,
        excluded_pages: [],
        redactions: [],
      },
    ],
    not_visible: [],
  };

  it("is stable for the same inputs and moves with any of them", () => {
    expect(collectionExportFingerprint(base)).toBe(collectionExportFingerprint({ ...base }));
    expect(collectionExportFingerprint({ ...base, include_toc: false })).not.toBe(
      collectionExportFingerprint(base),
    );
    expect(
      collectionExportFingerprint({
        ...base,
        members: [{ ...base.members[0]!, excluded_pages: [2] }],
      }),
    ).not.toBe(collectionExportFingerprint(base));
    expect(
      collectionExportFingerprint({
        ...base,
        members: [{ ...base.members[0]!, redactions: [{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }],
      }),
    ).not.toBe(collectionExportFingerprint(base));
  });
});

