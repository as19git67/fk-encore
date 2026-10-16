import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXPORT_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || "/tmp"}/collection-sending-test-${process.pid}`;
  process.env.COLLECTION_EXPORTS_DIR = dir;
  // Small enough that a photo ZIP is "too large" in one test.
  process.env.COLLECTION_MAIL_MAX_BYTES = "50000";
  return dir;
});

import { getAuthData } from "~encore/auth";
import { inArray, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { EventEmitter } from "events";

import db from "../db/database";
import { financeAccount, financeAccountAccess, financeAccountType, financeTransaction, photos } from "../db/schema";
import { DOCUMENTS_DIR } from "../documents/documents.service";
import { setMailTransportForTests } from "../user/mail";
import { createAnyCollection } from "./collections";
import { awaitExportRun, getExport, startExport, type ExportRun } from "./exports";
import {
  createExportLink,
  downloadByLink,
  listCollectionSends,
  listExportEntries,
  mailSender,
  normalizeRecipients,
  sendExport,
} from "./sending";

const OWNER = 953_001;
const OTHER = 953_002;
const USERS = [OWNER, OTHER];
const FILES_DIR = path.join(DOCUMENTS_DIR, `collections-sending-test-${process.pid}`);
const PERMISSIONS = ["module.photos", "photos.view", "finance.view"];

function as(userId: number): void {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: PERMISSIONS });
}

interface SentMail {
  to: string[];
  from: string | { name: string; address: string };
  replyTo?: string;
  sender?: string;
  envelope?: { from: string };
  subject: string;
  text: string;
  attachments: Array<{ filename: string; path?: string; content?: Buffer }>;
}
let sent: SentMail[] = [];

const created = { photos: [] as number[], accounts: [] as number[] };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  if (created.accounts.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, created.accounts));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, created.accounts));
    await db.delete(financeAccount).where(inArray(financeAccount.id, created.accounts));
  }
  if (created.photos.length) await db.delete(photos).where(inArray(photos.id, created.photos));
  created.photos = [];
  created.accounts = [];
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

beforeEach(async () => {
  await cleanup();
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${id}, ${`u${id}@sending.test`}, ${`Person ${id}`}, 'x')
    `);
  }
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  sent = [];
  setMailTransportForTests({
    sendMail: (async (mail: SentMail) => {
      sent.push(mail);
      return {};
    }) as never,
  });
  as(OWNER);
});

afterEach(() => setMailTransportForTests(null));

afterAll(async () => {
  await cleanup();
  await fs.promises.rm(FILES_DIR, { recursive: true, force: true });
  await fs.promises.rm(EXPORT_DIR, { recursive: true, force: true });
});

let seq = 0;

/** A noisy JPEG, so a few of them exceed the test's mail limit. */
async function photo(name: string, size = 64): Promise<number> {
  seq += 1;
  const file = path.join(FILES_DIR, `p-${seq}.jpg`);
  const noise = Buffer.alloc(size * size * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + seq * 104729) % 251;
  await sharp(noise, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 95 }).toFile(file);
  const [row] = await db
    .insert(photos)
    .values({
      user_id: OWNER,
      filename: `sending-${seq}.jpg`,
      external_path: file,
      original_name: name,
      mime_type: "image/jpeg",
      size: 1000,
      taken_at: "2026-05-01 10:00:00",
    })
    .returning({ id: photos.id });
  created.photos.push(row!.id);
  return row!.id;
}

async function transactionCollection(): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({ type_id: type!.id, currency_code: "EUR", account_number: `SND-${++seq}`, label: "Girokonto" })
    .returning({ id: financeAccount.id });
  created.accounts.push(acc!.id);
  await db.insert(financeAccountAccess).values({ account_id: acc!.id, user_id: OWNER, level: "read" });
  const [tx] = await db
    .insert(financeTransaction)
    .values({
      account_id: acc!.id,
      booking_date: "2026-03-01",
      amount: "-12.00",
      currency_code: "EUR",
      counterparty: "Bäckerei Beispiel",
      dedupe_hash: `sending-${++seq}`,
    })
    .returning({ id: financeTransaction.id });
  const col = await createAnyCollection({ name: "Belege", members: [{ entity_type: "transaction", entity_id: tx!.id }] });
  return col.id;
}

