/**
 * Per-user "Bezugspersonen" — name → relationship tag mappings.
 *
 * Two consumers:
 *   - `documents/documents.ts` exposes CRUD endpoints so the user
 *     can manage the list from the frontend.
 *   - `documents/document-ops.ts` (`runClassify`) loads the list for
 *     the owning user and passes it through `llm-client.ts` so the
 *     classifier emits the matching relation_tag in `tags` whenever
 *     the OCR text mentions the configured name.
 *
 * Storage in `user_subject_persons` (migration 0091). Uniqueness on
 * (user_id, lower(full_name)) prevents duplicates per user but still
 * lets two users independently list the same name.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { documentSubjectPersonRemovals, userSubjectPersons } from "../db/schema";

export interface SubjectPerson {
  id: number;
  full_name: string;
  relation_tag: string;
  requires_tax_review: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Detect Postgres unique-violation regardless of whether drizzle wraps
 * the original `pg` error in its own `DrizzleQueryError` (which moves
 * the SQLSTATE code onto `err.cause`).
 */
function isUniqueViolation(err: unknown): boolean {
  const codes: Array<string | undefined> = [
    (err as any)?.code,
    (err as any)?.cause?.code,
  ];
  return codes.includes("23505");
}

/** Trim and basic-validate a free-form text input. */
function requireNonEmpty(field: string, value: string, maxLen = 120): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw APIError.invalidArgument(`${field} must not be empty`);
  }
  if (trimmed.length > maxLen) {
    throw APIError.invalidArgument(`${field} must be at most ${maxLen} characters`);
  }
  return trimmed;
}

/**
 * Normalise a relation tag to the form used in `document_tags`:
 * lowercase, trimmed, whitespace collapsed to single `-`. Keeps the
 * frontend forgiving (user types "Mutter", we store "mutter") and
 * matches the convention `replaceTagLinks` uses for AI-suggested tags.
 */
export function normaliseRelationTag(raw: string): string {
  return raw
    .toLowerCase()
    // Drop everything that's not a usable character first so a
    // disallowed character between two words ("Mütter & Söhne")
    // doesn't survive as a double-hyphen after collapsing.
    .replace(/[^a-z0-9äöüß\s_-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function listSubjectPersons(userId: number): Promise<SubjectPerson[]> {
  const rows = await dbAll<SubjectPerson>(
    db
      .select({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        requires_tax_review: userSubjectPersons.requires_tax_review,
        created_at: userSubjectPersons.created_at,
        updated_at: userSubjectPersons.updated_at,
      })
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
  return rows;
}

export async function createSubjectPerson(
  userId: number,
  input: { full_name: string; relation_tag: string; requires_tax_review?: boolean },
): Promise<SubjectPerson> {
  const full_name = requireNonEmpty("full_name", input.full_name);
  const relation_tag = normaliseRelationTag(input.relation_tag);
  if (relation_tag.length === 0) {
    throw APIError.invalidArgument("relation_tag must contain at least one usable character");
  }

  try {
    const [row] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: userId,
        full_name,
        relation_tag,
        requires_tax_review: input.requires_tax_review ?? false,
      })
      .returning({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        requires_tax_review: userSubjectPersons.requires_tax_review,
        created_at: userSubjectPersons.created_at,
        updated_at: userSubjectPersons.updated_at,
      });
    return row;
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      throw APIError.alreadyExists(`a subject person with this name already exists`);
    }
    throw err;
  }
}

export async function updateSubjectPerson(
  userId: number,
  id: number,
  input: { full_name?: string; relation_tag?: string; requires_tax_review?: boolean },
): Promise<SubjectPerson> {
  const patch: {
    full_name?: string;
    relation_tag?: string;
    requires_tax_review?: boolean;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };
  if (input.full_name !== undefined) {
    patch.full_name = requireNonEmpty("full_name", input.full_name);
  }
  if (input.relation_tag !== undefined) {
    const tag = normaliseRelationTag(input.relation_tag);
    if (tag.length === 0) {
      throw APIError.invalidArgument("relation_tag must contain at least one usable character");
    }
    patch.relation_tag = tag;
  }
  if (input.requires_tax_review !== undefined) {
    patch.requires_tax_review = input.requires_tax_review;
  }

  try {
    const [row] = await db
      .update(userSubjectPersons)
      .set(patch)
      .where(and(eq(userSubjectPersons.id, id), eq(userSubjectPersons.user_id, userId)))
      .returning({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        requires_tax_review: userSubjectPersons.requires_tax_review,
        created_at: userSubjectPersons.created_at,
        updated_at: userSubjectPersons.updated_at,
      });
    if (!row) throw APIError.notFound("subject person not found");
    return row;
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      throw APIError.alreadyExists(`a subject person with this name already exists`);
    }
    throw err;
  }
}

export async function deleteSubjectPerson(userId: number, id: number): Promise<void> {
  const deleted = await dbFirst<{ id: number }>(
    db
      .delete(userSubjectPersons)
      .where(and(eq(userSubjectPersons.id, id), eq(userSubjectPersons.user_id, userId)))
      .returning({ id: userSubjectPersons.id }),
  );
  if (!deleted) throw APIError.notFound("subject person not found");
}

/**
 * Shape sent to the LLM service. Trimmed down to the fields the
 * classifier needs — no id, no timestamps. Returns an empty array
 * when the user has no entries; the prompt then omits the section
 * entirely so we don't waste tokens on an empty list.
 */
export interface SubjectPersonHint {
  full_name: string;
  relation_tag: string;
}

/** Id + name of the user's Bezugspersonen, for deterministic in-text matching
 *  at classify time (see metadata-extract.detectSubjectPersonIds). */
export interface SubjectPersonMatch {
  id: number;
  full_name: string;
  relation_tag: string;
  requires_tax_review: boolean;
}

export async function loadSubjectPersonsForMatch(userId: number): Promise<SubjectPersonMatch[]> {
  return dbAll<SubjectPersonMatch>(
    db
      .select({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        requires_tax_review: userSubjectPersons.requires_tax_review,
      })
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
}

/**
 * Subject persons the user explicitly removed from this document (migration
 * 0138). runClassify filters both the deterministic in-text detection and the
 * learned sender-memory merge against this set, so a manual removal is not
 * silently undone by the next re-classify.
 */
export async function loadRemovedSubjectPersonIds(documentId: number): Promise<Set<number>> {
  const rows = await dbAll<{ subject_person_id: number }>(
    db
      .select({ subject_person_id: documentSubjectPersonRemovals.subject_person_id })
      .from(documentSubjectPersonRemovals)
      .where(eq(documentSubjectPersonRemovals.document_id, documentId)),
  );
  return new Set(rows.map((r) => r.subject_person_id));
}

export async function loadSubjectPersonHints(userId: number): Promise<SubjectPersonHint[]> {
  const rows = await dbAll<SubjectPersonHint>(
    db
      .select({
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
      })
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
  return rows;
}
