import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

// The language model is not reachable in tests; one case switches it on.
vi.mock("./llm-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./llm-client")>();
  return {
    ...orig,
    extractStatementValues: vi.fn(async () => {
      throw new orig.LlmServiceUnavailableError("not in tests");
    }),
  };
});

import db from "../db/database";
import {
  documentTagLinks,
  documentTags,
  documents,
  financeForecastDocumentLink,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastStatement,
  groupMembers,
  groups,
  users,
} from "../db/schema";
import { createItem, createPerson, updateItem } from "./forecast";
import { acceptStatement, decideStatementLink, getStatements, rejectStatement, rereadStatementLink, scanStatements } from "./forecast-statements";
import { onDocumentClassified, scanForUser } from "./forecast-statements.service";
import { extractStatementValues } from "./llm-client";

// Statement texts, contract numbers and amounts are invented.

const LIFE_TEXT = `Beispiel Lebensversicherung AG
Standmitteilung zu Ihrer Kapitallebensversicherung
Versicherungsnummer: X-000111-01
Stand: 01.12.2025
Ablauf der Beitragszahlung     01.10.2032
Ablauf der Versicherung        01.10.2037
Monatlicher Beitrag            241,02 EUR
Rückkaufswert                  77.508,29 EUR
Garantierte Ablaufleistung     55.000,00 EUR
Voraussichtliche Ablaufleistung inkl. Überschussbeteiligung   132.442,77 EUR`;

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

let seq = 0;
const createdDocs: number[] = [];
const createdTags: number[] = [];
const createdGroups: number[] = [];

