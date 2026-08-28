import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents } from "../db/schema";

/**
 * A document too large to index must still be stored.
 *
 * `text_tsv` used to be a `GENERATED ALWAYS ... STORED` column, so
 * `to_tsvector` ran as part of every write. PostgreSQL caps a tsvector's
 * lexeme content at 1 MB, and hitting that cap aborted the whole `UPDATE` —
 * the document went to `failed` and its entire extracted text was discarded,
 * over an index that could simply have been shorter.
 *
 * The cap is reachable by real paperwork: a bank statement of ~80 000
 * transactions carries a distinct lexeme for every date, amount and reference.
 * Prose never gets near it (2.26 MB of letter text yields a 4.7 KB tsvector),
 * so the failure only ever showed up on exactly the documents worth OCR-ing.
 *
 * Migration 0155 moved the column behind a trigger that catches the failure
 * and retries on a truncated input. What that has to guarantee is asserted
 * here: the write succeeds, the text is stored in full, and the document stays
 * searchable.
 */

const USER_ID = 990901;
const DOC_ID = 990901;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function insertDoc(text: string): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, extracted_text, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'huge.pdf', 'application/pdf', 1,
           ${`/tmp/tsv-${DOC_ID}.pdf`}, 'ready', 'Kontoauszug', ${text}, 'private')`,
  );
}

/**
 * Text with enough *distinct* lexemes to blow the cap — which is what matters,
 * not the length. Shaped like the statement rows that reach it in production:
 * a unique date-ish token, amount and reference per line.
 */
function statementText(rows: number): string {
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(`buchung${i} betrag${i} referenz${i}`);
  }
  return out.join("\n");
}

beforeEach(async () => {
  await ensureUser(USER_ID);
});

describe("documents.text_tsv guard", () => {
  it("stores a document whose text cannot be indexed in full", async () => {
    // Without the guard this INSERT raises "string is too long for tsvector"
    // and the caller loses the whole extraction.
    const text = statementText(200_000);
    await insertDoc(text);

    const [row] = await db
      .select({ len: sql<number>`length(extracted_text)` })
      .from(documents)
      .where(eq(documents.id, DOC_ID));

    // Stored in full: the index degrades, the text never does.
    expect(row.len).toBe(text.length);
  });

  it("keeps such a document searchable", async () => {
    await insertDoc(statementText(200_000));

    const found = await db.execute(
      sql`SELECT text_tsv @@ plainto_tsquery('german', 'buchung1') AS hit,
                 text_tsv @@ plainto_tsquery('german', 'Kontoauszug') AS title_hit
            FROM documents WHERE id = ${DOC_ID}`,
    );
    const hit = (found.rows?.[0] ?? (found as any)[0]) as Record<string, unknown>;

    expect(hit.hit).toBe(true);
    // The title is prepended to the body before truncation, so it survives
    // even when the body is cut — losing it would make a huge document
    // unfindable by the one field a user is most likely to search for.
    expect(hit.title_hit).toBe(true);
  });

  it("indexes an ordinary document in full", async () => {
    // The guard must not cost anything on the 99.9 % case.
    await insertDoc("Sehr geehrte Damen und Herren, Rechnungsdatum 23.08.2002.");

    const found = await db.execute(
      sql`SELECT text_tsv @@ plainto_tsquery('german', 'Rechnungsdatum') AS hit
            FROM documents WHERE id = ${DOC_ID}`,
    );
    const hit = (found.rows?.[0] ?? (found as any)[0]) as Record<string, unknown>;
    expect(hit.hit).toBe(true);
  });
});
