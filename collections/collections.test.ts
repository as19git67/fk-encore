import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import {
  albumShares,
  albums,
  collectionMembers,
  documentCollections,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  photos,
} from "../db/schema";
import {
  addAnyCollectionMembers,
  addToBasket,
  clearBasket,
  getBasket,
  removeFromBasket,
  saveBasketAsCollection,
  collectionsOfItem,
  createAnyCollection,
  deleteAnyCollection,
  getAnyCollection,
  listAllCollections,
  markCollectionOpened,
  removeAnyCollectionMember,
  sortSummaries,
  updateAnyCollection,
  type CollectionSummary,
} from "./collections";
import { addCollectionDocuments, listCollections, listCollectionsForDocument } from "../documents/collections";
import { listBasketSnapshots, loadBasketSnapshot, saveBasketSnapshot } from "../finance/basket";
import fs from "fs";
import path from "path";

const OWNER = 951_001;
const MEMBER = 951_002;
const STRANGER = 951_003;
const GROUP = 951_010;
const USERS = [OWNER, MEMBER, STRANGER];

const ALL_PERMISSIONS = [
  "module.documents",
  "documents.view",
  "module.photos",
  "photos.view",
  "finance.view",
  "meters.view",
];

function as(userId: number, permissions: string[] = ALL_PERMISSIONS): void {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions });
}

const created = {
  photos: [] as number[],
  albums: [] as number[],
  accounts: [] as number[],
  meters: [] as number[],
};

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  if (created.accounts.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, created.accounts));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, created.accounts));
    await db.delete(financeAccount).where(inArray(financeAccount.id, created.accounts));
  }
  if (created.meters.length) await db.delete(meters).where(inArray(meters.id, created.meters));
  if (created.albums.length) await db.delete(albums).where(inArray(albums.id, created.albums));
  if (created.photos.length) await db.delete(photos).where(inArray(photos.id, created.photos));
  created.photos = [];
  created.albums = [];
  created.accounts = [];
  created.meters = [];
  await db.execute(sql`DELETE FROM group_members WHERE group_id = ${GROUP}`);
  await db.execute(sql`DELETE FROM groups WHERE id = ${GROUP}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

beforeEach(async () => {
  await cleanup();
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${id}, ${`u${id}@collections.test`}, ${`User ${id}`}, 'x')
    `);
  }
  await db.execute(sql`INSERT INTO groups (id, slug, name) VALUES (${GROUP}, ${`g${GROUP}`}, 'Haushalt')`);
  await db.execute(sql`
    INSERT INTO group_members (group_id, user_id, role)
    VALUES (${GROUP}, ${OWNER}, 'owner'), (${GROUP}, ${MEMBER}, 'member')
  `);
  as(OWNER);
});

afterAll(cleanup);

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0;

async function photo(userId: number, name = `IMG_${++seq}.jpg`): Promise<number> {
  const [row] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `collections-test-${seq}-${Date.now()}.jpg`,
      original_name: name,
      mime_type: "image/jpeg",
      size: 1000,
      taken_at: "2026-05-01 10:00:00",
    })
    .returning({ id: photos.id });
  created.photos.push(row!.id);
  return row!.id;
}

async function album(userId: number, name: string): Promise<number> {
  const [row] = await db.insert(albums).values({ user_id: userId, name }).returning({ id: albums.id });
  created.albums.push(row!.id);
  return row!.id;
}

async function account(readers: number[]): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({
      type_id: type!.id,
      currency_code: "EUR",
      account_number: `COLL-${++seq}`,
      label: "Girokonto",
    })
    .returning({ id: financeAccount.id });
  created.accounts.push(row!.id);
  for (const userId of readers) {
    await db.insert(financeAccountAccess).values({ account_id: row!.id, user_id: userId, level: "read" });
  }
  return row!.id;
}

async function transaction(accountId: number, counterparty: string): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2026-03-01",
      amount: "-42.50",
      currency_code: "EUR",
      counterparty,
      dedupe_hash: `collections-test-${++seq}`,
    })
    .returning({ id: financeTransaction.id });
  return row!.id;
}

