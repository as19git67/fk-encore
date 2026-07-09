import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents } from "../db/schema";
import { loadAdministrableDocument, loadVisibleDocument } from "./visibility";

// Owner uploads a private document; a second user (the `data.manage` admin)
// is not the owner and shares no group with them. Regression coverage for the
// "visible in the list but 'document not found' on open/delete" mismatch: an
// admin sees every document in `listDocuments`, so the single-document
// helpers must let that same admin load / administer them too.
const OWNER_ID = 991301;
const ADMIN_ID = 991302;
const DOC_ID = 991301;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await ensureUser(OWNER_ID);
  await ensureUser(ADMIN_ID);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, visibility)
        VALUES
          (${DOC_ID}, ${OWNER_ID}, ${`sha-${DOC_ID}`}, 'Image.pdf', 'application/pdf', 1,
           ${`/tmp/d-${DOC_ID}.pdf`}, 'ready', 'private')`,
  );
});

describe("loadVisibleDocument admin bypass", () => {
  it("hides another user's private document from a non-admin", async () => {
    await expect(loadVisibleDocument(ADMIN_ID, DOC_ID)).rejects.toThrow(/not found/i);
  });

  it("lets a data.manage admin load any document", async () => {
    const row = await loadVisibleDocument(ADMIN_ID, DOC_ID, true);
    expect(row.id).toBe(DOC_ID);
    expect(row.user_id).toBe(OWNER_ID);
  });
});

describe("loadAdministrableDocument admin bypass", () => {
  it("rejects a non-admin who is neither uploader nor group owner", async () => {
    await expect(loadAdministrableDocument(ADMIN_ID, DOC_ID)).rejects.toThrow();
  });

  it("lets a data.manage admin administer (delete/replace) any document", async () => {
    const row = await loadAdministrableDocument(ADMIN_ID, DOC_ID, true);
    expect(row.id).toBe(DOC_ID);
  });

  it("still lets the uploader administer their own document without admin", async () => {
    const row = await loadAdministrableDocument(OWNER_ID, DOC_ID);
    expect(row.id).toBe(DOC_ID);
  });
});
