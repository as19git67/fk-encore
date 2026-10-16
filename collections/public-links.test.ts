import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { EventEmitter } from "events";
import { PDFDocument } from "pdf-lib";

import db from "../db/database";
import {
  collectionPublicLinks,
  documentCollectionItems,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
  photoCuration,
  photos,
} from "../db/schema";
import { DOCUMENTS_DIR } from "../documents/documents.service";
import { createAnyCollection } from "./collections";
import {
  createCollectionPublicLink,
  disableCollectionPublicLink,
  forgetResolvedLinks,
  getPublicCollection,
  getPublicCollectionDocument,
  getPublicCollectionPhoto,
  listCollectionPublicLinks,
} from "./public-links";

const OWNER = 954_001;
const OTHER = 954_002;
const USERS = [OWNER, OTHER];
const FILES_DIR = path.join(DOCUMENTS_DIR, `collections-public-links-test-${process.pid}`);
const PERMISSIONS = ["module.photos", "photos.view", "module.documents", "documents.view", "finance.view"];
const TEST_ROLE = "collections-public-links-test";

function as(userId: number): void {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: PERMISSIONS });
}

const created = { photos: [] as number[], accounts: [] as number[] };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  if (created.accounts.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, created.accounts));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, created.accounts));
    await db.execute(sql`DELETE FROM finance_account WHERE id IN (${sql.join(created.accounts, sql`, `)})`);
  }
  if (created.photos.length) await db.delete(photos).where(inArray(photos.id, created.photos));
  created.photos = [];
  created.accounts = [];
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

/** Links resolve with the creator's real rights, so the owner gets a role. */
async function grantRole(userId: number): Promise<void> {
  for (const key of PERMISSIONS) {
    await db.execute(sql`INSERT INTO permissions (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`);
  }
  await db.execute(sql`INSERT INTO roles (name) VALUES (${TEST_ROLE}) ON CONFLICT (name) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name = ${TEST_ROLE} AND p.key IN (${sql.join(PERMISSIONS.map((k) => sql`${k}`), sql`, `)})
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${TEST_ROLE}
    ON CONFLICT DO NOTHING
  `);
}

