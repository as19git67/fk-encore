import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq, sql } from "drizzle-orm";

// runClassify-adjacent paths aren't exercised here, but relocateDocument
// (called by the heal step) is import-clean; no Encore client stubs needed.
import db from "../db/database";
import { documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { runDocumentsFsck } from "./fsck";

const USER_ID = 990810;
const DOC_ID = 990890;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

// The uploader's owner-root slug is derived from the e-mail local-part
// (see slugifyUserLogin), so a `u<id>@test.local` account files under
// `u<id>/…`, not `user-<id>/…`.
const OWNER_SLUG = `u${USER_ID}`;

async function cleanup(): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  for (const dir of [`user-${USER_ID}`, OWNER_SLUG]) {
    await fs.promises
      .rm(path.join(DOCUMENTS_DIR, dir), { recursive: true, force: true })
      .catch(() => {});
  }
}

describe("runDocumentsFsck", () => {
  afterEach(cleanup);

  it("heals a row whose disk_path is missing by matching an orphan on content sha256", async () => {
    await ensureUser(USER_ID);

    // A real file living under DOCUMENTS_DIR that no row references yet.
    const content = crypto.randomBytes(2048);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const orphanDir = path.join(DOCUMENTS_DIR, `user-${USER_ID}`, "_stray");
    const orphanPath = path.join(orphanDir, "recovered-me.pdf");
    await fs.promises.mkdir(orphanDir, { recursive: true });
    await fs.promises.writeFile(orphanPath, content);

    // The row points at a canonical path where nothing was ever written.
    const phantomPath = path.join(
      DOCUMENTS_DIR,
      `user-${USER_ID}`,
      "finanzen",
      "2020",
      `phantom__${sha.slice(0, 8)}.pdf`,
    );
    await db.delete(documents).where(eq(documents.id, DOC_ID));
    await db.insert(documents).values({
      id: DOC_ID,
      user_id: USER_ID,
      sha256: sha,
      original_filename: "recovered-me.pdf",
      mime_type: "application/pdf",
      size_bytes: content.length,
      disk_path: phantomPath,
      status: "ready",
      uploaded_at: "2020-05-10T00:00:00.000Z",
    });

    expect(fs.existsSync(phantomPath)).toBe(false);

    const report = await runDocumentsFsck({});

    // Our broken row was healed (other tests' rows may pad the counts).
    expect(report.healed).toBeGreaterThanOrEqual(1);

    const healed = (
      await db
        .select({ disk_path: documents.disk_path })
        .from(documents)
        .where(eq(documents.id, DOC_ID))
    )[0]!;

    // disk_path now points at a real file with the original bytes …
    expect(fs.existsSync(healed.disk_path)).toBe(true);
    const recovered = await fs.promises.readFile(healed.disk_path);
    expect(recovered.equals(content)).toBe(true);

    // … the orphan was moved to its canonical speaking location …
    expect(healed.disk_path).not.toBe(orphanPath);
    expect(fs.existsSync(orphanPath)).toBe(false);
    // … under the owner's canonical tree (unclassified ⇒ _inbox).
    expect(healed.disk_path.startsWith(path.join(DOCUMENTS_DIR, OWNER_SLUG))).toBe(true);
    expect(healed.disk_path).toContain(`${path.sep}_inbox${path.sep}`);
  });

  it("reports an unrecoverable row when no file matches its sha256", async () => {
    await ensureUser(USER_ID);

    const phantomPath = path.join(
      DOCUMENTS_DIR,
      `user-${USER_ID}`,
      "_inbox",
      "2020-05",
      "gone__abcdef12.pdf",
    );
    await db.delete(documents).where(eq(documents.id, DOC_ID));
    await db.insert(documents).values({
      id: DOC_ID,
      user_id: USER_ID,
      sha256: crypto.randomBytes(32).toString("hex"),
      original_filename: "gone.pdf",
      mime_type: "application/pdf",
      size_bytes: 10,
      disk_path: phantomPath,
      status: "ready",
      uploaded_at: "2020-05-10T00:00:00.000Z",
    });

    const report = await runDocumentsFsck({});

    expect(report.unrecoverable_ids).toContain(DOC_ID);
  });

  it("dry_run reports without moving files or updating rows", async () => {
    await ensureUser(USER_ID);

    const content = crypto.randomBytes(1024);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const orphanDir = path.join(DOCUMENTS_DIR, `user-${USER_ID}`, "_stray");
    const orphanPath = path.join(orphanDir, "keep-me.pdf");
    await fs.promises.mkdir(orphanDir, { recursive: true });
    await fs.promises.writeFile(orphanPath, content);

    const phantomPath = path.join(
      DOCUMENTS_DIR,
      `user-${USER_ID}`,
      "finanzen",
      "2020",
      `phantom__${sha.slice(0, 8)}.pdf`,
    );
    await db.delete(documents).where(eq(documents.id, DOC_ID));
    await db.insert(documents).values({
      id: DOC_ID,
      user_id: USER_ID,
      sha256: sha,
      original_filename: "keep-me.pdf",
      mime_type: "application/pdf",
      size_bytes: content.length,
      disk_path: phantomPath,
      status: "ready",
      uploaded_at: "2020-05-10T00:00:00.000Z",
    });

    const report = await runDocumentsFsck({ dry_run: true });
    expect(report.healed).toBeGreaterThanOrEqual(1); // counted as would-heal

    // …but nothing actually changed on disk or in the DB.
    const after = (
      await db
        .select({ disk_path: documents.disk_path })
        .from(documents)
        .where(eq(documents.id, DOC_ID))
    )[0]!;
    expect(after.disk_path).toBe(phantomPath);
    expect(fs.existsSync(orphanPath)).toBe(true);
  });
});
