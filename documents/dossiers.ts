/**
 * Dossiers (#1480): a Sammelmappe with a membership rule.
 *
 * A Sammelmappe is what a person gathers by hand to hand over. A dossier is
 * the long-lived file for one contract or one case — "Hausrat at insurer Y"
 * — and what belongs in it can be said once, as a rule, instead of being
 * remembered at every letter. Rather than a second folder-like thing, the
 * dossier *is* a collection (`kind = 'dossier'`) with a `rule`: list, detail
 * page, summary job and PDF export already exist.
 *
 * The rule has three parts, each optional:
 *   - `correspondent_slug`: the canonical sender (documents/correspondent.ts),
 *   - `reference_numbers`: normalised numbers (documents/reference-numbers.ts),
 *   - `source_folder_prefix`: an origin folder and everything below it (#1477).
 *
 * A document matches when its origin folder lies under the prefix, OR when it
 * satisfies every one of the *other* parts that are set (correspondent and
 * numbers both, when both are given). The folder is an alternative way in on
 * purpose: terms and conditions carry no number and often no clear sender,
 * but they sat next to the policy in the folder.
 *
 * What the rule added it can take away again (`joined_by = 'rule'`), and
 * nothing else: a document a person put in stays, and a document a person
 * took out is remembered in `excluded_document_ids` so the next run does not
 * put it back. Membership never widens access: a group dossier takes only
 * documents shared with that group, a private one only its owner's.
 */

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { documentCollectionItems, documentCollections, documents } from "../db/schema";
import { normalizeReference, type DocumentReferenceNumber } from "./reference-numbers";
import { normalizeSourceFolder } from "./source-folder";
import { assertGroupMember } from "./visibility";

console.log("[boot] documents/dossiers.ts: all imports resolved");

export type CollectionKind = "manual" | "dossier";

export interface CollectionRule {
  correspondent_slug?: string | null;
  /** Normalised (letters and digits, upper-cased). */
  reference_numbers?: string[];
  source_folder_prefix?: string | null;
  /** Documents a person took out of this dossier; the rule leaves them alone. */
  excluded_document_ids?: number[];
}

export interface RuleInput {
  correspondent_slug?: string | null;
  /** As typed; normalised here. */
  reference_numbers?: string[] | null;
  source_folder_prefix?: string | null;
}

/** Bring a rule into stored shape; `null` when nothing is left to match on. */
export function normalizeRule(
  input: RuleInput | null | undefined,
  keep: Pick<CollectionRule, "excluded_document_ids"> = {},
): CollectionRule | null {
  if (!input) return null;
  const correspondent = (input.correspondent_slug ?? "").trim().toLowerCase() || null;
  const refs = [...new Set(
    (input.reference_numbers ?? [])
      .map((r) => normalizeReference(r ?? ""))
      .filter((r) => r.length >= 3),
  )];
  const folder = normalizeSourceFolder(input.source_folder_prefix);
  if (!correspondent && refs.length === 0 && !folder) return null;
  const rule: CollectionRule = {};
  if (correspondent) rule.correspondent_slug = correspondent;
  if (refs.length > 0) rule.reference_numbers = refs;
  if (folder) rule.source_folder_prefix = folder;
  if (keep.excluded_document_ids?.length) rule.excluded_document_ids = [...keep.excluded_document_ids];
  return rule;
}

export interface RuleSubject {
  id: number;
  correspondent_slug: string | null;
  reference_numbers: DocumentReferenceNumber[] | null;
  source_folder: string | null;
}

