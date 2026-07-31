import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { updateDocument } from "./documents";

// A document whose classify step failed hard (see llm-client.ts: a 422 from
// the llm-service is a permanent failure, not a deferred retry) is parked in
// status='failed' with `last_error` set, and the detail view shows a red
// "Verarbeitung fehlgeschlagen" banner. Before this, nothing but a reclassify
// or a file replacement cleared that — so a user who simply typed in the
// correct metadata was left with a document permanently marked broken.

const USER_ID = 990701;
const DOC_ID = 990701;

const ERROR_TEXT =
  "POST http://llm_service:8000/classify returned 422: schema mismatch";

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

async function seedDocument(
  status: "failed" | "ready" | "encrypted",
  lastError: string | null,
): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  const diskPath = path.join(DOCUMENTS_DIR, `u${USER_ID}`, "_inbox", "2026-01", `x-${DOC_ID}.pdf`);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, doc_date, last_error, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'x.pdf', 'application/pdf', 1,
           ${diskPath}, ${status}, 'Rechnung', NULL, ${lastError}, 'private')`,
  );
}

async function readDoc() {
  const [row] = await db
    .select({
      status: documents.status,
      lastError: documents.last_error,
      docDate: documents.doc_date,
    })
    .from(documents)
    .where(eq(documents.id, DOC_ID));
  return row!;
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  setAuth();
});

describe("updateDocument — a hand-edit resolves a failed pipeline run", () => {
  it("clears status and last_error when the user fixes the date", async () => {
    await seedDocument("failed", ERROR_TEXT);

    const detail = await updateDocument({ id: DOC_ID, doc_date: "2019-04-01" });

    expect(detail.status).toBe("ready");
    expect(detail.last_error).toBeNull();

    const row = await readDoc();
    expect(row.status).toBe("ready");
    expect(row.lastError).toBeNull();
    expect(row.docDate).toBe("2019-04-01");
  });

  it("also clears it for an edit that does not pin the AI attributes", async () => {
    await seedDocument("failed", ERROR_TEXT);

    await updateDocument({ id: DOC_ID, notes: "Datum von Hand korrigiert" });

    const row = await readDoc();
    expect(row.status).toBe("ready");
    expect(row.lastError).toBeNull();
  });

  it("leaves the failure alone when the request changes nothing", async () => {
    await seedDocument("failed", ERROR_TEXT);

    await updateDocument({ id: DOC_ID });

    const row = await readDoc();
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe(ERROR_TEXT);
  });

  it("does not touch an encrypted document — that needs the PDF password", async () => {
    await seedDocument("encrypted", null);

    await updateDocument({ id: DOC_ID, title: "Neuer Titel" });

    const row = await readDoc();
    expect(row.status).toBe("encrypted");
  });

  it("leaves a healthy document's status untouched", async () => {
    await seedDocument("ready", null);

    await updateDocument({ id: DOC_ID, title: "Neuer Titel" });

    const row = await readDoc();
    expect(row.status).toBe("ready");
    expect(row.lastError).toBeNull();
  });
});