async function meter(ownerId: number, groupId: number | null = null): Promise<number> {
  const [row] = await db
    .insert(meters)
    .values({ name: "Strom Haus", type: "electricity", unit: "kWh", owner_user_id: ownerId, group_id: groupId })
    .returning({ id: meters.id });
  created.meters.push(row!.id);
  return row!.id;
}

async function reading(meterId: number, value: string): Promise<number> {
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: meterId, installed_at: "2020-01-01T00:00:00Z", start_value: "0" })
    .returning({ id: meterDevices.id });
  const [row] = await db
    .insert(meterReadings)
    .values({ device_id: device!.id, value, taken_at: "2026-01-31T12:00:00Z", source: "manual" })
    .returning({ id: meterReadings.id });
  return row!.id;
}

async function document(userId: number, title: string, visibility: "private" | "group" = "private"): Promise<number> {
  seq += 1;
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, title, sender, doc_date, visibility, group_id)
    VALUES
      (${userId}, ${`coll-${seq}-${"0".repeat(60)}`.slice(0, 64)}, ${`doc-${seq}.pdf`},
       'application/pdf', 1000, ${`/tmp/coll-${seq}.pdf`}, 'ready', ${title},
       'Beispiel GmbH', '2026-02-02', ${visibility}, ${visibility === "group" ? GROUP : null})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("typed collections", () => {
  it("holds photos the caller may see and refuses other types", async () => {
    const own = await photo(OWNER, "Strand.jpg");
    const col = await createAnyCollection({ name: "Urlaub", entity_type: "photo", members: [{ entity_type: "photo", entity_id: own }] });
    expect(col.entity_type).toBe("photo");
    expect(col.members.map((m) => [m.entity_type, m.entity_id, m.title])).toEqual([["photo", own, "Strand.jpg"]]);

    const meterId = await meter(OWNER);
    await expectCode(
      addAnyCollectionMembers({ id: col.id, members: [{ entity_type: "meter", entity_id: meterId }] }),
      "failed_precondition",
    );
  });

  it("refuses a photo the caller may not open, as if it did not exist", async () => {
    const foreign = await photo(STRANGER);
    const col = await createAnyCollection({ name: "Fotos", entity_type: "photo" });
    await expectCode(
      addAnyCollectionMembers({ id: col.id, members: [{ entity_type: "photo", entity_id: foreign }] }),
      "not_found",
    );
    expect((await getAnyCollection({ id: col.id })).members).toHaveLength(0);
  });

  it("accepts an album shared with the caller", async () => {
    const shared = await album(STRANGER, "Hochzeit");
    await db.insert(albumShares).values({ album_id: shared, user_id: OWNER, access_level: "read" });
    const col = await createAnyCollection({ name: "Alben", entity_type: "album" });
    const res = await addAnyCollectionMembers({ id: col.id, members: [{ entity_type: "album", entity_id: shared }] });
    expect(res.added).toBe(1);
    expect(res.collection.members[0]).toMatchObject({ entity_type: "album", title: "Hochzeit" });
  });

  it("keeps a photo-typed collection out of the document folder list", async () => {
    const col = await createAnyCollection({ name: "Nur Fotos", entity_type: "photo" });
    const docId = await document(OWNER, "Rechnung");
    const listed = (await listCollections({})).items.map((item) => item.id);
    expect(listed).not.toContain(col.id);
    await expectCode(addCollectionDocuments({ id: col.id, document_ids: [docId] }), "failed_precondition");
  });
});

