import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

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
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeCurrency,
  financeForecastDocumentLink,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastScenario,
  financeForecastShare,
  financeForecastStatement,
  groupMembers,
  groups,
  users,
} from "../db/schema";
import { createItem, createPerson, getForecast } from "./forecast";
import { getStatements, scanStatements } from "./forecast-statements";
import { createShare, deleteShare, getShareCandidates, getSharing, joinShare, updateShare } from "./forecast-sharing";

// Every name, number and amount below is invented.

function as(userID: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions: ["finance.view"] });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

const createdAccounts: number[] = [];
const createdDocs: number[] = [];
const createdTags: number[] = [];
const createdGroups: number[] = [];

beforeEach(async () => {
  await db.delete(financeForecastShare);
  await db.delete(financeForecastStatement);
  await db.delete(financeForecastDocumentLink);
  await db.delete(financeForecastScenario);
  await db.delete(financeForecastItem);
  await db.delete(financeForecastMilestone);
  await db.delete(financeForecastPerson);
  if (createdAccounts.length) await db.delete(financeAccount).where(inArray(financeAccount.id, createdAccounts.splice(0)));
  if (createdDocs.length) await db.delete(documents).where(inArray(documents.id, createdDocs.splice(0)));
  if (createdTags.length) await db.delete(documentTags).where(inArray(documentTags.id, createdTags.splice(0)));
  if (createdGroups.length) await db.delete(groups).where(inArray(groups.id, createdGroups.splice(0)));
  await db.delete(users);
  for (const id of [1, 2, 3]) await ensureUser(id);
  as(1);
});

async function household(): Promise<number> {
  as(1);
  const person = await createPerson({ label: "Alex", birthDate: "1970-01-01" });
  await createItem({ personId: null, type: "living_expense", label: "Lebenshaltung", data: { amount: 3000 } });
  return person.id;
}

async function group(memberIds: number[]): Promise<number> {
  const [g] = await db.insert(groups).values({ slug: `fc-share-${Date.now()}-${Math.random()}`, name: "Familie" }).returning({ id: groups.id });
  createdGroups.push(g.id);
  await db.insert(groupMembers).values(memberIds.map((user_id) => ({ group_id: g.id, user_id })));
  return g.id;
}

