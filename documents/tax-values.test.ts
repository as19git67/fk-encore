/**
 * Reading the values off tax evidence (steuer-ausfuellhilfe, stage 2): the
 * checks on the model's answer, the owner from the household, and the job
 * with a fixed reader against the database. Synthetic documents only.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

vi.mock("./scan-worker", () => ({ triggerWorkers: vi.fn() }));
vi.mock("./llm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm-client")>()),
  jsonPrompt: vi.fn(async () => { throw new Error("no model in tests"); }),
}));

import db from "../db/database";
import { documentScanQueue, documentTaxReading, documentTaxValue, documents } from "../db/schema";
import { findEvidenceKind } from "./tax-evidence-kinds";
import {
  buildKindPrompt,
  buildValuesPrompt,
  checkReadValues,
  correctionExamples,
  describeCorrections,
  ownerFor,
  parseKindAnswer,
  queueTaxValuesIfEvidence,
  runTaxValues,
  type TaxValueReader,
} from "./tax-values";
import { queueTaxValuesBackfill } from "./tax-values-api";

const LOHN = findEvidenceKind("lohnsteuerbescheinigung")!;
const HANDWERK = findEvidenceKind("handwerkerrechnung")!;

const LOHN_TEXT = [
  "Ausdruck der elektronischen Lohnsteuerbescheinigung für 2025",
  "Beispiel GmbH, Beispielstraße 1, 12345 Musterstadt",
  "3. Bruttoarbeitslohn einschl. Sachbezüge 48.200,00",
  "4. Einbehaltene Lohnsteuer von 3. 7.950,40",
  "5. Einbehaltener Solidaritätszuschlag von 3. 0,00",
  "23. a) Arbeitnehmeranteil zur gesetzlichen Rentenversicherung 4.482,60",
].join("\n");

describe("checkReadValues", () => {
  it("keeps what stands in the text and rejects what does not, with the reason", () => {
    const values = checkReadValues(LOHN, {
      values: [
        { field: "bruttoarbeitslohn", printed: "48.200,00", quote: "3. Bruttoarbeitslohn 48.200,00" },
        { field: "lohnsteuer", printed: "7 950,40", quote: "4. Einbehaltene Lohnsteuer 7.950,40" },
        { field: "kirchensteuer", printed: "612,00", quote: "6. Kirchensteuer 612,00" },
        { field: "rv_arbeitnehmer", printed: "viel", quote: null },
        { field: "unbekannt", printed: "1,00" },
        { field: "bruttoarbeitslohn", printed: "1,00" },
        { field: "solidaritaetszuschlag", printed: null },
      ],
    }, LOHN_TEXT);
    expect(values.map((v) => [v.field, v.value, v.status, v.note])).toEqual([
      ["bruttoarbeitslohn", 4820000, "read", null],
      ["lohnsteuer", 795040, "read", null],
      ["kirchensteuer", 61200, "rejected", "Zahl steht nicht im Text"],
      ["rv_arbeitnehmer", 0, "rejected", "Zahl nicht lesbar"],
    ]);
  });

  it("attaches the kind's plausibility rule to values that cannot both be right", () => {
    const text = "Bruttoarbeitslohn 10.000,00\nLohnsteuer 6.000,00";
    const values = checkReadValues(LOHN, {
      values: [
        { field: "bruttoarbeitslohn", printed: "10.000,00" },
        { field: "lohnsteuer", printed: "6.000,00" },
      ],
    }, text);
    expect(values.every((v) => v.status === "read")).toBe(true);
    expect(values[0]!.note).toBe("Prüfen: Lohnsteuer über der Hälfte des Bruttoarbeitslohns");
  });

  it("takes a flag only with a quote the text contains", () => {
    const text = "Rechnung Malerarbeiten\nArbeitskosten 800,00 €\nZahlbar per Überweisung   ohne Abzug";
    const values = checkReadValues(HANDWERK, {
      values: [{ field: "arbeitskosten", printed: "800,00 €" }],
      flags: [{ field: "bargeld", value: false, quote: "zahlbar per Überweisung ohne Abzug" }],
    }, text);
    expect(values.map((v) => [v.field, v.value, v.status])).toEqual([["arbeitskosten", 80000, "read"], ["bargeld", 0, "read"]]);
    const invented = checkReadValues(HANDWERK, { flags: [{ field: "bargeld", value: true, quote: "Betrag bar erhalten" }] }, text);
    expect(invented[0]).toMatchObject({ status: "rejected", note: "Zitat steht nicht im Text" });
  });

  it("survives answers of the wrong shape", () => {
    expect(checkReadValues(LOHN, null, LOHN_TEXT)).toEqual([]);
    expect(checkReadValues(LOHN, { values: "48.200,00" }, LOHN_TEXT)).toEqual([]);
  });
});

describe("prompts", () => {
  it("offers only the candidate kinds and accepts only one of them", () => {
    const kinds = [LOHN, HANDWERK];
    const prompt = buildKindPrompt(kinds, LOHN_TEXT);
    expect(prompt).toContain('"lohnsteuerbescheinigung"');
    expect(prompt).not.toContain('"jahressteuerbescheinigung"');
    expect(parseKindAnswer({ kind: "lohnsteuerbescheinigung" }, kinds)).toBe(LOHN);
    expect(parseKindAnswer({ kind: "jahressteuerbescheinigung" }, kinds)).toBeNull();
    expect(parseKindAnswer({ kind: null }, kinds)).toBeNull();
  });

  it("names every field of the kind", () => {
    const prompt = buildValuesPrompt(LOHN, 2025, LOHN_TEXT);
    for (const f of LOHN.fields) expect(prompt).toContain(`"${f.key}"`);
    expect(prompt).toContain("Steuerjahr 2025");
  });
});

describe("corrections in the prompt", () => {
  it("states what was read, what is right and where it stands, only for the kind's amounts", () => {
    const text = describeCorrections(LOHN, [
      { field: "bruttoarbeitslohn", printed: "48.200,00", cents: 4810000, quote: "3. Bruttoarbeitslohn 48.200,00" },
      { field: "lohnsteuer", printed: null, cents: 795040, quote: null },
      { field: "unbekannt", printed: "1,00", cents: 200, quote: null },
    ]);
    expect(text).toContain('- "bruttoarbeitslohn" (Bruttoarbeitslohn): gelesen wurde "48.200,00", richtig ist 48.100,00 (steht in: "3. Bruttoarbeitslohn 48.200,00")');
    expect(text).toContain('- "lohnsteuer" (Einbehaltene Lohnsteuer): richtig ist 7.950,40\n');
    expect(text).not.toContain("unbekannt");
    expect(text).toContain("die Beträge dort gelten nicht für dieses Dokument");
    expect(describeCorrections(LOHN, [])).toBe("");
  });

  it("goes into the values prompt before the document", () => {
    const prompt = buildValuesPrompt(LOHN, 2025, LOHN_TEXT, [{ field: "lohnsteuer", printed: "795,04", cents: 795040, quote: null }]);
    expect(prompt.indexOf("berichtigt")).toBeGreaterThan(-1);
    expect(prompt.indexOf("berichtigt")).toBeLessThan(prompt.indexOf("Dokument:\n"));
    expect(buildValuesPrompt(LOHN, 2025, LOHN_TEXT)).not.toContain("berichtigt");
  });
});

describe("ownerFor", () => {
  const self = { id: 1, relationKind: "self" };
  const spouse = { id: 2, relationKind: "spouse" };
  const child = { id: 3, relationKind: "child" };
  it("follows the Bezugspersonen on the document", () => {
    expect(ownerFor("person", [])).toBe("self");
    expect(ownerFor("person", [spouse])).toBe("spouse");
    expect(ownerFor("person", [self, spouse])).toBe("joint");
    expect(ownerFor("return", [spouse])).toBe("joint");
    expect(ownerFor("child", [child])).toBe("child:3");
    expect(ownerFor("child", [child, { id: 4, relationKind: "child" }])).toBe("self");
  });
});

// -----------------------------------------------------------------------
// The job against the database
// -----------------------------------------------------------------------

const USER_ID = 991640;
const DOC = 991641;
const OTHER = 991642;
const SPOUSE_ID = 991643;
// A year no other test file uses, so the backfill only sees these documents.
const YEAR = 2031;

async function insertDoc(id: number, role: string, type: string | null, text: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO documents
      (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, extracted_text, tax_role, tax_relevant, tax_year, document_type)
    VALUES
      (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1, ${`/tmp/d-${id}.pdf`},
       'ready', ${text}, ${role}, ${role === "beleg"}, ${YEAR}, ${type})`);
}

const reader = (answer: unknown): TaxValueReader & { asked: number } => {
  const r = {
    asked: 0,
    async pickKind(kinds: readonly { key: string }[]) {
      return kinds.find((k) => k.key === "lohnsteuerbescheinigung") as never ?? null;
    },
    async readValues() {
      r.asked++;
      return answer;
    },
  };
  return r;
};

async function stored() {
  return db
    .select({ field: documentTaxValue.field_key, value: documentTaxValue.value, owner: documentTaxValue.owner, status: documentTaxValue.status })
    .from(documentTaxValue)
    .where(eq(documentTaxValue.document_id, DOC))
    .orderBy(documentTaxValue.field_key);
}

async function cleanup() {
  await db.delete(documents).where(inArray(documents.id, [DOC, OTHER]));
  await db.execute(sql`DELETE FROM user_subject_persons WHERE user_id = ${USER_ID}`);
}

describe("runTaxValues", () => {
  beforeEach(async () => {
    await db.execute(sql`INSERT INTO users (id, email, name, password_hash)
      VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x') ON CONFLICT (id) DO NOTHING`);
    await cleanup();
    await insertDoc(DOC, "beleg", "bescheinigung", LOHN_TEXT);
    await db.execute(sql`INSERT INTO document_tax_sections (document_id, tax_section) VALUES (${DOC}, 'anlage-n')`);
  });
  afterAll(cleanup);

  const answer = {
    values: [
      { field: "bruttoarbeitslohn", printed: "48.200,00" },
      { field: "lohnsteuer", printed: "7.950,40" },
      { field: "kirchensteuer", printed: "999,99" },
    ],
  };

  it("stores read and rejected values for the spouse named on the document", async () => {
    await db.execute(sql`INSERT INTO user_subject_persons (id, user_id, full_name, relation_tag, relation_kind)
      VALUES (${SPOUSE_ID}, ${USER_ID}, 'Erika Mustermann', 'ehefrau', 'spouse')`);
    await db.execute(sql`INSERT INTO document_subject_persons (document_id, subject_person_id) VALUES (${DOC}, ${SPOUSE_ID})`);

    const result = await runTaxValues(DOC, reader(answer));
    expect(result).toEqual({ kind: "lohnsteuerbescheinigung", read: 2, rejected: 1 });
    expect(await stored()).toEqual([
      { field: "bruttoarbeitslohn", value: 4820000, owner: "spouse", status: "read" },
      { field: "kirchensteuer", value: 99999, owner: "spouse", status: "rejected" },
      { field: "lohnsteuer", value: 795040, owner: "spouse", status: "read" },
    ]);
    const [reading] = await db.select().from(documentTaxReading).where(eq(documentTaxReading.document_id, DOC));
    expect(reading!.evidence_kind).toBe("lohnsteuerbescheinigung");
  });

  it("re-reads without touching what the user confirmed", async () => {
    await runTaxValues(DOC, reader(answer));
    await db.update(documentTaxValue).set({ status: "corrected", value: 4800000 })
      .where(and(eq(documentTaxValue.document_id, DOC), eq(documentTaxValue.field_key, "bruttoarbeitslohn")));
    await runTaxValues(DOC, reader({ values: [{ field: "bruttoarbeitslohn", printed: "48.200,00" }] }));
    expect(await stored()).toEqual([
      { field: "bruttoarbeitslohn", value: 4800000, owner: "self", status: "corrected" },
    ]);
  });

  it("drops the read values once the document is no evidence any more", async () => {
    await runTaxValues(DOC, reader(answer));
    await db.update(documents).set({ tax_role: "bezug", tax_relevant: false }).where(eq(documents.id, DOC));
    const r = reader(answer);
    expect(await runTaxValues(DOC, r)).toEqual({ kind: null, read: 0, rejected: 0 });
    expect(r.asked).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("queues evidence after classify and the backfill only once", async () => {
    await insertDoc(OTHER, "keine", null, "Werbeprospekt");
    expect(await queueTaxValuesIfEvidence(OTHER)).toBe(false);
    expect(await queueTaxValuesIfEvidence(DOC)).toBe(true);
    const jobs = await db.select().from(documentScanQueue)
      .where(and(inArray(documentScanQueue.document_id, [DOC, OTHER]), eq(documentScanQueue.service, "tax_values")));
    expect(jobs.map((j) => j.document_id)).toEqual([DOC]);
    // Already queued: the backfill leaves it.
    const before = await queueTaxValuesBackfill({ year: YEAR });
    expect(before.queued).toBe(0);
    await db.delete(documentScanQueue).where(eq(documentScanQueue.document_id, DOC));
    await runTaxValues(DOC, reader(answer));
    expect((await queueTaxValuesBackfill({ year: YEAR })).queued).toBe(0);
    expect((await queueTaxValuesBackfill({ year: YEAR, reread: true })).queued).toBe(1);
  });
});

describe("learning from corrections", () => {
  const OWNER = 991650;
  const STRANGER = 991651;
  const NEW = 991652;
  const OLD_A = 991653;
  const OLD_B = 991654;
  const OTHER_SENDER = 991655;
  const FOREIGN = 991656;
  const IDS = [NEW, OLD_A, OLD_B, OTHER_SENDER, FOREIGN];

  async function doc(id: number, user: number, sender: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO documents
        (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
         status, extracted_text, tax_role, tax_relevant, tax_year, document_type, correspondent_slug)
      VALUES
        (${id}, ${user}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1, ${`/tmp/d-${id}.pdf`},
         'ready', ${LOHN_TEXT}, 'beleg', true, ${YEAR}, 'bescheinigung', ${sender})`);
  }

  async function corrected(documentId: number, field: string, printed: string, cents: number, at: string, kind = "lohnsteuerbescheinigung"): Promise<void> {
    await db.insert(documentTaxValue).values({
      document_id: documentId, tax_year: YEAR, owner: "self", evidence_kind: kind, field_key: field,
      value: cents, printed, quote: `${field} ${printed}`, status: "corrected", updated_at: at,
    });
  }

  beforeEach(async () => {
    for (const id of [OWNER, STRANGER]) {
      await db.execute(sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`);
    }
    await db.delete(documents).where(inArray(documents.id, IDS));
    await doc(NEW, OWNER, "beispiel-gmbh");
    await db.execute(sql`INSERT INTO document_tax_sections (document_id, tax_section) VALUES (${NEW}, 'anlage-n')`);
    await doc(OLD_A, OWNER, "beispiel-gmbh");
    await doc(OLD_B, OWNER, "beispiel-gmbh");
    await doc(OTHER_SENDER, OWNER, "muster-ag");
    await doc(FOREIGN, STRANGER, "beispiel-gmbh");
    await corrected(OLD_A, "bruttoarbeitslohn", "4.820,00", 4820000, "2026-01-01T00:00:00Z");
    await corrected(OLD_B, "bruttoarbeitslohn", "48.200,00", 4810000, "2026-02-01T00:00:00Z");
    // Confirmed as read, only stored as "corrected": nothing to learn.
    await corrected(OLD_B, "lohnsteuer", "7.950,40", 795040, "2026-02-01T00:00:00Z");
    await corrected(OTHER_SENDER, "kirchensteuer", "1,00", 61200, "2026-03-01T00:00:00Z");
    await corrected(FOREIGN, "solidaritaetszuschlag", "1,00", 4000, "2026-03-01T00:00:00Z");
    await corrected(OLD_A, "arbeitskosten", "1,00", 64000, "2026-03-01T00:00:00Z", "handwerkerrechnung");
  });
  afterAll(async () => {
    await db.delete(documents).where(inArray(documents.id, IDS));
  });

  it("takes the latest correction per field of the same owner, sender and kind", async () => {
    const examples = await correctionExamples({ id: NEW, userId: OWNER, correspondent: "beispiel-gmbh" }, "lohnsteuerbescheinigung");
    expect(examples).toEqual([{ field: "bruttoarbeitslohn", printed: "48.200,00", cents: 4810000, quote: "bruttoarbeitslohn 48.200,00" }]);
    // Without a known sender there is nothing to learn from.
    expect(await correctionExamples({ id: NEW, userId: OWNER, correspondent: null }, "lohnsteuerbescheinigung")).toEqual([]);
  });

  it("hands the examples to the reader", async () => {
    const seen: unknown[] = [];
    const r: TaxValueReader = {
      async pickKind(kinds) { return kinds.find((k) => k.key === "lohnsteuerbescheinigung") ?? null; },
      async readValues(_kind, _year, _text, examples) { seen.push(examples); return { values: [] }; },
    };
    await runTaxValues(NEW, r);
    expect(seen).toEqual([[{ field: "bruttoarbeitslohn", printed: "48.200,00", cents: 4810000, quote: "bruttoarbeitslohn 48.200,00" }]]);
  });
});