beforeEach(async () => {
  await cleanup();
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${id}, ${`u${id}@links.test`}, ${`Person ${id}`}, 'x')
    `);
  }
  await grantRole(OWNER);
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  forgetResolvedLinks();
  as(OWNER);
});

afterAll(async () => {
  await cleanup();
  await fs.promises.rm(FILES_DIR, { recursive: true, force: true });
});

let seq = 0;

/** A JPEG carrying EXIF data, as a camera would write it. */
async function photo(name: string): Promise<number> {
  seq += 1;
  const file = path.join(FILES_DIR, `p-${seq}.jpg`);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Make: "Beispielkamera", Model: "Modell 1" } } })
    .toFile(file);
  const [row] = await db
    .insert(photos)
    .values({
      user_id: OWNER,
      filename: `links-${seq}.jpg`,
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

async function pdfDocument(title: string): Promise<number> {
  seq += 1;
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText(title, { x: 20, y: 100, size: 12 });
  const file = path.join(FILES_DIR, `doc-${seq}.pdf`);
  await fs.promises.writeFile(file, await pdf.save());
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, title, visibility)
    VALUES
      (${OWNER}, ${`lnk-${seq}-${"0".repeat(60)}`.slice(0, 64)}, ${`beleg-${seq}.pdf`},
       'application/pdf', 1000, ${file}, 'ready', ${title}, 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function booking(): Promise<number> {
  const [type] = await db.select({ id: sql<number>`id` }).from(financeAccountType).limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({ type_id: type!.id, currency_code: "EUR", account_number: `LNK-${++seq}`, label: "Girokonto" })
    .returning({ id: financeAccount.id });
  created.accounts.push(acc!.id);
  await db.insert(financeAccountAccess).values({ account_id: acc!.id, user_id: OWNER, level: "read" });
  const [tx] = await db
    .insert(financeTransaction)
    .values({ account_id: acc!.id, booking_date: "2026-03-01", amount: "-12.00", currency_code: "EUR", dedupe_hash: `lnk-${++seq}` })
    .returning({ id: financeTransaction.id });
  return tx!.id;
}

/** Drive a raw endpoint with a fake request and collect the response. */
async function rawGet(handler: unknown, url: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
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
  });
  (res as unknown as { writable: boolean }).writable = true;
  await (handler as (req: unknown, res: unknown) => Promise<void>)({ url, method: "GET", headers: {} }, res);
  await done;
  return { status: res.statusCode as number, body: Buffer.concat(chunks), headers };
}

describe("collection share links", () => {
  it("only the owner shares, the basket never", async () => {
    const col = await createAnyCollection({ name: "Ausflug", members: [] });
    as(OTHER);
    await expect(createCollectionPublicLink({ id: col.id })).rejects.toThrow();
    as(OWNER);
    const link = await createCollectionPublicLink({ id: col.id, expires_in: "7d" });
    expect(link.token.length).toBeGreaterThan(20);
    expect((await listCollectionPublicLinks({ id: col.id })).items.map((l) => l.id)).toEqual([link.id]);
  });

  it("shows photos and documents, holds back the rest, and stays live", async () => {
    const p1 = await photo("Gipfel.jpg");
    const hiddenPhoto = await photo("Privat.jpg");
    const doc = await pdfDocument("Rechnung");
    const redacted = await pdfDocument("Vertrag");
    const tx = await booking();
    const col = await createAnyCollection({
      name: "Ausflug",
      members: [
        { entity_type: "photo", entity_id: p1 },
        { entity_type: "photo", entity_id: hiddenPhoto },
        { entity_type: "document", entity_id: doc },
        { entity_type: "document", entity_id: redacted },
        { entity_type: "transaction", entity_id: tx },
      ],
    });
    await db.insert(photoCuration).values({ user_id: OWNER, photo_id: hiddenPhoto, status: "hidden", source: "user" });
    await db
      .update(documentCollectionItems)
      .set({ redactions: [{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] })
      .where(eq(documentCollectionItems.document_id, redacted));
    const link = await createCollectionPublicLink({ id: col.id });

    const view = await getPublicCollection({ token: link.token });
    expect(view.title).toBe("Ausflug");
    expect(view.photos.map((p) => p.id)).toEqual([p1]);
    expect(view.photos[0]!.taken_on).toBe("2026-05-01");
    expect(view.documents.map((d) => d.id)).toEqual([doc]);
    expect(view.withheld.map((w) => w.kind).sort()).toEqual(
      ["Buchungen", "Dokumente mit Schwärzungen oder ausgelassenen Seiten", "Fotos, die nicht geteilt werden"].sort(),
    );

    // Live: a photo added later shows up.
    const p2 = await photo("Hütte.jpg");
    await db.execute(sql`
      INSERT INTO collection_members (collection_id, entity_type, entity_id, added_by)
      VALUES (${col.id}, 'photo', ${p2}, ${OWNER})
    `);
    forgetResolvedLinks();
    expect((await getPublicCollection({ token: link.token })).photos.map((p) => p.id)).toEqual([p1, p2]);
  });

  it("serves photos re-encoded without metadata, and only the link's own", async () => {
    const p1 = await photo("Gipfel.jpg");
    const outside = await photo("Anderes.jpg");
    const col = await createAnyCollection({ name: "Ausflug", members: [{ entity_type: "photo", entity_id: p1 }] });
    const link = await createCollectionPublicLink({ id: col.id });

    const res = await rawGet(getPublicCollectionPhoto, `/collections/public/${link.token}/photos/${p1}?w=32`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    const meta = await sharp(res.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width!, meta.height!)).toBe(32);

    expect((await rawGet(getPublicCollectionPhoto, `/collections/public/${link.token}/photos/${outside}`)).status).toBe(404);
  });

  it("serves a whole document, never a redacted one", async () => {
    const doc = await pdfDocument("Rechnung");
    const redacted = await pdfDocument("Vertrag");
    const col = await createAnyCollection({
      name: "Belege",
      members: [
        { entity_type: "document", entity_id: doc },
        { entity_type: "document", entity_id: redacted },
      ],
    });
    await db
      .update(documentCollectionItems)
      .set({ excluded_pages: [2] })
      .where(eq(documentCollectionItems.document_id, redacted));
    const link = await createCollectionPublicLink({ id: col.id });
    const ok = await rawGet(getPublicCollectionDocument, `/collections/public/${link.token}/documents/${doc}`);
    expect(ok.status).toBe(200);
    expect(ok.body.subarray(0, 4).toString()).toBe("%PDF");
    expect((await rawGet(getPublicCollectionDocument, `/collections/public/${link.token}/documents/${redacted}`)).status).toBe(404);
  });

  it("an ended or expired link reads as missing", async () => {
    const col = await createAnyCollection({ name: "Ausflug", members: [] });
    const link = await createCollectionPublicLink({ id: col.id });
    await disableCollectionPublicLink({ linkId: link.id });
    await expect(getPublicCollection({ token: link.token })).rejects.toThrow("link not found");

    const old = await createCollectionPublicLink({ id: col.id });
    await db.update(collectionPublicLinks).set({ expires_at: "2020-01-01T00:00:00Z" }).where(eq(collectionPublicLinks.id, old.id));
    await expect(getPublicCollection({ token: old.token })).rejects.toThrow("link not found");
    await expect(getPublicCollection({ token: "nicht-da-nicht-da-nicht-da" })).rejects.toThrow("link not found");
  });
});
