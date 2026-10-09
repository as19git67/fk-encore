import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  applyDossierRulesForDocument,
  applyRuleToCorpus,
  normalizeRule,
  ruleMatchesDocument,
} from "./dossiers";
import { parseUserReferenceNumbers } from "./reference-numbers";

describe("normalizeRule", () => {
  it("normalises every part and drops an empty rule", () => {
    expect(normalizeRule({ correspondent_slug: " Beispiel-AG ", reference_numbers: ["ab 12-34", "AB1234", "x"], source_folder_prefix: "/Versicherungen/Hausrat/" }))
      .toEqual({ correspondent_slug: "beispiel-ag", reference_numbers: ["AB1234"], source_folder_prefix: "Versicherungen/Hausrat" });
    expect(normalizeRule({ correspondent_slug: "", reference_numbers: [], source_folder_prefix: null })).toBeNull();
    expect(normalizeRule(null)).toBeNull();
    expect(normalizeRule({ correspondent_slug: "x-ag" }, { excluded_document_ids: [7] })).toEqual({ correspondent_slug: "x-ag", excluded_document_ids: [7] });
  });
});

describe("ruleMatchesDocument", () => {
  const refs = (...values: string[]) => parseUserReferenceNumbers(values.map((v) => ({ value: v })));
  const doc = (over: Partial<Parameters<typeof ruleMatchesDocument>[1]> = {}) => ({
    id: 1, correspondent_slug: "beispiel-ag", reference_numbers: refs("AB 123456"), source_folder: "Versicherungen/Hausrat/2024", ...over,
  });

  it("needs every set part among correspondent and numbers", () => {
    expect(ruleMatchesDocument({ correspondent_slug: "beispiel-ag", reference_numbers: ["AB123456"] }, doc())).toBe(true);
    expect(ruleMatchesDocument({ correspondent_slug: "andere-ag", reference_numbers: ["AB123456"] }, doc())).toBe(false);
    expect(ruleMatchesDocument({ correspondent_slug: "beispiel-ag", reference_numbers: ["ZZ9999"] }, doc())).toBe(false);
    expect(ruleMatchesDocument({ reference_numbers: ["AB123456"] }, doc({ correspondent_slug: null }))).toBe(true);
  });

  it("lets the folder prefix in on its own, and only below the prefix", () => {
    expect(ruleMatchesDocument({ source_folder_prefix: "Versicherungen/Hausrat" }, doc({ correspondent_slug: null, reference_numbers: [] }))).toBe(true);
    expect(ruleMatchesDocument({ source_folder_prefix: "Versicherungen/Haus" }, doc())).toBe(false);
    expect(ruleMatchesDocument({ source_folder_prefix: "Versicherungen/Hausrat", correspondent_slug: "andere-ag" }, doc())).toBe(true);
  });

  it("never matches an empty rule or an excluded document", () => {
    expect(ruleMatchesDocument({}, doc())).toBe(false);
    expect(ruleMatchesDocument({ correspondent_slug: "beispiel-ag", excluded_document_ids: [1] }, doc())).toBe(false);
  });
});

// ─── Against the database ───────────────────────────────────────────────────

const OWNER_ID = 951_101;
const MEMBER_ID = 951_102;
const GROUP_ID = 951_201;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@dossiers.test`}, ${`User ${id}`}, 'x') ON CONFLICT (id) DO NOTHING
  `);
}
async function ensureGroup(): Promise<void> {
  await db.execute(sql`INSERT INTO groups (id, slug, name) VALUES (${GROUP_ID}, 'dossiers-test-group', 'Dossiers') ON CONFLICT (id) DO NOTHING`);
  for (const uid of [OWNER_ID, MEMBER_ID]) {
    await db.execute(sql`INSERT INTO group_members (group_id, user_id, role) VALUES (${GROUP_ID}, ${uid}, 'member') ON CONFLICT DO NOTHING`);
  }
}

let seq = 0;
async function insertDoc(opts: {
  userId?: number; correspondent?: string | null; refs?: string[]; folder?: string | null;
  visibility?: "private" | "group"; groupId?: number | null;
}): Promise<number> {
  seq += 1;
  const sha = `dos-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const refs = JSON.stringify(parseUserReferenceNumbers((opts.refs ?? []).map((v) => ({ value: v }))));
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status,
      correspondent_slug, reference_numbers, source_folder, visibility, group_id)
    VALUES (${opts.userId ?? OWNER_ID}, ${sha}, ${`dos-${seq}.pdf`}, 'application/pdf', 1, ${`/tmp/dos-${seq}.pdf`}, 'ready',
      ${opts.correspondent ?? null}, ${refs}::jsonb, ${opts.folder ?? null}, ${opts.visibility ?? "private"}, ${opts.groupId ?? null})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function insertDossier(opts: {
  rule: Record<string, unknown>; userId?: number; visibility?: "private" | "group"; groupId?: number | null; kind?: string;
}): Promise<number> {
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO document_collections (user_id, title, visibility, group_id, kind, rule)
    VALUES (${opts.userId ?? OWNER_ID}, 'Akte', ${opts.visibility ?? "private"}, ${opts.groupId ?? null}, ${opts.kind ?? "dossier"}, ${JSON.stringify(opts.rule)}::jsonb)
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function membersOf(collectionId: number): Promise<Array<{ document_id: number; joined_by: string }>> {
  const r = await db.execute<{ document_id: number; joined_by: string }>(
    sql`SELECT document_id, joined_by FROM document_collection_items WHERE collection_id = ${collectionId} ORDER BY position`,
  );
  return r.rows;
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${OWNER_ID}, ${MEMBER_ID})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${MEMBER_ID})`);
}

