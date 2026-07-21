import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents } from "../db/schema";
import { getDocumentText } from "./documents";

const USER_ID = 990801;
const OTHER_USER_ID = 990802;
const DOC_ID = 990801;

function setAuth(userId = USER_ID) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["module.documents", "documents.view"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function insertDoc(text: string | null): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/dt-${DOC_ID}.pdf`}, 'ready', ${text}, 'private')`,
  );
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  await ensureUser(OTHER_USER_ID);
  setAuth();
});

describe("getDocumentText", () => {
  it("returns the full extracted text, beyond the 2000-char detail preview", async () => {
    const text = "Anfang. " + "x".repeat(5000) + " Ende.";
    await insertDoc(text);

    const res = await getDocumentText({ id: DOC_ID });
    expect(res.text).toBe(text);
    expect(res.text!.length).toBeGreaterThan(2000);
  });

  it("returns null when no text was extracted", async () => {
    await insertDoc(null);
    expect((await getDocumentText({ id: DOC_ID })).text).toBeNull();

    await insertDoc("   ");
    expect((await getDocumentText({ id: DOC_ID })).text).toBeNull();
  });

  it("does not leak another user's private document", async () => {
    await insertDoc("geheim");
    setAuth(OTHER_USER_ID);
    await expect(getDocumentText({ id: DOC_ID })).rejects.toThrow(/not found/i);
  });
});