describe("finance/forecast — sharing within a household", () => {
  it("lets the person it is shared with work on the owner's forecast", async () => {
    await household();
    const share = await createShare({ userId: 2, level: "edit" });
    expect(share).toMatchObject({ userId: 2, userName: "User2", groupId: null, level: "edit" });

    as(2);
    const bundle = await getForecast();
    expect(bundle.household).toEqual({ role: "edit", ownerName: "User1" });
    expect(bundle.persons.map((p) => p.label)).toEqual(["Alex"]);
    // What the partner adds lands in the shared forecast.
    await createItem({ personId: null, type: "expense", label: "Kfz", data: { amount: 80, frequency: "monthly" } });
    as(1);
    expect((await getForecast()).items.map((i) => i.label).sort()).toEqual(["Kfz", "Lebenshaltung"]);
    const rows = await db.select().from(financeForecastItem).where(eq(financeForecastItem.label, "Kfz"));
    expect(rows[0].user_id).toBe(1);
    expect((await getForecast()).household).toEqual({ role: "owner", ownerName: null });
  });

  it("keeps a view-only share read-only and lets only the owner manage shares", async () => {
    await household();
    const share = await createShare({ userId: 2, level: "view" });
    as(2);
    expect((await getForecast()).household.role).toBe("view");
    await expect(createItem({ personId: null, type: "expense", label: "X", data: { amount: 1, frequency: "monthly" } })).rejects.toThrow(/read-only/);
    await expect(createShare({ userId: 3, level: "edit" })).rejects.toThrow(/only the owner/);
    await expect(updateShare({ id: share.id, level: "edit" })).rejects.toThrow(/not found/);

    as(1);
    await updateShare({ id: share.id, level: "edit" });
    as(2);
    expect((await getForecast()).household.role).toBe("edit");
    as(1);
    await expect(createShare({ userId: 2, level: "edit" })).rejects.toThrow(/already shared/);
    await expect(createShare({ userId: 1, level: "edit" })).rejects.toThrow(/owner/);
    await expect(createShare({ level: "edit" })).rejects.toThrow(/either/);
  });

  it("shares through a group the owner belongs to, and ending the share leaves the owner's data alone", async () => {
    await household();
    const gid = await group([1, 3]);
    const foreignGroup = await group([2, 3]);
    await expect(createShare({ groupId: foreignGroup, level: "edit" })).rejects.toThrow(/not found/);
    const share = await createShare({ groupId: gid, level: "edit" });
    expect(share).toMatchObject({ groupId: gid, groupName: "Familie" });
    expect((await getShareCandidates()).groups.map((g) => g.id)).toEqual([gid]);

    as(3);
    expect((await getForecast()).persons.map((p) => p.label)).toEqual(["Alex"]);
    as(2);
    expect((await getForecast()).persons).toEqual([]);

    as(1);
    await deleteShare({ id: share.id });
    as(3);
    expect((await getForecast()).persons).toEqual([]);
    as(1);
    expect((await getForecast()).persons.map((p) => p.label)).toEqual(["Alex"]);
  });

  it("offers a shared forecast to someone who keeps their own, and switching deletes theirs", async () => {
    // Kim kept a forecast of her own before Alex shared his.
    as(2);
    await createPerson({ label: "Kim eigen", birthDate: "1972-01-01" });
    await household();
    await createShare({ userId: 2, level: "edit" });
    as(2);
    expect((await getForecast()).household.role).toBe("owner");
    const state = await getSharing();
    expect(state).toMatchObject({ role: "owner", hasOwnForecast: true });
    expect(state.offers).toEqual([expect.objectContaining({ ownerId: 1, ownerName: "User1", level: "edit", groupName: null })]);
    await expect(joinShare({ ownerId: 3 })).rejects.toThrow(/no forecast/);

    const after = await joinShare({ ownerId: 1 });
    expect(after).toMatchObject({ role: "edit", ownerName: "User1", hasOwnForecast: false, offers: [] });
    expect((await getForecast()).persons.map((p) => p.label)).toEqual(["Alex"]);
    expect(await db.select().from(financeForecastPerson).where(eq(financeForecastPerson.user_id, 2))).toEqual([]);
  });

  it("shows the balance of an account the partner linked, to everyone in the household", async () => {
    await household();
    await createShare({ userId: 2, level: "edit" });
    await db.insert(financeCurrency).values({ code: "EUR", symbol: "€" }).onConflictDoNothing();
    const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "tagesgeld"));
    const [acc] = await db
      .insert(financeAccount)
      .values({ type_id: type.id, currency_code: "EUR", account_number: `fc-share-${Date.now()}`, label: "Tagesgeld Kim" })
      .returning();
    createdAccounts.push(acc.id);
    await db.insert(financeAccountBalance).values({ account_id: acc.id, as_of: "2026-02-01T00:00:00Z", balance: "7000.00", source: "manual" });
    await db.insert(financeAccountAccess).values({ account_id: acc.id, user_id: 2, level: "read" });

    as(2);
    await createItem({ type: "asset", label: "TG Kim", data: { pot: "cash" }, linkedAccountId: acc.id });
    as(1);
    const item = (await getForecast()).items.find((i) => i.label === "TG Kim")!;
    expect(item.linkedAccountBalance).toBe(7000);
  });

  it("finds the partner's private statements but lets only them open the document", async () => {
    await household();
    await createShare({ userId: 2, level: "edit" });
    await createItem({ personId: null, type: "expense", label: "Haftpflicht", data: { amount: 90, frequency: "yearly", contractNo: "HP-000222-01" } });
    const [doc] = await db
      .insert(documents)
      .values({
        user_id: 2,
        sha256: `fc-share-doc-${Date.now()}`,
        original_filename: "beitrag.pdf",
        mime_type: "application/pdf",
        size_bytes: 1000,
        disk_path: "/tmp/fc-share-doc.pdf",
        status: "ready",
        title: "Beitragsrechnung",
        doc_date: "2026-01-10",
        document_type: "rechnung",
        extracted_text: "Beispiel Versicherung AG\nVersicherungsnummer: HP-000222-01\nJahresbeitrag 95,00 EUR",
        visibility: "private",
      })
      .returning({ id: documents.id });
    createdDocs.push(doc.id);
    const [tag] = await db
      .insert(documentTags)
      .values({ name: "versicherungsnr:hp-000222-01" })
      .onConflictDoUpdate({ target: documentTags.name, set: { name: "versicherungsnr:hp-000222-01" } })
      .returning({ id: documentTags.id });
    createdTags.push(tag.id);
    await db.insert(documentTagLinks).values({ document_id: doc.id, tag_id: tag.id, source: "ai" });

    as(1);
    expect((await scanStatements({})).linkedByTag).toBe(1);
    const mine = (await getStatements()).items.find((s) => s.contractNo === "HP-000222-01")!;
    expect(mine.links[0]).toMatchObject({ documentId: doc.id, title: "Beitragsrechnung", canOpen: false });
    as(2);
    const theirs = (await getStatements()).items.find((s) => s.contractNo === "HP-000222-01")!;
    expect(theirs.links[0].canOpen).toBe(true);
  });
});