describe("dossier rules against the database", () => {
  beforeEach(async () => {
    await ensureUser(OWNER_ID);
    await ensureUser(MEMBER_ID);
    await ensureGroup();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM group_members WHERE group_id = ${GROUP_ID}`);
    await db.execute(sql`DELETE FROM groups WHERE id = ${GROUP_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${MEMBER_ID})`);
  });

  it("joins a matching document to the dossiers in its scope and leaves others alone", async () => {
    const mine = await insertDossier({ rule: { correspondent_slug: "beispiel-ag", reference_numbers: ["AB123456"] } });
    const other = await insertDossier({ rule: { correspondent_slug: "andere-ag" } });
    const manual = await insertDossier({ rule: { correspondent_slug: "beispiel-ag" }, kind: "manual" });
    const strangers = await insertDossier({ rule: { correspondent_slug: "beispiel-ag" }, userId: MEMBER_ID });

    const doc = await insertDoc({ correspondent: "beispiel-ag", refs: ["AB 123456"] });
    const res = await applyDossierRulesForDocument(doc);
    expect(res).toEqual({ added: 1, removed: 0 });
    expect(await membersOf(mine)).toEqual([{ document_id: doc, joined_by: "rule" }]);
    expect(await membersOf(other)).toEqual([]);
    expect(await membersOf(manual)).toEqual([]);
    expect(await membersOf(strangers)).toEqual([]);

    // Idempotent.
    expect(await applyDossierRulesForDocument(doc)).toEqual({ added: 0, removed: 0 });
  });

  it("withdraws only what the rule added, and respects exclusions", async () => {
    const dossier = await insertDossier({ rule: { correspondent_slug: "beispiel-ag" } });
    const byRule = await insertDoc({ correspondent: "beispiel-ag" });
    const byHand = await insertDoc({ correspondent: "beispiel-ag" });
    await applyDossierRulesForDocument(byRule);
    await db.execute(sql`
      INSERT INTO document_collection_items (collection_id, document_id, position, joined_by)
      VALUES (${dossier}, ${byHand}, 5, 'user')
    `);

    // Both stop matching: the rule's own member goes, the hand-placed one stays.
    await db.execute(sql`UPDATE documents SET correspondent_slug = 'andere-ag' WHERE id IN (${byRule}, ${byHand})`);
    expect(await applyDossierRulesForDocument(byRule)).toEqual({ added: 0, removed: 1 });
    expect(await applyDossierRulesForDocument(byHand)).toEqual({ added: 0, removed: 0 });
    expect((await membersOf(dossier)).map((m) => m.document_id)).toEqual([byHand]);

    // An excluded document is not re-added even when it matches.
    const excluded = await insertDoc({ correspondent: "beispiel-ag" });
    await db.execute(sql`
      UPDATE document_collections
      SET rule = rule || ${JSON.stringify({ excluded_document_ids: [excluded] })}::jsonb
      WHERE id = ${dossier}
    `);
    expect(await applyDossierRulesForDocument(excluded)).toEqual({ added: 0, removed: 0 });
  });

  it("applies a rule over the corpus within the collection's scope", async () => {
    const a = await insertDoc({ correspondent: "beispiel-ag", folder: "Versicherungen/Hausrat" });
    const terms = await insertDoc({ correspondent: null, folder: "Versicherungen/Hausrat/Bedingungen" });
    await insertDoc({ correspondent: "beispiel-ag", folder: "Posteingang" });
    const shared = await insertDoc({ userId: MEMBER_ID, correspondent: "beispiel-ag", visibility: "group", groupId: GROUP_ID });
    const stale = await insertDoc({ correspondent: "andere-ag" });

    const row = await db.execute<any>(sql`
      INSERT INTO document_collections (user_id, title, visibility, kind, rule)
      VALUES (${OWNER_ID}, 'Hausrat', 'private', 'dossier',
        ${JSON.stringify({ correspondent_slug: "beispiel-ag", reference_numbers: ["ZZ0000"], source_folder_prefix: "Versicherungen/Hausrat" })}::jsonb)
      RETURNING *
    `);
    const dossier = row.rows[0]!;
    await db.execute(sql`
      INSERT INTO document_collection_items (collection_id, document_id, position, joined_by)
      VALUES (${dossier.id}, ${stale}, 0, 'rule')
    `);

    const res = await applyRuleToCorpus(dossier);
    // `a` and `terms` enter through the folder; the Posteingang letter lacks
    // the number; the group document is outside a private dossier's scope.
    expect(res).toEqual({ added: 2, removed: 1 });
    expect((await membersOf(dossier.id)).map((m) => m.document_id).sort()).toEqual([a, terms].sort());
    expect(shared).toBeGreaterThan(0);
  });
});