/** Does this document belong, by the rule's words alone (no visibility here)? */
export function ruleMatchesDocument(rule: CollectionRule, doc: RuleSubject): boolean {
  if (rule.excluded_document_ids?.includes(doc.id)) return false;
  if (rule.source_folder_prefix && doc.source_folder) {
    const p = rule.source_folder_prefix;
    if (doc.source_folder === p || doc.source_folder.startsWith(`${p}/`)) return true;
  }
  const wantsCorrespondent = !!rule.correspondent_slug;
  const wantsRefs = (rule.reference_numbers?.length ?? 0) > 0;
  if (!wantsCorrespondent && !wantsRefs) return false;
  if (wantsCorrespondent && doc.correspondent_slug !== rule.correspondent_slug) return false;
  if (wantsRefs) {
    const have = new Set((doc.reference_numbers ?? []).map((r) => r.normalized));
    if (!rule.reference_numbers!.some((n) => have.has(n))) return false;
  }
  return true;
}

type CollectionRow = typeof documentCollections.$inferSelect;

/** The document's own scope, as the WHERE a dossier must satisfy to take it. */
function dossiersInScopeOf(doc: { user_id: number; visibility: string; group_id: number | null }) {
  const scope =
    doc.visibility === "group" && doc.group_id != null
      ? and(eq(documentCollections.visibility, "group"), eq(documentCollections.group_id, doc.group_id))!
      : and(eq(documentCollections.visibility, "private"), eq(documentCollections.user_id, doc.user_id))!;
  return and(eq(documentCollections.kind, "dossier"), isNotNull(documentCollections.rule), scope)!;
}

async function touch(collectionId: number): Promise<void> {
  await dbExec(
    db
      .update(documentCollections)
      .set({ summary_stale: true, updated_at: sql`now()` })
      .where(eq(documentCollections.id, collectionId)),
  );
}

async function nextPosition(collectionId: number): Promise<number> {
  const row = await dbFirst<{ next: number }>(
    db
      .select({ next: sql<number>`coalesce(max(${documentCollectionItems.position}), -1) + 1` })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, collectionId)),
  );
  return row?.next ?? 0;
}

export interface ApplyResult {
  added: number;
  removed: number;
}

/**
 * One document against every dossier in its scope: join where the rule says
 * so, leave where the rule once put it but no longer says so. Runs after
 * classification and after an edit of the document's attributes.
 */
export async function applyDossierRulesForDocument(documentId: number): Promise<ApplyResult> {
  const doc = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.id, documentId)),
  );
  if (!doc) return { added: 0, removed: 0 };
  const dossiers = await dbAll<CollectionRow>(
    db.select().from(documentCollections).where(dossiersInScopeOf(doc)),
  );
  if (dossiers.length === 0) return { added: 0, removed: 0 };

  const memberships = await dbAll<{ collection_id: number; joined_by: string }>(
    db
      .select({ collection_id: documentCollectionItems.collection_id, joined_by: documentCollectionItems.joined_by })
      .from(documentCollectionItems)
      .where(
        and(
          eq(documentCollectionItems.document_id, documentId),
          inArray(documentCollectionItems.collection_id, dossiers.map((d) => d.id)),
        ),
      ),
  );
  const member = new Map(memberships.map((m) => [m.collection_id, m.joined_by]));

  let added = 0;
  let removed = 0;
  for (const dossier of dossiers) {
    const rule = dossier.rule as CollectionRule | null;
    if (!rule) continue;
    const matches = ruleMatchesDocument(rule, doc);
    const joinedBy = member.get(dossier.id);
    if (matches && joinedBy === undefined) {
      await dbExec(
        db.insert(documentCollectionItems).values({
          collection_id: dossier.id,
          document_id: documentId,
          position: await nextPosition(dossier.id),
          joined_by: "rule",
        }),
      );
      await touch(dossier.id);
      added += 1;
    } else if (!matches && joinedBy === "rule") {
      await dbExec(
        db
          .delete(documentCollectionItems)
          .where(
            and(
              eq(documentCollectionItems.collection_id, dossier.id),
              eq(documentCollectionItems.document_id, documentId),
            ),
          ),
      );
      await touch(dossier.id);
      removed += 1;
    }
  }
  return { added, removed };
}

