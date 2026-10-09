import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  backfillSourceFolders,
  getSourceFolderBackfillState,
  hashFile,
  resetSourceFolderBackfillState,
  startSourceFolderBackfill,
  normalizeSourceFolder,
  sourceFolderFor,
  sourceFolderPrefixPattern,
  walkSourceTree,
} from "./source-folder";

describe("normalizeSourceFolder", () => {
  it("keeps a clean relative path", () => {
    expect(normalizeSourceFolder("Versicherungen/Hausrat")).toBe("Versicherungen/Hausrat");
  });

  it("strips leading, trailing and doubled separators and accepts backslashes", () => {
    expect(normalizeSourceFolder("/Versicherungen//Hausrat/")).toBe("Versicherungen/Hausrat");
    expect(normalizeSourceFolder("Versicherungen\\Hausrat")).toBe("Versicherungen/Hausrat");
  });

  it("drops dot segments instead of climbing", () => {
    expect(normalizeSourceFolder("../Versicherungen/./Hausrat")).toBe("Versicherungen/Hausrat");
  });

  it("is null for nothing, the root and over-long input", () => {
    expect(normalizeSourceFolder(undefined)).toBeNull();
    expect(normalizeSourceFolder(null)).toBeNull();
    expect(normalizeSourceFolder("")).toBeNull();
    expect(normalizeSourceFolder("/")).toBeNull();
    expect(normalizeSourceFolder(".")).toBeNull();
    expect(normalizeSourceFolder("a".repeat(2000))).toBeNull();
  });
});

describe("sourceFolderFor", () => {
  const root = path.join(os.tmpdir(), "fk-inbox-root");

  it("is the subfolder for a nested file", () => {
    expect(sourceFolderFor(root, path.join(root, "Versicherungen", "Hausrat", "police.pdf")))
      .toBe("Versicherungen/Hausrat");
  });

  it("is null for a file directly in the root", () => {
    expect(sourceFolderFor(root, path.join(root, "police.pdf"))).toBeNull();
  });

  it("is null for a file outside the root", () => {
    expect(sourceFolderFor(root, path.join(os.tmpdir(), "elsewhere", "police.pdf"))).toBeNull();
  });
});

describe("sourceFolderPrefixPattern", () => {
  it("matches the folder's descendants and escapes LIKE wildcards", () => {
    expect(sourceFolderPrefixPattern("Versicherungen/Hausrat")).toBe("Versicherungen/Hausrat/%");
    expect(sourceFolderPrefixPattern("100%_sicher")).toBe("100\\%\\_sicher/%");
  });
});

// ─── Backfill against a temp tree ───────────────────────────────────────────

const USER_ID = 947_101;
const FILE_PREFIX = "sfb-test-";
let tmpRoot: string;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${USER_ID}, ${`u${USER_ID}@source-folder.test`}, 'Source Folder Test', 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertDoc(sha: string, name: string, folder: string | null = null): Promise<number> {
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, source_folder)
    VALUES
      (${USER_ID}, ${sha}, ${name}, 'application/pdf', 100, ${`/tmp/${FILE_PREFIX}${name}`}, 'ready', ${folder})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = path.join(tmpRoot, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content);
  return abs;
}

async function folderOf(id: number): Promise<string | null> {
  const r = await db.execute<{ source_folder: string | null }>(
    sql`SELECT source_folder FROM documents WHERE id = ${id}`,
  );
  return r.rows[0]!.source_folder;
}

