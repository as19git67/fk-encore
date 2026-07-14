import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documentCorrespondentOverrides, documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { relocateDocument } from "./relocate";
import {
  createCorrespondentOverride,
  deleteCorrespondentOverride,
  listCorrespondentOverrides,
  listCorrespondents,
} from "./documents";
import { invalidateCorrespondentOverridesCache } from "./correspondent-overrides";

const USER_ID = 990501;
const DOC_ID = 990501;

function setAuth(perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["module.documents", ...perms],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function readCorrespondent(): Promise<{ slug: string | null; display: string | null }> {
  const [row] = await db
    .select({ slug: documents.correspondent_slug, display: documents.correspondent_display })
    .from(documents)
    .where(eq(documents.id, DOC_ID));
  return { slug: row?.slug ?? null, display: row?.display ?? null };
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.delete(documentCorrespondentOverrides);
  invalidateCorrespondentOverridesCache();
  await ensureUser(USER_ID);

  // A ready document with a resolvable sender. disk_path lives under
  // DOCUMENTS_DIR (path-guard) but need not exist on disk — relocateDocument
  // persists the correspondent before any file move.
  const diskPath = path.join(DOCUMENTS_DIR, `u${USER_ID}`, "_inbox", "2026-01", `x-${DOC_ID}.pdf`);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, sender, title, doc_date, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'x.pdf', 'application/pdf', 1,
           ${diskPath}, 'ready', 'Janitos Versicherung AG', 'Hausratversicherung',
           '2026-01-15', 'private')`,
  );
});

describe("correspondent — persistence, facet and overrides", () => {
  it("persists the institution correspondent on relocate", async () => {
    await relocateDocument(DOC_ID);
    expect(await readCorrespondent()).toEqual({ slug: "janitos", display: "Janitos" });
  });

  it("surfaces the correspondent in the facet endpoint", async () => {
    await relocateDocument(DOC_ID);
    setAuth(["documents.view"]);
    const res = await listCorrespondents();
    const janitos = res.items.find((i) => i.slug === "janitos");
    expect(janitos).toBeDefined();
    expect(janitos!.display).toBe("Janitos");
    expect(janitos!.count).toBeGreaterThanOrEqual(1);
  });

  it("lets a user override win, and reverts when removed", async () => {
    await relocateDocument(DOC_ID);
    expect((await readCorrespondent()).slug).toBe("janitos");

    setAuth(["documents.manage_taxonomy"]);
    const created = await createCorrespondentOverride({
      sender_pattern: "Janitos",
      correspondent_display: "Sonderfall X",
    });
    expect(created.sender_pattern).toBe("janitos");
    expect(created.correspondent_slug).toBe("sonderfall-x");

    const list = await listCorrespondentOverrides();
    expect(list.items.map((o) => o.sender_pattern)).toContain("janitos");

    await relocateDocument(DOC_ID);
    expect(await readCorrespondent()).toEqual({ slug: "sonderfall-x", display: "Sonderfall X" });

    await deleteCorrespondentOverride({ id: created.id });
    await relocateDocument(DOC_ID);
    expect((await readCorrespondent()).slug).toBe("janitos");
  });
});
