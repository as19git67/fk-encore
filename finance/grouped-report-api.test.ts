/**
 * Grouped reports through their endpoints (#1533): only readable bookings,
 * tag groups as rules, a kept report re-run on the bookings of then, and the
 * PDF. Synthetic bookings only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeGroupedReport,
  financeTag,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";
import {
  createGroupedReport,
  deleteGroupedReport,
  getGroupedReport,
  listGroupedReports,
  previewGroupedReport,
  runReport,
} from "./grouped-report-api";
import { createGroupedReportPdf } from "./pdf-report";

const USER = 991533;
const OTHER = 991534;
const TAG = "Miete-1533";

function setAuth(userID: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions: ["module.finance", "finance.view"] } as never);
}

async function ensureUser(id: number) {
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`);
}

let mine: number;
let foreign: number;
const tx: Record<string, number> = {};

async function account(label: string): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [row] = await db.insert(financeAccount)
    .values({ type_id: type.id, currency_code: "EUR", account_number: `AN-${label}`, label })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function booking(key: string, accountId: number, date: string, amount: string): Promise<number> {
  const [row] = await db.insert(financeTransaction)
    .values({ account_id: accountId, booking_date: `${date}T00:00:00`, amount, currency_code: "EUR", counterparty: `Gegenseite ${key}`, purpose: `Zweck ${key}`, dedupe_hash: `test-1533-${key}-${accountId}-${date}` })
    .returning({ id: financeTransaction.id });
  tx[key] = row.id;
  return row.id;
}

async function tag(transactionId: number) {
  const [t] = await db.insert(financeTag).values({ name: TAG, source: "user" })
    .onConflictDoUpdate({ target: [financeTag.name, financeTag.source], set: { name: TAG } })
    .returning({ id: financeTag.id });
  await db.insert(financeTagTransaction).values({ tag_id: t.id, transaction_id: transactionId });
}

beforeEach(async () => {
  await ensureUser(USER);
  await ensureUser(OTHER);
  await db.delete(financeGroupedReport).where(inArray(financeGroupedReport.user_id, [USER, OTHER]));
  const accounts = await db.select({ id: financeAccount.id }).from(financeAccount).where(inArray(financeAccount.label, ["Giro 1533", "Fremd 1533"]));
  const ids = accounts.map((a) => a.id);
  if (ids.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, ids));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, ids));
    await db.delete(financeAccount).where(inArray(financeAccount.id, ids));
  }
  await db.delete(financeTag).where(eq(financeTag.name, TAG));

  mine = await account("Giro 1533");
  foreign = await account("Fremd 1533");
  await db.insert(financeAccountAccess).values({ account_id: mine, user_id: USER, level: "read" });
  await db.insert(financeAccountAccess).values({ account_id: foreign, user_id: OTHER, level: "read" });

  await booking("kauf", mine, "2025-01-10", "-300000.00");
  await booking("reparatur", mine, "2025-03-01", "-1200.00");
  await booking("miete1", mine, "2025-02-01", "800.00");
  await booking("miete2", mine, "2025-03-01", "800.00");
  await booking("bank", mine, "2025-03-31", "-12.34");
  await booking("fremd", foreign, "2025-02-01", "-99.00");
  await tag(tx.miete1);
  await tag(tx.miete2);
  setAuth(USER);
});

const definition = () => ({
  title: "Wohnung Musterstadt",
  groups: [
    { name: "Kauf", transaction_ids: [tx.kauf] },
    { name: "Reparatur", transaction_ids: [tx.reparatur] },
    { name: "Mieteinnahmen", tag: TAG },
  ],
  transaction_ids: [tx.kauf, tx.reparatur, tx.miete1, tx.miete2, tx.bank],
  yield: { investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: ["Reparatur"] },
});

describe("grouped reports", () => {
  it("preview: groups, Sonstige, total and yield, nothing kept", async () => {
    const r = await previewGroupedReport(definition());
    expect(r.id).toBeNull();
    expect(r.groups.map((g) => [g.name, g.count, g.subtotal])).toEqual([
      ["Kauf", 1, -30000000],
      ["Reparatur", 1, -120000],
      ["Mieteinnahmen", 2, 160000],
      ["Sonstige", 1, -1234],
    ]);
    expect(r.total).toBe(-30000000 - 120000 + 160000 - 1234);
    expect(r.yield).toMatchObject({ investment: 30000000, income: 160000, costs: -120000, net: 40000, from: "2025-01-10" });
    expect(await listGroupedReports()).toEqual({ items: [] });
  });

  it("accepts only bookings on readable accounts", async () => {
    await expect(previewGroupedReport({ ...definition(), groups: [{ name: "Fremd", transaction_ids: [tx.fremd] }] }))
      .rejects.toThrow(`bookings not found or not readable: ${tx.fremd}`);
    // A tag group only finds what the caller may read.
    setAuth(OTHER);
    await expect(previewGroupedReport({ title: "x", groups: [{ name: "Miete", tag: TAG }] }))
      .resolves.toMatchObject({ count: 0 });
  });

  it("a kept report runs again on the bookings of then; a tag group takes new bookings", async () => {
    const created = await createGroupedReport(definition());
    expect(created.id).toEqual(expect.any(Number));
    expect((await listGroupedReports()).items.map((i) => i.title)).toEqual(["Wohnung Musterstadt"]);

    await booking("miete3", mine, "2025-04-01", "800.00");
    await tag(tx.miete3);
    const again = await getGroupedReport({ id: created.id! });
    expect(again.groups.find((g) => g.name === "Mieteinnahmen")).toMatchObject({ count: 3, subtotal: 240000 });

    setAuth(OTHER);
    await expect(getGroupedReport({ id: created.id! })).rejects.toThrow("report not found");
    setAuth(USER);
    expect(await deleteGroupedReport({ id: created.id! })).toEqual({ deleted: true });
  });

  it("refuses a group with both ids and a tag, or neither", async () => {
    await expect(previewGroupedReport({ title: "x", groups: [{ name: "A" }] })).rejects.toThrow("either transaction_ids or a tag");
    await expect(previewGroupedReport({ title: "x", groups: [{ name: "A", tag: TAG, transaction_ids: [tx.kauf] }] }))
      .rejects.toThrow("either transaction_ids or a tag");
  });

  it("renders a PDF with headings, subtotals and the formula", async () => {
    const report = await runReport({ userID: String(USER), permissions: ["finance.view"] }, definition(), "2026-01-10");
    const pdf = createGroupedReportPdf(report);
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise((resolve) => pdf.on("end", resolve));
    pdf.end();
    await done;
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(Buffer.concat(chunks)), verbosity: 0 });
    const doc = await task.promise;
    let text = "";
    for (let n = 1; n <= doc.numPages; n++) {
      text += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    }
    await task.destroy();
    text = text.replace(/ /g, " ");
    for (const s of ["Wohnung Musterstadt", "Zwischensumme Kauf", "Zwischensumme Mieteinnahmen", "Sonstige", "Summe (5 Buchungen)", "Rendite p. a.", "365 Tage vom 10.01.2025 bis 10.01.2026"]) {
      expect(text, s).toContain(s);
    }
  });
});
