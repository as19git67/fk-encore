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
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeCurrency,
  financeForecastBookingLink,
  financeForecastDocumentLink,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastShare,
  financeForecastStatement,
  financeTransaction,
  financeTransactionDocument,
  users,
} from "../db/schema";
import { createItem } from "./forecast";
import {
  acceptBookingPremium,
  decideBookingLink,
  decideStatementLink,
  getStatements,
  rereadStatementLink,
  scanStatements,
  setItemContractNo,
} from "./forecast-statements";

// Every insurer, contract number, amount and text below is invented.

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

beforeEach(async () => {
  await db.delete(financeForecastShare);
  await db.delete(financeForecastBookingLink);
  await db.delete(financeForecastStatement);
  await db.delete(financeForecastDocumentLink);
  await db.delete(financeForecastItem);
  await db.delete(financeForecastMilestone);
  await db.delete(financeForecastPerson);
  if (createdAccounts.length) {
    const ids = createdAccounts.splice(0);
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, ids));
    await db.delete(financeAccount).where(inArray(financeAccount.id, ids));
  }
  if (createdDocs.length) await db.delete(documents).where(inArray(documents.id, createdDocs.splice(0)));
  await db.delete(users);
  await ensureUser(1);
  await ensureUser(2);
  as(1);
});

async function account(userId = 1): Promise<number> {
  await db.insert(financeCurrency).values({ code: "EUR", symbol: "€" }).onConflictDoNothing();
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "giro"));
  const [acc] = await db
    .insert(financeAccount)
    .values({ type_id: type.id, currency_code: "EUR", account_number: `fc-book-${Date.now()}-${Math.random()}`, label: "Giro Beispiel" })
    .returning();
  createdAccounts.push(acc.id);
  await db.insert(financeAccountAccess).values({ account_id: acc.id, user_id: userId, level: "read" });
  return acc.id;
}

/** A booking this many months back from now. */
async function booking(
  accountId: number,
  monthsBack: number,
  amount: number,
  opts: { counterparty?: string; purpose?: string; mandateRef?: string } = {},
): Promise<number> {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  const [t] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: `${d.toISOString().slice(0, 10)}T00:00:00`,
      amount: amount.toFixed(2),
      currency_code: "EUR",
      counterparty: opts.counterparty ?? null,
      purpose: opts.purpose ?? null,
      mandate_ref: opts.mandateRef ?? null,
      dedupe_hash: `fc-book-${Date.now()}-${Math.random()}`,
    })
    .returning({ id: financeTransaction.id });
  return t.id;
}

const stateOf = async (itemId: number) => (await getStatements()).items.find((s) => s.itemId === itemId)!;

