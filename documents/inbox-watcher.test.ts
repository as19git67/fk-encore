import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

// `DOCUMENTS_INBOX_DIR` is read once when documents.service loads, so the
// temp inbox has to exist in the environment before any import below runs.
const INBOX = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const dir = mkdtempSync(join(tmpdir(), "inbox-watcher-test-"));
  process.env.DOCUMENTS_INBOX_DIR = dir;
  return dir;
});

import db from "../db/database";
import { sourceFolderFor } from "./source-folder";
import {
  _resetInboxOwnerCache,
  inboxFolderOf,
  resolveInboxFolderOwnerId,
  resolveInboxOwnerFor,
} from "./inbox-watcher";

const ANNA_ID = 95_001;
const BEN_ID = 95_002;
const FALLBACK_ID = 95_003;
const FALLBACK_EMAIL = "inbox-fallback@inbox-watcher.test";

async function ensureUser(id: number, email: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${email}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

function touch(rel: string): string {
  const abs = path.join(INBOX, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
  return abs;
}

describe("inboxFolderOf", () => {
  it("is the first folder below the root and null for a root file", () => {
    expect(inboxFolderOf("/inbox", "/inbox/anna/scan.pdf")).toBe("anna");
    expect(inboxFolderOf("/inbox", "/inbox/anna/Versicherungen/scan.pdf")).toBe("anna");
    expect(inboxFolderOf("/inbox", "/inbox/scan.pdf")).toBeNull();
    expect(inboxFolderOf("/inbox", "/elsewhere/anna/scan.pdf")).toBeNull();
  });
});

describe("inbox owner by folder", () => {
  beforeAll(async () => {
    await ensureUser(ANNA_ID, "inbox-anna@inbox-watcher.test");
    await ensureUser(BEN_ID, "inbox-ben@inbox-watcher.test");
    await ensureUser(FALLBACK_ID, FALLBACK_EMAIL);
    process.env.DOCUMENTS_INBOX_USER_EMAIL = FALLBACK_EMAIL;
  });

  afterAll(async () => {
    delete process.env.DOCUMENTS_INBOX_USER_EMAIL;
    await db.execute(sql`DELETE FROM users WHERE id IN (${ANNA_ID}, ${BEN_ID}, ${FALLBACK_ID})`);
    fs.rmSync(INBOX, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetInboxOwnerCache();
  });

  it("maps a login slug to its user and an unknown slug to nobody", async () => {
    expect(await resolveInboxFolderOwnerId("inbox-anna")).toBe(ANNA_ID);
    expect(await resolveInboxFolderOwnerId("inbox-ben")).toBe(BEN_ID);
    expect(await resolveInboxFolderOwnerId("niemand-hier")).toBeNull();
  });

  it("routes a file in a user folder to that user and strips the folder from the source", async () => {
    const file = touch("inbox-anna/Versicherungen/Hausrat/police.pdf");
    const owner = await resolveInboxOwnerFor(file);
    expect(owner?.userId).toBe(ANNA_ID);
    expect(sourceFolderFor(owner!.sourceRoot, file)).toBe("Versicherungen/Hausrat");

    const direct = touch("inbox-ben/scan.pdf");
    const benOwner = await resolveInboxOwnerFor(direct);
    expect(benOwner?.userId).toBe(BEN_ID);
    expect(sourceFolderFor(benOwner!.sourceRoot, direct)).toBeNull();
  });

  it("sends a root file to the fallback owner", async () => {
    const file = touch("scan.pdf");
    const owner = await resolveInboxOwnerFor(file);
    expect(owner?.userId).toBe(FALLBACK_ID);
    expect(sourceFolderFor(owner!.sourceRoot, file)).toBeNull();
  });

  it("keeps a folder that names no user as source folder of the fallback owner", async () => {
    const file = touch("Versicherungen/Hausrat/police.pdf");
    const owner = await resolveInboxOwnerFor(file);
    expect(owner?.userId).toBe(FALLBACK_ID);
    expect(sourceFolderFor(owner!.sourceRoot, file)).toBe("Versicherungen/Hausrat");
  });

  it("caches the folder lookup until the cache is reset", async () => {
    const file = touch("inbox-ben/a.pdf");
    expect((await resolveInboxOwnerFor(file))?.userId).toBe(BEN_ID);
    await db.execute(sql`DELETE FROM users WHERE id = ${BEN_ID}`);
    expect((await resolveInboxOwnerFor(file))?.userId).toBe(BEN_ID);
    _resetInboxOwnerCache();
    expect((await resolveInboxOwnerFor(file))?.userId).toBe(FALLBACK_ID);
    await ensureUser(BEN_ID, "inbox-ben@inbox-watcher.test");
  });
});
