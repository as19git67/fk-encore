import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * Who actually chose the category a document ends up with.
 *
 * `runClassify` resolves it as
 *     contentSlug ?? ruleSlug ?? learnedCatSlug ?? classification.category_slug
 * and, when the chosen slug matches no category row, quietly keeps the previous
 * label. Until migration 0153 none of that reached the database — the only
 * record was a console.log line, so a container restart erased it.
 *
 * The 2026-08-24 cloud audit ran straight into that. Nine category slugs were
 * never once stored across 380 audited documents, and with the logs rotated
 * away there was no way to tell a model that never picks them from a rule that
 * overrides them from a slug that failed to resolve. These pin the two columns
 * that make the next audit able to answer it.
 */
const RESPONSE = {
  category_slug: "gesundheit-arzt",
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
import { documents, documentCategories } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990412;
const DOC_ID = 990412;

async function ensureCategory(slug: string, name: string): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug, name })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function seedDocument(opts: {
  text?: string;
  categoryId?: number | null;
  attributesReviewed?: boolean;
} = {}): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, category_id, attributes_reviewed)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying',
           ${opts.text ?? "irgendein extrahierter Text"},
           ${opts.categoryId ?? null}, ${opts.attributesReviewed ?? false})`,
  );
}

async function readDoc() {
  return (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
}

let sonstigesId = 0;
let arztId = 0;

beforeEach(async () => {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  sonstigesId = await ensureCategory("sonstiges", "Sonstiges");
  arztId = await ensureCategory("gesundheit-arzt", "Arzt");
  await ensureCategory("familie-familienleistungen", "Familienleistungen");
  RESPONSE.category_slug = "gesundheit-arzt";
});

describe("runClassify — category decision provenance", () => {
  it("credits the model when nothing overrides it", async () => {
    await seedDocument();

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_id).toBe(arztId);
    expect(row.category_decided_by).toBe("model");
    expect(row.classifier_raw_category_slug).toBe("gesundheit-arzt");
  });

  it("records the model's answer even when a content rule overrides it", async () => {
    // The raw slug is the whole point: without it an overridden document is
    // indistinguishable from one the model got wrong, which is the confusion
    // that made the audit's category number unreadable.
    await seedDocument({ text: "Bitte geben Sie stets Ihre Kindergeldnummer an." });

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_decided_by).toBe("content_rule");
    expect(row.classifier_raw_category_slug).toBe("gesundheit-arzt");
    // and the stored category is the rule's, not the model's
    expect(row.category_id).not.toBe(arztId);
  });

  it("reports an unresolvable slug as such rather than crediting a layer", async () => {
    // No layer's answer was applied here — the document kept its previous
    // label — so naming one would misreport what happened.
    RESPONSE.category_slug = "erfundene-kategorie-die-es-nicht-gibt";
    await seedDocument({ categoryId: arztId });

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_decided_by).toBe("unresolved_slug");
    expect(row.category_id).toBe(arztId);
    // The invented slug is retained verbatim; it is the only evidence of what
    // the model tried to say, and a slug the model keeps inventing is a
    // taxonomy problem rather than a model one.
    expect(row.classifier_raw_category_slug).toBe("erfundene-kategorie-die-es-nicht-gibt");
  });

  it("marks a pinned document as pinned and still records what the model said", async () => {
    await seedDocument({ categoryId: sonstigesId, attributesReviewed: true });

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_decided_by).toBe("pinned");
    expect(row.category_id).toBe(sonstigesId);
    expect(row.classifier_raw_category_slug).toBe("gesundheit-arzt");
  });
});