describe("finance/forecast — bookings that pay a premium", () => {
  it("links bookings naming the contract number and proposes the premium they say", async () => {
    const acc = await account();
    const item = await createItem({ type: "expense", label: "Haftpflicht", data: { amount: 90, frequency: "yearly", contractNo: "HP-000222-01" } });
    for (const [back, amount] of [[25, -85], [13, -88.5], [1, -95.2]] as const) {
      await booking(acc, back, amount, { counterparty: "Beispiel Versicherung AG", purpose: `Beitrag Vertrag HP 000222 01 ${back}` });
    }
    // The mandate reference counts too; an unrelated booking does not.
    await booking(acc, 2, -95.2, { counterparty: "Beispiel Versicherung AG", mandateRef: "HP00022201" });
    await booking(acc, 3, -12, { counterparty: "Bäckerei", purpose: "Brot" });

    const summary = await scanStatements({});
    // 25 months back is outside the window; 13 and 1 by purpose, 2 by mandate reference.
    expect(summary).toMatchObject({ bookingsLinked: 3, bookingsSuggested: 0 });
    const s = (await stateOf(item.id)).bookings;
    expect(s.bookings.map((b) => b.matchKind)).toEqual(["contract", "contract", "contract"]);
    expect(s.summary).toMatchObject({ rhythm: "yearly", lastAmount: 95.2, perYear: 95.2, count: 3 });
    expect(s.proposal).toMatchObject({ field: "amount", current: 90, proposed: 95.2 });
    expect(s.contractNoSuggestion).toBeNull(); // the item has one

    await acceptBookingPremium({ id: item.id });
    const [row] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, item.id));
    expect(row.data.amount).toBe(95.2);
  });

  it("suggests bookings by insurer and amount, and offers the mandate reference as contract number", async () => {
    const acc = await account();
    const item = await createItem({
      type: "expense",
      label: "Rechtsschutz",
      data: { amount: 22, frequency: "monthly", insurer: "Musterschutz Versicherungs-AG" },
    });
    const ids: number[] = [];
    for (const back of [4, 3, 2, 1]) {
      ids.push(await booking(acc, back, -26, { counterparty: "MUSTERSCHUTZ VERSICHERUNGS-AG", mandateRef: "RS-7700-4411" }));
    }
    await booking(acc, 5, -480, { counterparty: "Musterschutz Versicherungs-AG" }); // does not fit the premium
    await booking(acc, 2, -26, { counterparty: "Anderer Anbieter" });

    expect((await scanStatements({})).bookingsSuggested).toBe(4);
    let s = (await stateOf(item.id)).bookings;
    expect(s.bookings.every((b) => b.status === "suggested" && b.matchKind === "counterparty")).toBe(true);
    expect(s.summary).toBeNull(); // nothing confirmed yet

    for (const b of s.bookings) await decideBookingLink({ id: b.id, status: "confirmed" });
    s = (await stateOf(item.id)).bookings;
    expect(s.summary).toMatchObject({ rhythm: "monthly", lastAmount: 26, perYear: 312 });
    expect(s.proposal).toMatchObject({ field: "amount", current: 22, proposed: 26 });
    expect(s.contractNoSuggestion).toBe("RS-7700-4411");

    await acceptBookingPremium({ id: item.id });
    const [row] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, item.id));
    expect(row.data).toMatchObject({ amount: 26, valuesSource: { kind: "booking" } });
    expect((await stateOf(item.id)).bookings.proposal).toBeNull();
    await expect(acceptBookingPremium({ id: item.id })).rejects.toThrow(/no premium/);

    await setItemContractNo({ id: item.id, contractNo: "RS-7700-4411" });
    expect((await stateOf(item.id)).contractNo).toBe("RS-7700-4411");
    await expect(setItemContractNo({ id: item.id, contractNo: "x" })).rejects.toThrow(/4 to 60/);
  });

  it("links a booking through one of the item's documents and ignores accounts outside the household", async () => {
    const mine = await account(1);
    const foreign = await account(2);
    const item = await createItem({ type: "expense", label: "Wohngebäude", data: { amount: 400, frequency: "yearly", contractNo: "WG-555000-9" } });
    await booking(foreign, 1, -410, { purpose: "WG-555000-9" });
    const tx = await booking(mine, 2, -410, { counterparty: "Beispiel", purpose: "Beitrag" });
    const [doc] = await db
      .insert(documents)
      .values({
        user_id: 1,
        sha256: `fc-book-doc-${Date.now()}`,
        original_filename: "rechnung.pdf",
        mime_type: "application/pdf",
        size_bytes: 1000,
        disk_path: "/tmp/fc-book-doc.pdf",
        status: "ready",
        title: "Beitragsrechnung",
        doc_date: "2026-01-10",
        document_type: "rechnung",
        extracted_text: "Wohngebäudeversicherung Nr. WG-555000-9, Jahresbeitrag 410,00 EUR",
        visibility: "private",
      })
      .returning({ id: documents.id });
    createdDocs.push(doc.id);
    await db.insert(financeTransactionDocument).values({ transaction_id: tx, document_id: doc.id });

    await scanStatements({});
    let s = await stateOf(item.id);
    // The document is found by its text (a suggestion); the booking follows once it is confirmed.
    expect(s.bookings.bookings).toEqual([]);
    const link = s.links.find((l) => l.documentId === doc.id)!;
    await decideStatementLink({ id: link.id, status: "confirmed" });
    await scanStatements({});
    s = await stateOf(item.id);
    expect(s.bookings.bookings.map((b) => [b.transactionId, b.matchKind])).toEqual([[tx, "document"]]);
  });

  it("reads a premium invoice as a document with values", async () => {
    const item = await createItem({ type: "expense", label: "Hausrat", data: { amount: 90, frequency: "yearly", contractNo: "HR-000333-7" } });
    const [d] = await db
      .insert(documents)
      .values({
        user_id: 1,
        sha256: `fc-book-inv-${Date.now()}`,
        original_filename: "rechnung.pdf",
        mime_type: "application/pdf",
        size_bytes: 1,
        disk_path: "/tmp/inv.pdf",
        status: "ready",
        title: "Beitragsrechnung 2026",
        doc_date: "2026-01-05",
        document_type: "rechnung",
        extracted_text: "Beitragsrechnung\nVersicherungsnummer HR-000333-7\nJahresprämie 96,50 EUR",
        visibility: "private",
      })
      .returning({ id: documents.id });
    createdDocs.push(d.id);
    await scanStatements({});
    let s = await stateOf(item.id);
    await decideStatementLink({ id: s.links[0].id, status: "confirmed" });
    await rereadStatementLink({ id: s.links[0].id });
    s = await stateOf(item.id);
    expect(s.links[0].kind).toBe("premium_invoice");
    expect(s.latest?.values.premiumYearly).toBe(96.5);
    expect(s.proposals).toEqual([expect.objectContaining({ field: "amount", current: 90, proposed: 96.5 })]);
  });

  it("finds documents of an insurance without a contract number by insurer and kind", async () => {
    const item = await createItem({ type: "expense", label: "Privathaftpflicht", data: { amount: 8, frequency: "monthly", insurer: "Musterschutz AG" } });
    const mk = async (text: string) => {
      const [d] = await db
        .insert(documents)
        .values({
          user_id: 1,
          sha256: `fc-book-kind-${Date.now()}-${Math.random()}`,
          original_filename: "x.pdf",
          mime_type: "application/pdf",
          size_bytes: 1,
          disk_path: "/tmp/x.pdf",
          status: "ready",
          title: "Schreiben",
          extracted_text: text,
          visibility: "private",
        })
        .returning({ id: documents.id });
      createdDocs.push(d.id);
      return d.id;
    };
    const hit = await mk("Musterschutz AG – Ihre Privathaftpflichtversicherung: neuer Beitrag");
    await mk("Musterschutz AG – Ihre Hausratversicherung");
    await mk("Andere AG – Haftpflicht");
    await scanStatements({});
    const s = await stateOf(item.id);
    expect(s.links.map((l) => [l.documentId, l.status])).toEqual([[hit, "suggested"]]);
  });
});