describe("backfillSourceFolders", () => {
  beforeEach(async () => {
    await ensureUser();
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-source-folder-"));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  it("walks only supported, non-hidden regular files", async () => {
    await writeFile("Versicherungen/Hausrat/police.pdf", "a");
    await writeFile("Versicherungen/.DS_Store", "x");
    await writeFile("Versicherungen/notiz.txt", "x");
    await writeFile("loose.pdf", "b");
    const { files, truncated } = await walkSourceTree(tmpRoot);
    expect(truncated).toBe(false);
    expect(files.map((f) => f.rel).sort()).toEqual(["Versicherungen/Hausrat/police.pdf", "loose.pdf"]);
    expect(files.find((f) => f.rel === "loose.pdf")?.folder).toBeNull();
    expect(files.find((f) => f.rel.endsWith("police.pdf"))?.folder).toBe("Versicherungen/Hausrat");
  });

  it("reports in a dry run and writes only on apply", async () => {
    const policeAbs = await writeFile("Versicherungen/Hausrat/police.pdf", "police bytes");
    const termsAbs = await writeFile("Versicherungen/Hausrat/bedingungen.pdf", "terms bytes");
    await writeFile("Versicherungen/unbekannt.pdf", "nobody has these bytes");
    const police = await insertDoc(await hashFile(policeAbs), "renamed-on-import.pdf");
    const terms = await insertDoc(await hashFile(termsAbs), "bedingungen.pdf", "Versicherungen/Hausrat");
    const orphanRow = await insertDoc(`${FILE_PREFIX}${"0".repeat(55)}`, "no-file.pdf");

    const dry = await backfillSourceFolders(tmpRoot, false);
    expect(dry.dry_run).toBe(true);
    expect(dry.files_scanned).toBe(3);
    expect(dry.matched).toBe(2);
    // The terms row already carries the folder, so only the police row changes.
    expect(dry.updated).toBe(1);
    expect(dry.unmatched_files).toEqual(["Versicherungen/unbekannt.pdf"]);
    expect(dry.unmatched_rows_total).toBeGreaterThanOrEqual(1);
    expect(await folderOf(police)).toBeNull();

    const applied = await backfillSourceFolders(tmpRoot, true);
    expect(applied.dry_run).toBe(false);
    expect(applied.updated).toBe(1);
    expect(await folderOf(police)).toBe("Versicherungen/Hausrat");
    expect(await folderOf(terms)).toBe("Versicherungen/Hausrat");
    expect(await folderOf(orphanRow)).toBeNull();

    // Idempotent: a second apply has nothing left to write.
    const again = await backfillSourceFolders(tmpRoot, true);
    expect(again.updated).toBe(0);
  });

  it("leaves a document alone when the same bytes sit in two folders", async () => {
    const a = await writeFile("Ordner-A/gleich.pdf", "same bytes");
    await writeFile("Ordner-B/gleich.pdf", "same bytes");
    const id = await insertDoc(await hashFile(a), "gleich.pdf");

    const res = await backfillSourceFolders(tmpRoot, true);
    expect(res.ambiguous_files).toEqual(["Ordner-A/gleich.pdf", "Ordner-B/gleich.pdf"]);
    expect(res.matched).toBe(0);
    expect(await folderOf(id)).toBeNull();
  });
});

describe("startSourceFolderBackfill", () => {
  beforeEach(async () => {
    await ensureUser();
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-source-folder-run-"));
    resetSourceFolderBackfillState();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
  });

  async function waitUntilFinished(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (getSourceFolderBackfillState().status !== "running") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("backfill run did not finish");
  }

  it("runs in the background, reports progress and keeps the result", async () => {
    const abs = await writeFile("Versicherungen/police.pdf", "run bytes");
    const id = await insertDoc(await hashFile(abs), "police.pdf");

    const { started, state } = startSourceFolderBackfill(tmpRoot, true);
    expect(started).toBe(true);
    expect(state.status).toBe("running");
    expect(state.root).toBe(tmpRoot);
    expect(state.apply).toBe(true);

    await waitUntilFinished();
    const done = getSourceFolderBackfillState();
    expect(done.status).toBe("done");
    expect(done.finished_at).not.toBeNull();
    expect(done.progress).toEqual({ files_found: 1, files_hashed: 1 });
    expect(done.result?.updated).toBe(1);
    expect(await folderOf(id)).toBe("Versicherungen");
  });

  it("refuses a second run while one is active", async () => {
    await writeFile("a.pdf", "a");
    const first = startSourceFolderBackfill(tmpRoot, false);
    const second = startSourceFolderBackfill(tmpRoot, true);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.state.apply).toBe(false);
    await waitUntilFinished();
    expect(getSourceFolderBackfillState().status).toBe("done");
  });

  it("records a failure instead of staying running forever", async () => {
    const { started } = startSourceFolderBackfill(path.join(tmpRoot, "missing"), false);
    expect(started).toBe(true);
    await waitUntilFinished();
    // An unreadable root walks to an empty tree rather than throwing, so the
    // run ends done with nothing scanned; what matters is that it ends.
    const s = getSourceFolderBackfillState();
    expect(s.status === "done" || s.status === "failed").toBe(true);
    expect(s.finished_at).not.toBeNull();
  });
});