describe("mixed collections", () => {
  it("holds documents, transactions, meters and readings side by side", async () => {
    const docId = await document(OWNER, "Stromrechnung");
    const acc = await account([OWNER]);
    const tx = await transaction(acc, "Stadtwerke");
    const meterId = await meter(OWNER);
    const readingId = await reading(meterId, "1234.5");

    const col = await createAnyCollection({
      name: "Nebenkosten 2026",
      members: [
        { entity_type: "document", entity_id: docId },
        { entity_type: "transaction", entity_id: tx },
        { entity_type: "meter", entity_id: meterId },
        { entity_type: "meter_reading", entity_id: readingId },
      ],
    });
    expect(col.entity_type).toBeNull();
    expect(col.counts).toEqual({ document: 1, transaction: 1, meter: 1, meter_reading: 1 });
    expect(col.total).toBe(4);
    const byType = Object.fromEntries(col.members.map((m) => [m.entity_type, m]));
    expect(byType.document).toMatchObject({ entity_id: docId, title: "Stromrechnung", subtitle: "Beispiel GmbH" });
    expect(byType.transaction).toMatchObject({ title: "Stadtwerke", subtitle: "Girokonto", amount: "-42.50", currency: "EUR" });
    expect(byType.meter).toMatchObject({ title: "Strom Haus" });
    expect(byType.meter_reading?.title).toBe("Strom Haus: 1234.5 kWh");

    // The document went in through the document folder's own membership.
    const docItems = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM document_collection_items WHERE collection_id = ${col.id}`,
    );
    expect(docItems.rows[0]!.n).toBe(1);
  });

  it("shows each group reader only what they may open", async () => {
    const acc = await account([OWNER]);
    const tx = await transaction(acc, "Versicherung");
    const meterId = await meter(OWNER, GROUP);
    const col = await createAnyCollection({
      name: "Haushalt",
      visibility: "group",
      group_id: GROUP,
      members: [
        { entity_type: "transaction", entity_id: tx },
        { entity_type: "meter", entity_id: meterId },
      ],
    });

    as(MEMBER);
    const seen = await getAnyCollection({ id: col.id });
    expect(seen.members.map((m) => m.entity_type)).toEqual(["meter"]);
    expect(seen.hidden_count).toBe(1);

    // A reader without the finance module does not see transactions at all.
    as(OWNER, ["meters.view"]);
    const narrowed = await getAnyCollection({ id: col.id });
    expect(narrowed.members.map((m) => m.entity_type)).toEqual(["meter"]);

    as(STRANGER);
    await expectCode(getAnyCollection({ id: col.id }), "not_found");
  });

  it("takes members out again, documents through the folder's own removal", async () => {
    const docId = await document(OWNER, "Vertrag");
    const own = await photo(OWNER);
    const col = await createAnyCollection({
      name: "Fall",
      members: [
        { entity_type: "document", entity_id: docId },
        { entity_type: "photo", entity_id: own },
      ],
    });
    let detail = await removeAnyCollectionMember({ id: col.id, entityType: "photo", entityId: own });
    expect(detail.members.map((m) => m.entity_type)).toEqual(["document"]);
    detail = await removeAnyCollectionMember({ id: col.id, entityType: "document", entityId: docId });
    expect(detail.members).toHaveLength(0);
    expect(detail.total).toBe(0);
  });

  it("forgets a member whose row is deleted", async () => {
    const own = await photo(OWNER);
    const col = await createAnyCollection({ name: "Kurz", members: [{ entity_type: "photo", entity_id: own }] });
    await db.delete(photos).where(eq(photos.id, own));
    const rows = await db.select().from(collectionMembers).where(eq(collectionMembers.collection_id, col.id));
    expect(rows).toHaveLength(0);
  });
});

describe("finding collections", () => {
  it("filters by archive, type, contents, favourite and search", async () => {
    const own = await photo(OWNER);
    const fotos = await createAnyCollection({ name: "Fotos Sommer", entity_type: "photo", members: [{ entity_type: "photo", entity_id: own }] });
    const mixed = await createAnyCollection({ name: "Steuer 2026", description: "für die Steuerberatung" });
    const old = await createAnyCollection({ name: "Umzug 2024" });
    await updateAnyCollection({ id: old.id, archived: true });
    await updateAnyCollection({ id: mixed.id, favourite: true });

    const ids = async (req: Parameters<typeof listAllCollections>[0]) =>
      (await listAllCollections(req)).items.map((item) => item.id).sort();

    expect(await ids({})).toEqual([fotos.id, mixed.id].sort());
    expect(await ids({ archived: true })).toEqual([old.id]);
    expect(await ids({ type: "photo" })).toEqual([fotos.id]);
    expect(await ids({ type: "mixed" })).toEqual([mixed.id]);
    expect(await ids({ holds: "photo" })).toEqual([fotos.id]);
    expect(await ids({ favourite: true })).toEqual([mixed.id]);
    expect(await ids({ q: "steuerberatung" })).toEqual([mixed.id]);
  });

  it("keeps the star per reader", async () => {
    const col = await createAnyCollection({ name: "Gemeinsam", visibility: "group", group_id: GROUP });
    await updateAnyCollection({ id: col.id, favourite: true });
    as(MEMBER);
    const seen = (await listAllCollections({})).items.find((item) => item.id === col.id);
    expect(seen?.favourite).toBe(false);
    expect(seen?.can_administer).toBe(false);
    await expectCode(updateAnyCollection({ id: col.id, archived: true }), "permission_denied");
    await expectCode(deleteAnyCollection({ id: col.id }), "permission_denied");
  });

  it("puts the most recently opened first by default", async () => {
    const a = await createAnyCollection({ name: "A" });
    const b = await createAnyCollection({ name: "B" });
    await db.execute(sql`UPDATE collection_user_state SET last_opened_at = now() - interval '1 day' WHERE collection_id = ${b.id}`);
    await markCollectionOpened({ id: a.id });
    expect((await listAllCollections({})).items.map((item) => item.name)).toEqual(["A", "B"]);
    expect((await listAllCollections({ sort: "name", dir: "desc" })).items.map((item) => item.name)).toEqual(["B", "A"]);
  });

  it("names the collections that hold an item", async () => {
    const own = await photo(OWNER);
    const one = await createAnyCollection({ name: "Eins", members: [{ entity_type: "photo", entity_id: own }] });
    await createAnyCollection({ name: "Zwei" });
    const res = await collectionsOfItem({ entityType: "photo", entityId: own });
    expect(res.items.map((item) => item.id)).toEqual([one.id]);

    as(STRANGER);
    await expectCode(collectionsOfItem({ entityType: "photo", entityId: own }), "not_found");
  });

  it("deletes a collection with its members", async () => {
    const own = await photo(OWNER);
    const col = await createAnyCollection({ name: "Weg", members: [{ entity_type: "photo", entity_id: own }] });
    await deleteAnyCollection({ id: col.id });
    expect(await db.select().from(documentCollections).where(eq(documentCollections.id, col.id))).toHaveLength(0);
    expect(await db.select().from(collectionMembers).where(eq(collectionMembers.collection_id, col.id))).toHaveLength(0);
  });
});

describe("sortSummaries", () => {
  const item = (name: string, updated: string, opened: string | null, total: number) =>
    ({ name, updated_at: updated, last_opened_at: opened, total }) as CollectionSummary;

  it("sorts never-opened collections last when newest visits come first", () => {
    const items = [item("a", "2026-01-01", null, 1), item("b", "2026-01-02", "2026-02-01", 5)];
    expect(sortSummaries(items, "last_opened", "desc").map((i) => i.name)).toEqual(["b", "a"]);
    expect(sortSummaries(items, "count", "asc").map((i) => i.name)).toEqual(["a", "b"]);
  });
});

describe("trimDecimals", () => {
  it("drops the column's trailing zeros only", async () => {
    const { trimDecimals } = await import("./members");
    expect(trimDecimals("1234.500")).toBe("1234.5");
    expect(trimDecimals("1200.000")).toBe("1200");
    expect(trimDecimals("1200")).toBe("1200");
  });
});

describe("basket", () => {
  it("is one per user, made on first use and kept out of every folder list", async () => {
    const first = await getBasket();
    const again = await getBasket();
    expect(again.id).toBe(first.id);
    expect(first.kind).toBe("basket");
    expect(first.entity_type).toBeNull();

    const docId = await document(OWNER, "Kontoauszug");
    await addToBasket({ members: [{ entity_type: "document", entity_id: docId }] });
    expect((await listAllCollections({})).items.map((i) => i.id)).not.toContain(first.id);
    expect((await listCollections({})).items.map((i) => i.id)).not.toContain(first.id);
    expect((await listCollectionsForDocument({ id: docId })).items).toEqual([]);

    as(MEMBER);
    expect((await getBasket()).id).not.toBe(first.id);
  });

  it("holds any type, takes things out and empties by type", async () => {
    const own = await photo(OWNER);
    const acc = await account([OWNER]);
    const tx = await transaction(acc, "Bäckerei");
    const docId = await document(OWNER, "Beleg");
    let basket = (
      await addToBasket({
        members: [
          { entity_type: "photo", entity_id: own },
          { entity_type: "transaction", entity_id: tx },
          { entity_type: "document", entity_id: docId },
        ],
      })
    ).collection;
    expect(basket.counts).toEqual({ photo: 1, transaction: 1, document: 1 });

    // Removing what is not there is not an error.
    basket = await removeFromBasket({ members: [{ entity_type: "photo", entity_id: own }, { entity_type: "meter", entity_id: 1 }] });
    expect(basket.counts).toEqual({ transaction: 1, document: 1 });

    basket = await clearBasket({ type: "document" });
    expect(basket.members.map((m) => m.entity_type)).toEqual(["transaction"]);
    basket = await clearBasket({});
    expect(basket.total).toBe(0);
  });

  it("saves as a named collection, typed when it holds one type", async () => {
    const acc = await account([OWNER]);
    const a = await transaction(acc, "Miete");
    const b = await transaction(acc, "Strom");
    await addToBasket({ members: [{ entity_type: "transaction", entity_id: a }, { entity_type: "transaction", entity_id: b }] });

    const kept = await saveBasketAsCollection({ name: "Wohnen", keep: true });
    expect(kept.entity_type).toBe("transaction");
    expect(kept.members.map((m) => m.entity_id)).toEqual([a, b]);
    expect((await getBasket()).total).toBe(2);

    const own = await photo(OWNER);
    await addToBasket({ members: [{ entity_type: "photo", entity_id: own }] });
    const mixed = await saveBasketAsCollection({ name: "Alles" });
    expect(mixed.entity_type).toBeNull();
    expect(mixed.total).toBe(3);
    expect((await getBasket()).total).toBe(0);
    await expectCode(saveBasketAsCollection({ name: "Leer" }), "failed_precondition");
  });
});

describe("saved finance baskets", () => {
  it("are transaction collections, visible on both sides", async () => {
    as(OWNER, [...ALL_PERMISSIONS]);
    const acc = await account([OWNER]);
    const a = await transaction(acc, "Versicherung");
    const b = await transaction(acc, "Tankstelle");
    const saved = await saveBasketSnapshot({ name: "Q1", transaction_ids: [b, a] });
    expect(saved.tx_ids).toEqual([b, a]);

    const col = (await listAllCollections({ type: "transaction" })).items.find((i) => i.id === saved.id);
    expect(col?.name).toBe("Q1");

    // A transaction collection made elsewhere shows up as a saved basket too.
    const other = await createAnyCollection({ name: "Urlaub", entity_type: "transaction", members: [{ entity_type: "transaction", entity_id: a }] });
    expect((await listBasketSnapshots()).items.map((i) => i.name)).toEqual(["Q1", "Urlaub"]);
    expect((await loadBasketSnapshot({ id: other.id })).transaction_ids).toEqual([a]);

    // Saving under the same name replaces the contents.
    await saveBasketSnapshot({ name: "Q1", transaction_ids: [a] });
    expect((await loadBasketSnapshot({ id: saved.id })).transaction_ids).toEqual([a]);
  });

  it("migration 0243 copies a saved basket with its order, skipping deleted bookings", async () => {
    const acc = await account([OWNER]);
    const a = await transaction(acc, "Eins");
    const b = await transaction(acc, "Zwei");
    await db.execute(sql`
      INSERT INTO finance_basket_snapshot (user_id, name, tx_ids)
      VALUES (${OWNER}, 'Alt', ARRAY[${b}, 999999999, ${a}]::bigint[])
    `);
    const file = path.join(process.cwd(), "db/migrations/postgres/0243_collections_basket.sql");
    const statements = fs
      .readFileSync(file, "utf8")
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter((part) => part && !part.includes("CREATE UNIQUE INDEX"));
    try {
      for (const statement of statements) await db.execute(sql.raw(statement));
      const rows = await db.execute<{ id: number; entity_type: string }>(sql`
        SELECT id, entity_type FROM document_collections WHERE user_id = ${OWNER} AND title = 'Alt'
      `);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.entity_type).toBe("transaction");
      as(OWNER);
      expect((await loadBasketSnapshot({ id: rows.rows[0]!.id })).transaction_ids).toEqual([b, a]);
    } finally {
      await db.execute(sql`DELETE FROM finance_basket_snapshot WHERE user_id = ${OWNER}`);
      await db.execute(sql`ALTER TABLE document_collections DROP COLUMN IF EXISTS migrated_snapshot_id`);
    }
  });
});
