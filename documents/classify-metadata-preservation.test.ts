import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * A re-classify must not be able to lose metadata a previous run extracted.
 *
 * `doc_date` and `sender` used to be written straight through from the
 * classifier's answer, while the neighbouring `title` fell back to the stored
 * value. The model returning null is not a statement that the document has no
 * sender — it is silence. Writing that silence through erased good data, and
 * the 2026-08-25 re-classify of the full ~7000-document corpus did exactly that
 * to a sizeable share of it: classification was sampled at the time, so a
 * document could go quiet on one run and not the next. The first attempt now
 * decodes greedily, which removes that particular flip-flop but not the need
 * for this guard — a model change, a prompt change or a re-extracted text all
 * still produce a different answer for the same document.
 *
 * The loss was not confined to the two columns. `classification.sender` is what
 * the sender rules and the learned category/tag/tax memory key on, and
 * `learned-rules.ts` only counts documents with a non-null sender at all — so a
 * document that went quiet for one run also dropped out of the rule that had
 * been filing it correctly and fell back to the model's unaided guess. That is
 * why the carry-forward happens before the rule layers rather than at the
 * patch.
 */
const RESPONSE = {
  category_slug: "sonstiges",
  title: "AI Titel",
  doc_date: null as string | null,
  sender: null as string | null,
  document_number: null as string | null,
  summary: "AI Zusammenfassung",
  confidence: 0.9,
  tags: [] as string[],
  tax_relevant: false,
  tax_year: null,
  tax_year_confidence: null,
  tax_sections: [] as { slug: string; confidence: number }[],
};

vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => RESPONSE),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents, documentCategories, documentSenderRuleOverrides, userSubjectPersons } from "../db/schema";
import { invalidateSenderRuleOverridesCache } from "./sender-rule-overrides";
import { runClassify } from "./document-ops";

const USER_ID = 990413;
const DOC_ID = 990413;

const STORED_SENDER = "Musterwerkstatt GmbH";
const STORED_DATE = "2021-03-04";

async function ensureCategory(slug: string, name: string): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug, name })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function seedDocument(opts: { sender?: string | null; docDate?: string | null } = {}) {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, sender, doc_date)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying',
           'Ein Text ohne datierte Beschriftung und ohne Absenderzeile.',
           ${opts.sender === undefined ? STORED_SENDER : opts.sender},
           ${opts.docDate === undefined ? STORED_DATE : opts.docDate})`,
  );
}

async function readDoc() {
  return (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
}

beforeEach(async () => {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  await ensureCategory("sonstiges", "Sonstiges");
  await ensureCategory("fahrzeug-werkstatt", "Werkstatt");
  await db.delete(documentSenderRuleOverrides);
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  invalidateSenderRuleOverridesCache();
  RESPONSE.sender = null;
  RESPONSE.doc_date = null;
  RESPONSE.category_slug = "sonstiges";
});

describe("runClassify — metadata a previous run extracted", () => {
  it("keeps the stored sender when this run returned none", async () => {
    await seedDocument();

    await runClassify(DOC_ID);

    expect((await readDoc()).sender).toBe(STORED_SENDER);
  });

  it("keeps the stored date when neither the model nor the label scan found one", async () => {
    await seedDocument();

    await runClassify(DOC_ID);

    expect((await readDoc()).doc_date).toBe(STORED_DATE);
  });

  it("still lets a fresh answer replace the stored one", async () => {
    // The carry-forward is a floor, not a freeze — a later run that does read
    // the document must be able to correct both fields.
    RESPONSE.sender = "Beispiel Versicherung AG";
    RESPONSE.doc_date = "2024-11-02";
    await seedDocument();

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.sender).toBe("Beispiel Versicherung AG");
    expect(row.doc_date).toBe("2024-11-02");
  });

  it("carries the sender far enough forward for the sender rules to see it", async () => {
    // The reason this is fixed upstream of the patch. With the carry-forward at
    // the patch the rule layers would still run against a null sender, and the
    // document would keep the model's unaided answer.
    await db.insert(documentSenderRuleOverrides).values({
      note: "test",
      sender_pattern: "musterwerkstatt",
      category: "fahrzeug-werkstatt",
    });
    invalidateSenderRuleOverridesCache();
    await seedDocument();

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_decided_by).toBe("sender_rule");
    expect(row.category_id).toBe(await ensureCategory("fahrzeug-werkstatt", "Werkstatt"));
  });

  it("reads the sender off the letterhead when the model returned none", async () => {
    // The stored value is not the only source: a document that never had a
    // sender still has one printed on it. Before extractSender existed the
    // sender came from the model alone, so a quiet run left the field empty
    // even when the letterhead named the company unmistakably.
    await db.delete(documents).where(eq(documents.id, DOC_ID));
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
             status, extracted_text, sender, doc_date)
          VALUES
            (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
             ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying',
             ${"Muster Lebensversicherung AG\nBeispielplatz 1\n50679 Musterstadt\n\nMusterstadt, im Mai 2009"},
             NULL, NULL)`,
    );

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.sender).toBe("Muster Lebensversicherung AG");
    // and the month-only letterhead date resolves to the first of the month
    expect(row.doc_date).toBe("2009-05-01");
  });

  it("still clears a sender that names a household member", async () => {
    // The one case where an empty sender is an assertion rather than silence:
    // the model put a Bezugsperson in the sender field and the metadata cleanup
    // rejected it. Falling back to the stored value here would reinstate a
    // value already known to be wrong.
    await db.insert(userSubjectPersons).values({
      user_id: USER_ID,
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
      relation_kind: "parent",
    });
    RESPONSE.sender = "Erika Mustermann";
    await seedDocument();

    await runClassify(DOC_ID);

    expect((await readDoc()).sender).toBeNull();
  });
});