async function exported(collectionId: number, options: Record<string, unknown> = {}): Promise<ExportRun> {
  const run = await startExport({ id: collectionId, options });
  await awaitExportRun(run.id);
  const done = await getExport({ exportId: run.id });
  expect(done.status).toBe("done");
  return done;
}

/** Drive a raw endpoint with a fake request and collect the response. */
async function rawGet(
  handler: unknown,
  url: string,
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  Object.assign(res, {
    statusCode: 200,
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    write: (c: Buffer) => chunks.push(Buffer.from(c)),
    end: (c?: Buffer | string) => {
      if (c) chunks.push(Buffer.from(c));
      finish();
    },
    on: res.on.bind(res),
    once: res.once.bind(res),
    emit: res.emit.bind(res),
  });
  // A piped read stream calls write/end and listens for drain/close events.
  (res as unknown as { writable: boolean }).writable = true;
  const call = (handler as { (req: unknown, res: unknown): Promise<void> });
  await call({ url, method: "GET", headers: {} }, res);
  await done;
  return { status: res.statusCode as number, body: Buffer.concat(chunks), headers };
}

describe("recipients", () => {
  it("dedupes, lowercases and refuses what is not an address", () => {
    expect(normalizeRecipients([" Max@Beispiel.test", "max@beispiel.test", "eva@beispiel.test"])).toEqual([
      "max@beispiel.test",
      "eva@beispiel.test",
    ]);
    expect(() => normalizeRecipients([])).toThrow();
    expect(() => normalizeRecipients(["kein-adresse"])).toThrow();
    expect(() => normalizeRecipients(Array.from({ length: 11 }, (_, i) => `p${i}@beispiel.test`))).toThrow();
  });
});

describe("mail sender", () => {
  // The app sends as noreply@example.com in tests.
  const same = { name: "Max", email: "Max@Example.com" };
  const other = { name: "Max", email: "max@beispiel.test" };
  it("is the app, or the person's own address when chosen and on the app's domain", () => {
    expect(mailSender(same, true)).toEqual(same);
    expect(mailSender(same, false)).toBeNull();
    expect(mailSender(other, true)).toBeNull();
    expect(mailSender(null, true)).toBeNull();
  });
});