/** Best-effort hook for the pipeline: never throws. */
export async function applyDossierRulesQuietly(documentId: number): Promise<void> {
  try {
    const r = await applyDossierRulesForDocument(documentId);
    if (r.added || r.removed) {
      console.log(`[documents.dossiers] document ${documentId}: +${r.added} / -${r.removed} dossier membership(s)`);
    }
  } catch (err: any) {
    console.warn(`[documents.dossiers] rules for ${documentId} failed: ${err?.message ?? err}`);
  }
}

/**
 * One dossier against every document in its scope. Adds what matches and is
 * not in, removes what the rule put in and no longer matches; hand-placed
 * members and excluded documents are untouched.
 */
export async function applyRuleToCorpus(collection: CollectionRow): Promise<ApplyResult> {
  const rule = collection.rule as CollectionRule | null;
  if (collection.kind !== "dossier" || !rule) return { added: 0, removed: 0 };

  const scope =
    collection.visibility === "group" && collection.group_id != null
      ? and(eq(documents.visibility, "group"), eq(documents.group_id, collection.group_id))!
      : and(eq(documents.visibility, "private"), eq(documents.user_id, collection.user_id))!;
  const candidates = await dbAll<RuleSubject>(
    db
      .select({
        id: documents.id,
        correspondent_slug: documents.correspondent_slug,
        reference_numbers: documents.reference_numbers,
        source_folder: documents.source_folder,
      })
      .from(documents)
      .where(scope)
      .orderBy(asc(documents.doc_date), asc(documents.id)),
  );
  const matching = new Set(candidates.filter((c) => ruleMatchesDocument(rule, c)).map((c) => c.id));

  const members = await dbAll<{ document_id: number; joined_by: string }>(
    db
      .select({ document_id: documentCollectionItems.document_id, joined_by: documentCollectionItems.joined_by })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, collection.id)),
  );
  const present = new Map(members.map((m) => [m.document_id, m.joined_by]));

  const toAdd = [...matching].filter((id) => !present.has(id));
  const toRemove = members.filter((m) => m.joined_by === "rule" && !matching.has(m.document_id)).map((m) => m.document_id);

  if (toRemove.length > 0) {
    await dbExec(
      db
        .delete(documentCollectionItems)
        .where(
          and(
            eq(documentCollectionItems.collection_id, collection.id),
            inArray(documentCollectionItems.document_id, toRemove),
          ),
        ),
    );
  }
  if (toAdd.length > 0) {
    let position = await nextPosition(collection.id);
    await dbExec(
      db.insert(documentCollectionItems).values(
        toAdd.map((documentId) => ({
          collection_id: collection.id,
          document_id: documentId,
          position: position++,
          joined_by: "rule" as const,
        })),
      ),
    );
  }
  if (toAdd.length > 0 || toRemove.length > 0) await touch(collection.id);
  return { added: toAdd.length, removed: toRemove.length };
}

/** `POST /document-collections/:id/apply-rule` — run the dossier's rule over the corpus now. */
export const applyCollectionRule = api(
  { expose: true, method: "POST", path: "/document-collections/:id/apply-rule", auth: true },
  async ({ id }: { id: number }): Promise<ApplyResult> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.documents");
    requirePermission(authData, "documents.view");
    const userId = parseInt(authData.userID, 10);
    const isAdmin = authData.permissions.includes("data.manage");

    const row = await dbFirst<CollectionRow>(
      db.select().from(documentCollections).where(eq(documentCollections.id, id)),
    );
    if (!row) throw APIError.notFound("collection not found");
    if (!isAdmin) {
      // Same rule as editing the collection: the owner, or a member of its group.
      if (row.visibility === "private" && row.user_id !== userId) throw APIError.notFound("collection not found");
      if (row.visibility === "group") await assertGroupMember(userId, row.group_id!);
    }
    if (row.kind !== "dossier" || !row.rule) {
      throw APIError.failedPrecondition("this collection has no rule");
    }
    return applyRuleToCorpus(row);
  },
);