async function addDocument(opts: {
  userId: number;
  text: string;
  tags?: string[];
  visibility?: "private" | "group";
  groupId?: number | null;
  docDate?: string;
}): Promise<number> {
  seq++;
  const [doc] = await db
    .insert(documents)
    .values({
      user_id: opts.userId,
      sha256: `forecast-statement-test-${Date.now()}-${seq}`,
      original_filename: `mitteilung-${seq}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 1000,
      disk_path: `/tmp/forecast-statement-test-${seq}.pdf`,
      status: "ready",
      title: `Standmitteilung ${seq}`,
      doc_date: opts.docDate ?? "2025-12-01",
      document_type: "standmitteilung",
      extracted_text: opts.text,
      visibility: opts.visibility ?? "private",
      group_id: opts.groupId ?? null,
    })
    .returning({ id: documents.id });
  createdDocs.push(doc.id);
  for (const name of opts.tags ?? []) {
    const [tag] = await db
      .insert(documentTags)
      .values({ name })
      .onConflictDoUpdate({ target: documentTags.name, set: { name } })
      .returning({ id: documentTags.id });
    createdTags.push(tag.id);
    await db.insert(documentTagLinks).values({ document_id: doc.id, tag_id: tag.id, source: "ai" });
  }
  return doc.id;
}

beforeEach(async () => {
  await db.delete(financeForecastStatement);
  await db.delete(financeForecastDocumentLink);
  await db.delete(financeForecastItem);
  await db.delete(financeForecastMilestone);
  await db.delete(financeForecastPerson);
  if (createdDocs.length) await db.delete(documents).where(inArray(documents.id, createdDocs.splice(0)));
  if (createdTags.length) await db.delete(documentTags).where(inArray(documentTags.id, createdTags.splice(0)));
  if (createdGroups.length) await db.delete(groups).where(inArray(groups.id, createdGroups.splice(0)));
  await db.delete(users);
  await ensureUser(1);
  await ensureUser(2);
  setAuth("1", ["finance.view"]);
  vi.mocked(extractStatementValues).mockClear();
});

async function lifeInsurance(contractNo = "X-000111-01") {
  const person = await createPerson({ label: "A", birthDate: "1970-01-01" });
  const item = await createItem({
    personId: person.id,
    type: "life_insurance",
    label: "LV Beispiel",
    data: {
      surrenderValue: 70000,
      monthlyPremium: 241.02,
      guaranteedPayout: 55000,
      projectedPayout: 130000,
      maturity: { kind: "date", date: "2038-01-01" },
      premiumEnd: { kind: "date", date: "2032-10-01" },
      contractNo,
      valuesSource: { kind: "import", updatedAt: "2026-01-01T00:00:00Z" },
    },
  });
  return { person, item };
}

describe("finance/forecast-statements — linking", () => {
  it("links by reference tag, reads the statement and proposes corrections", async () => {
    const { item } = await lifeInsurance();
    const docId = await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });

    const summary = await scanForUser(1, null, { wait: true });
    expect(summary).toMatchObject({ itemsWithContract: 1, linkedByTag: 1, suggestedByText: 0, queued: 1 });

    const state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.links).toEqual([expect.objectContaining({ documentId: docId, matchKind: "tag", status: "confirmed" })]);
    expect(state.latest).toMatchObject({ documentId: docId, referenceDate: "2025-12-01", method: "regex", status: "proposed" });
    expect(state.proposals.map((p) => p.field).sort()).toEqual(["maturity", "projectedPayout", "surrenderValue"]);
    expect(state.valuesSource).toMatchObject({ kind: "import" });
    expect(state.overdue).toBe(false);

    // Scanning again adds nothing and reads nothing twice.
    expect(await scanForUser(1, null, { wait: true })).toMatchObject({ linkedByTag: 0, queued: 0 });
  });

  it("matches contract numbers written differently", async () => {
    await lifeInsurance("X 000111/01");
    await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });
    expect((await scanForUser(1, null, { wait: true })).linkedByTag).toBe(1);
  });

  it("never links a document the owner may not see, but does link a shared one", async () => {
    await lifeInsurance();
    await addDocument({ userId: 2, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });
    expect((await scanForUser(1, null, { wait: true })).linkedByTag).toBe(0);

    const [g] = await db.insert(groups).values({ slug: `forecast-test-${Date.now()}`, name: "Familie" }).returning({ id: groups.id });
    createdGroups.push(g.id);
    await db.insert(groupMembers).values([
      { group_id: g.id, user_id: 1 },
      { group_id: g.id, user_id: 2 },
    ]);
    await addDocument({ userId: 2, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"], visibility: "group", groupId: g.id });
    expect((await scanForUser(1, null, { wait: true })).linkedByTag).toBe(1);
  });

  it("suggests a document found by its text and reads it only once confirmed", async () => {
    const { item } = await lifeInsurance();
    const docId = await addDocument({ userId: 1, text: LIFE_TEXT });
    const summary = await scanStatements({});
    expect(summary).toMatchObject({ linkedByTag: 0, suggestedByText: 1, queued: 0 });

    let state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    const link = state.links[0];
    expect(link).toMatchObject({ documentId: docId, matchKind: "text", status: "suggested" });
    expect(state.latest).toBeNull();
    await expect(rereadStatementLink({ id: link.id })).rejects.toThrow(/confirm/);

    await decideStatementLink({ id: link.id, status: "confirmed" });
    await rereadStatementLink({ id: link.id });
    state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.latest?.status).toBe("proposed");

    // Rejecting the document withdraws what it proposed.
    await decideStatementLink({ id: link.id, status: "rejected" });
    state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.proposals).toEqual([]);
  });

  it("links and reads a new document the moment it is classified", async () => {
    const { item } = await lifeInsurance();
    const docId = await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["vertragsnr:x-000111-01"] });
    await onDocumentClassified(docId);
    const state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.links[0]).toMatchObject({ documentId: docId, status: "confirmed" });
    expect(state.latest?.status).toBe("proposed");
    // A document of another user stays unlinked.
    const other = await addDocument({ userId: 2, text: LIFE_TEXT, tags: ["vertragsnr:x-000111-01"] });
    await onDocumentClassified(other);
    expect((await getStatements()).items.find((s) => s.itemId === item.id)!.links).toHaveLength(1);
  });

  it("uses the language model's values when it answers", async () => {
    const { item } = await lifeInsurance();
    vi.mocked(extractStatementValues).mockResolvedValueOnce({ surrenderValue: 78000, referenceDate: "2025-12-01" });
    await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });
    await scanForUser(1, null, { wait: true });
    const state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.latest).toMatchObject({ method: "llm" });
    expect(state.latest?.values.surrenderValue).toBe(78000);
    expect(state.latest?.values.projectedPayout).toBe(132442.77); // filled in from the patterns
  });
});

describe("finance/forecast-statements — decisions", () => {
  it("accepts some fields, then the rest, and keeps the statement as history", async () => {
    const { item } = await lifeInsurance();
    await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });
    await scanForUser(1, null, { wait: true });
    let state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    const stId = state.latest!.id;

    const partial = await acceptStatement({ id: stId, fields: ["surrenderValue"] });
    expect(partial.status).toBe("proposed");
    state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.proposals.map((p) => p.field).sort()).toEqual(["maturity", "projectedPayout"]);
    expect(state.valuesSource).toMatchObject({ kind: "statement", referenceDate: "2025-12-01" });

    const full = await acceptStatement({ id: stId });
    expect(full.status).toBe("accepted");
    const [row] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, item.id));
    expect(row.data).toMatchObject({ surrenderValue: 77508.29, projectedPayout: 132442.77, maturity: { kind: "date", date: "2037-10-01" } });
    state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.proposals).toEqual([]);
    expect(state.history).toHaveLength(1);
  });

  it("rejects a statement and flags an overdue one", async () => {
    const { item } = await lifeInsurance();
    await addDocument({ userId: 1, text: LIFE_TEXT.replace("Stand: 01.12.2025", "Stand: 01.12.2020"), tags: ["versicherungsnr:x-000111-01"], docDate: "2020-12-01" });
    await scanForUser(1, null, { wait: true });
    let state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.overdue).toBe(true);
    await rejectStatement({ id: state.latest!.id });
    state = (await getStatements()).items.find((s) => s.itemId === item.id)!;
    expect(state.latest).toBeNull();
    expect(state.proposals).toEqual([]);
  });

  it("keeps users apart", async () => {
    const { item } = await lifeInsurance();
    await addDocument({ userId: 1, text: LIFE_TEXT, tags: ["versicherungsnr:x-000111-01"] });
    await scanForUser(1, null, { wait: true });
    const stId = (await getStatements()).items.find((s) => s.itemId === item.id)!.latest!.id;
    setAuth("2", ["finance.view"]);
    expect((await getStatements()).items).toEqual([]);
    await expect(acceptStatement({ id: stId })).rejects.toThrow(/not found/);
    await expect(rejectStatement({ id: stId })).rejects.toThrow(/not found/);
    setAuth("1", []);
    await expect(getStatements()).rejects.toThrow(/permission/);
  });
});

describe("finance/forecast — values source", () => {
  it("marks hand-entered and hand-edited values as manual, but not a label change", async () => {
    const person = await createPerson({ label: "A", birthDate: "1970-01-01" });
    const created = await createItem({ personId: person.id, type: "salary", label: "Gehalt", data: { amount: 3000 } });
    expect(created.data.valuesSource).toMatchObject({ kind: "manual" });

    const { item } = await lifeInsurance();
    const renamed = await updateItem({ id: item.id, label: "LV neu", data: { ...item.data } });
    expect(renamed.data.valuesSource).toMatchObject({ kind: "import" });
    const edited = await updateItem({ id: item.id, data: { ...item.data, surrenderValue: 1 } });
    expect(edited.data.valuesSource).toMatchObject({ kind: "manual" });
  });
});
