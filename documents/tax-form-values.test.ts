/**
 * The values of a year by form field (steuer-ausfuellhilfe, stage 3): the
 * sums over the stored evidence values, only from documents the caller may
 * see, joint assessment from the household, and confirming and correcting a
 * value. Synthetic documents and amounts only.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { documentTaxValue, documents } from "../db/schema";
import {
  buildTaxFormValues,
  confirmDocumentTaxValue,
  confirmTaxValue,
  correctDocumentTaxValue,
  correctTaxValue,
  getTaxFormValues,
  isJointReturn,
  ownerLabel,
} from "./tax-form-values";
import { runTaxValues, type TaxValueReader } from "./tax-values";

const USER = 991660;
const STRANGER = 991661;
const LOHN_A = 991662;
const LOHN_B = 991663;
const HANDWERK = 991664;
const FOREIGN = 991665;
const UNREAD = 991666;
const DOCS = [LOHN_A, LOHN_B, HANDWERK, FOREIGN, UNREAD];
// Every query is the test user's, so other files' 2025 documents do not count.
const YEAR = 2025;

async function insertDoc(id: number, owner: number, title: string, read = true): Promise<void> {
  await db.execute(sql`
    INSERT INTO documents
      (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, extracted_text, tax_role, tax_relevant, tax_year, document_type, title)
    VALUES
      (${id}, ${owner}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1, ${`/tmp/d-${id}.pdf`},
       'ready', 'Beispieltext', 'beleg', true, ${YEAR}, 'bescheinigung', ${title})`);
  if (read) await db.execute(sql`INSERT INTO document_tax_reading (document_id, evidence_kind) VALUES (${id}, 'lohnsteuerbescheinigung')`);
}

async function value(documentId: number, kind: string, field: string, cents: number, owner: string, status = "read", extra: { printed?: string; quote?: string; note?: string } = {}): Promise<number> {
  const [row] = await db.insert(documentTaxValue).values({
    document_id: documentId,
    tax_year: YEAR,
    owner,
    evidence_kind: kind,
    field_key: field,
    value: cents,
    printed: extra.printed ?? null,
    quote: extra.quote ?? null,
    page: 1,
    status: status as "read",
    note: extra.note ?? null,
  }).returning({ id: documentTaxValue.id });
  return row!.id;
}

async function cleanup() {
  await db.delete(documents).where(inArray(documents.id, DOCS));
  await db.execute(sql`DELETE FROM user_subject_persons WHERE user_id IN (${USER}, ${STRANGER})`);
}

async function addSpouse(ownReturnFrom: number | null = null) {
  await db.execute(sql`INSERT INTO user_subject_persons (user_id, full_name, relation_tag, relation_kind, own_tax_return_from_tax_year)
    VALUES (${USER}, 'Erika Beispiel', 'Ehefrau', 'spouse', ${ownReturnFrom})`);
}

function auth(permissions: string[], userID = String(USER)) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions } as never);
}

describe("values by form field", () => {
  let brutto = 0;
  let lohnsteuer = 0;
  let rejected = 0;

  beforeEach(async () => {
    for (const id of [USER, STRANGER]) {
      await db.execute(sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`);
    }
    await cleanup();
    await insertDoc(LOHN_A, USER, "Lohnsteuerbescheinigung Beispiel GmbH");
    await insertDoc(LOHN_B, USER, "Lohnsteuerbescheinigung Muster AG");
    await insertDoc(HANDWERK, USER, "Rechnung Malerbetrieb");
    await insertDoc(FOREIGN, STRANGER, "Fremder Beleg");
    await insertDoc(UNREAD, USER, "Noch nicht gelesen", false);
    brutto = await value(LOHN_A, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 3000000, "self", "read", { printed: "30.000,00", quote: "3. Bruttoarbeitslohn 30.000,00" });
    lohnsteuer = await value(LOHN_A, "lohnsteuerbescheinigung", "lohnsteuer", 450000, "self");
    await value(LOHN_B, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 1200000, "self", "confirmed");
    await value(LOHN_B, "lohnsteuerbescheinigung", "rv_arbeitnehmer", 111600, "spouse");
    await value(HANDWERK, "handwerkerrechnung", "arbeitskosten", 64000, "joint");
    await value(HANDWERK, "handwerkerrechnung", "material", 30000, "joint");
    rejected = await value(HANDWERK, "handwerkerrechnung", "rechnungsbetrag", 99900, "joint", "rejected", { printed: "999,00", note: "Zahl steht nicht im Text" });
    await value(FOREIGN, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 9900000, "self");
  });
  afterAll(cleanup);

  it("sums the caller's evidence per field and owner, with line, Kennzahl and where each value came from", async () => {
    const r = await buildTaxFormValues(USER, YEAR);
    const brutto = r.values.find((v) => v.key === "n.bruttoarbeitslohn" && v.owner === "self")!;
    // The stranger's 99.000 € stay out.
    expect(brutto.cents).toBe(4200000);
    expect(brutto).toMatchObject({ line: 5, kennzahl: "110", place: "Zeile 5 · Kz 110", checked: true, prefilled: true, open: 1 });
    expect(brutto.anlage_name).toContain("Anlage N");
    expect(brutto.contributions.map((c) => [c.document_title, c.cents, c.status])).toEqual([
      ["Lohnsteuerbescheinigung Beispiel GmbH", 3000000, "read"],
      ["Lohnsteuerbescheinigung Muster AG", 1200000, "confirmed"],
    ]);
    expect(brutto.contributions[0]).toMatchObject({ printed: "30.000,00", quote: "3. Bruttoarbeitslohn 30.000,00", page: 1, field_label: "Bruttoarbeitslohn", evidence_kind_name: "Lohnsteuerbescheinigung" });
    expect(r.values.find((v) => v.key === "haushaltsnahe.handwerker")).toMatchObject({ owner: "return", cents: 64000, place: "Zeile 9 · Kz 214" });
    expect(r).toMatchObject({ year: YEAR, exact: true, joint: false, documents_read: 3, documents_unread: 1 });
  });

  it("lists a rejected value for correction, and leaves out what only steers a rule", async () => {
    const r = await buildTaxFormValues(USER, YEAR);
    expect(r.skipped.map((s) => [s.value_id, s.field_label, s.reason])).toEqual([
      [rejected, "Rechnungsbetrag brutto", "Zahl steht nicht im Text"],
    ]);
  });

  it("assesses jointly while a spouse has no return of their own, and puts Person B under the 400s", async () => {
    expect(await isJointReturn(USER, YEAR, null)).toBe(false);
    await addSpouse();
    expect(await isJointReturn(USER, YEAR, null)).toBe(true);
    const r = await buildTaxFormValues(USER, YEAR);
    expect(r.values.find((v) => v.key === "vorsorge.rv_arbeitnehmer")).toMatchObject({ owner: "spouse", owner_label: "Person B (Ehegatte)", kennzahl: "400", place: "Zeile 4 · Kz 400" });
    expect(r.values.find((v) => v.key === "n.bruttoarbeitslohn")!.owner_label).toBe("Person A (Sie)");
    expect(r.joint).toBe(true);
  });

  it("marks every place unchecked in a year without a catalogue of its own", async () => {
    const later = 2034;
    await db.execute(sql`UPDATE documents SET tax_year = ${later} WHERE id = ${LOHN_A}`);
    await db.execute(sql`UPDATE document_tax_value SET tax_year = ${later} WHERE document_id = ${LOHN_A}`);
    const r = await buildTaxFormValues(USER, later);
    expect(r).toMatchObject({ exact: false, catalogue_year: 2025 });
    expect(r.values.every((v) => v.place === "Kennzahl prüfen" && !v.checked)).toBe(true);
  });

  it("is single again from the year the spouse files alone", async () => {
    await addSpouse(YEAR);
    expect(await isJointReturn(USER, YEAR, null)).toBe(false);
    expect(await isJointReturn(USER, YEAR - 1, null)).toBe(true);
  });

  it("confirms a value, which then survives a re-read", async () => {
    expect(await confirmTaxValue(USER, lohnsteuer)).toEqual({ id: lohnsteuer, status: "confirmed", value_cents: 450000 });
    const reader: TaxValueReader = { async pickKind() { return null; }, async readValues() { return {}; } };
    await runTaxValues(LOHN_A, reader);
    const left = await db.select({ id: documentTaxValue.id, status: documentTaxValue.status }).from(documentTaxValue).where(eq(documentTaxValue.document_id, LOHN_A));
    // The read value went with the re-read; the confirmed one stayed.
    expect(left).toEqual([{ id: lohnsteuer, status: "confirmed" }]);
  });

  it("corrects a value, also a rejected one, and the sums follow", async () => {
    await correctTaxValue(USER, brutto, 3100000);
    await correctTaxValue(USER, rejected, 94000);
    const r = await buildTaxFormValues(USER, YEAR);
    expect(r.values.find((v) => v.key === "n.bruttoarbeitslohn")!.cents).toBe(4300000);
    expect(r.values.find((v) => v.key === "n.bruttoarbeitslohn")!.contributions[0]!.status).toBe("corrected");
    const [row] = await db.select().from(documentTaxValue).where(eq(documentTaxValue.id, brutto));
    expect(row).toMatchObject({ status: "corrected", value: 3100000, corrected_by: USER });
    // Confirming a corrected value keeps the correction.
    expect((await confirmTaxValue(USER, brutto)).status).toBe("corrected");
  });

  it("refuses values of documents the caller cannot see, and amounts that are no amounts", async () => {
    const foreign = (await db.select({ id: documentTaxValue.id }).from(documentTaxValue).where(eq(documentTaxValue.document_id, FOREIGN)))[0]!.id;
    await expect(confirmTaxValue(USER, foreign)).rejects.toThrow("not found");
    await expect(correctTaxValue(USER, foreign, 100)).rejects.toThrow("not found");
    await expect(correctTaxValue(USER, brutto, -5)).rejects.toThrow("value_cents");
    await expect(correctTaxValue(USER, brutto, 12.5)).rejects.toThrow("value_cents");
  });

  it("needs documents.view to read and documents.edit to change", async () => {
    auth(["module.documents"]);
    await expect(getTaxFormValues({ year: YEAR })).rejects.toThrow();
    auth(["module.documents", "documents.view"]);
    expect((await getTaxFormValues({ year: YEAR })).values.length).toBeGreaterThan(0);
    await expect(getTaxFormValues({ year: 1800 })).rejects.toThrow("year");
    await expect(confirmDocumentTaxValue({ id: lohnsteuer })).rejects.toThrow();
    auth(["module.documents", "documents.view", "documents.edit"]);
    expect((await correctDocumentTaxValue({ id: lohnsteuer, value_cents: 460000 })).status).toBe("corrected");
    // Another user's Steuerakte is not found.
    await expect(getTaxFormValues({ year: YEAR, tax_return_person: 1 })).rejects.toThrow("not found");
  });
});

describe("ownerLabel", () => {
  it("names the owners as the forms do", () => {
    expect(ownerLabel("self", true)).toBe("Person A (Sie)");
    expect(ownerLabel("self", false)).toBe("Sie");
    expect(ownerLabel("spouse", true)).toBe("Person B (Ehegatte)");
    expect(ownerLabel("return", true)).toBe("Gemeinsam");
    expect(ownerLabel("child:7", false, new Map([["child:7", "Kind Beispiel"]]))).toBe("Kind Beispiel");
    expect(ownerLabel("child:?", false)).toBe("Kind nicht zugeordnet");
  });
});