describe("sending by mail", () => {
  it("attaches a small export, from the sender's own address", async () => {
    const col = await transactionCollection();
    const run = await exported(col, { transaction: { format: "csv" } });
    const result = await sendExport({ exportId: run.id, to: ["steuer@beispiel.test"], message: "Für die Erklärung." });
    expect(result.mode).toBe("attachment");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["steuer@beispiel.test"]);
    // From the app; answers go to the person who sent it.
    expect(sent[0]!.from).toBe("noreply@example.com");
    expect(sent[0]!.replyTo).toBe(`u${OWNER}@sending.test`);
    expect(sent[0]!.subject).toContain("Belege");
    expect(sent[0]!.text).toContain("Für die Erklärung.");
    expect(sent[0]!.attachments.map((a) => a.filename)).toEqual(["Belege - Buchungen.csv"]);

    const log = await listCollectionSends({ id: col });
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ recipients: ["steuer@beispiel.test"], mode: "attachment", status: "sent", sent_by: `Person ${OWNER}`, sender: "noreply@example.com" });

    const setup = await listCollectionSends({ id: col });
    expect(setup).toMatchObject({ sender_email: `u${OWNER}@sending.test`, self_sender_allowed: false });
  });

  it("sends from the person's own address when chosen and on the app's domain, else from the app", async () => {
    const col = await transactionCollection();
    const run = await exported(col, { transaction: { format: "csv" } });
    // Another domain: the choice is ignored.
    await sendExport({ exportId: run.id, to: ["steuer@beispiel.test"], from_self: true });
    expect(sent[0]!.from).toBe("noreply@example.com");

    await db.execute(sql`UPDATE users SET email = ${`u${OWNER}@example.com`} WHERE id = ${OWNER}`);
    expect((await listCollectionSends({ id: col })).self_sender_allowed).toBe(true);
    await sendExport({ exportId: run.id, to: ["steuer@beispiel.test"], from_self: true });
    expect(sent[1]!.from).toEqual({ name: `Person ${OWNER}`, address: `u${OWNER}@example.com` });
    // The app's account delivers it and gets the bounces.
    expect(sent[1]!.sender).toBe("noreply@example.com");
    expect(sent[1]!.envelope?.from).toBe("noreply@example.com");
    expect(sent[1]!.replyTo).toBeUndefined();
  });

  it("sends the files inside a ZIP one by one, without the table of contents", async () => {
    const a = await photo("Zaehler.jpg", 16);
    const b = await photo("Rechnung.jpg", 16);
    const col = await createAnyCollection({
      name: "Fotos",
      members: [a, b].map((id) => ({ entity_type: "photo" as const, entity_id: id })),
    });
    const run = await exported(col.id);
    const entries = await listExportEntries({ exportId: run.id });
    expect(entries.items.map((e) => e.name).sort()).toEqual(["Fotos/Rechnung.jpg", "Fotos/Zaehler.jpg"]);
    expect(entries.single_files_allowed).toBe(true);

    const result = await sendExport({ exportId: run.id, to: ["eva@beispiel.test"], single_files: true });
    expect(result.mode).toBe("items");
    expect(sent[0]!.attachments.map((x) => x.filename).sort()).toEqual(["Rechnung.jpg", "Zaehler.jpg"]);
  });

  it("sends a link instead when the export is too large, and the link serves the file", async () => {
    const ids = [await photo("A.jpg", 160), await photo("B.jpg", 160), await photo("C.jpg", 160)];
    const col = await createAnyCollection({ name: "Groß", members: ids.map((id) => ({ entity_type: "photo" as const, entity_id: id })) });
    const run = await exported(col.id);
    expect(run.size_bytes!).toBeGreaterThan(50_000);

    const result = await sendExport({ exportId: run.id, to: ["eva@beispiel.test"] });
    expect(result.mode).toBe("link");
    expect(sent[0]!.attachments).toEqual([]);
    const url = /https?:\/\/\S+\/collections\/download\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text);
    expect(url).not.toBeNull();

    // The same link on asking again.
    expect((await createExportLink({ exportId: run.id })).url).toContain(url![1]!);

    const res = await rawGet(downloadByLink, `/collections/download/${url![1]}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.body.length).toBe(run.size_bytes);

    // Expired: gone, and it says nothing more than "not found".
    await db.execute(sql`UPDATE collection_exports SET expires_at = now() - interval '1 minute' WHERE id = ${run.id}`);
    expect((await rawGet(downloadByLink, `/collections/download/${url![1]}`)).status).toBe(404);
  });

  it("logs a failed mail and tells the caller", async () => {
    const col = await transactionCollection();
    const run = await exported(col, { transaction: { format: "csv" } });
    setMailTransportForTests({
      sendMail: (async () => {
        throw new Error("connection refused");
      }) as never,
    });
    await expect(sendExport({ exportId: run.id, to: ["eva@beispiel.test"] })).rejects.toMatchObject({ code: "unavailable" });
    expect((await listCollectionSends({ id: col })).items[0]).toMatchObject({ status: "failed", error: "connection refused" });
  });

  it("does not let anyone else send or list someone's run", async () => {
    const col = await transactionCollection();
    const run = await exported(col, { transaction: { format: "csv" } });
    as(OTHER);
    await expect(sendExport({ exportId: run.id, to: ["eva@beispiel.test"] })).rejects.toMatchObject({ code: "not_found" });
    await expect(listExportEntries({ exportId: run.id })).rejects.toMatchObject({ code: "not_found" });
    expect(sent).toHaveLength(0);
  });

  it("refuses unknown links", async () => {
    expect((await rawGet(downloadByLink, "/collections/download/AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await rawGet(downloadByLink, "/collections/download/x")).status).toBe(404);
  });
});
