import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { setTeacherRequested } from "./documents";

const USER_ID = 990701;
const DOC_ID = 990701;

function setAuth() {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["module.documents", "documents.edit"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedDocument(): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  const diskPath = path.join(DOCUMENTS_DIR, `u${USER_ID}`, "_inbox", "2026-01", `x-${DOC_ID}.pdf`);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'x.pdf', 'application/pdf', 1,
           ${diskPath}, 'ready', 'Ein Titel', 'private')`,
  );
}

async function readFlag() {
  const [row] = await db
    .select({
      requested: documents.teacher_requested,
      requestedAt: documents.teacher_requested_at,
    })
    .from(documents)
    .where(eq(documents.id, DOC_ID));
  return row!;
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  setAuth();
  await seedDocument();
});

describe("setTeacherRequested", () => {
  it("flags a document and stamps the request time", async () => {
    const detail = await setTeacherRequested({ id: DOC_ID, requested: true });

    expect(detail.teacher_requested).toBe(true);
    const row = await readFlag();
    expect(row.requested).toBe(true);
    expect(row.requestedAt).not.toBeNull();
  });

  it("clears the flag and the request time on un-flag", async () => {
    await setTeacherRequested({ id: DOC_ID, requested: true });

    const detail = await setTeacherRequested({ id: DOC_ID, requested: false });

    expect(detail.teacher_requested).toBe(false);
    const row = await readFlag();
    expect(row.requested).toBe(false);
    expect(row.requestedAt).toBeNull();
  });
});
