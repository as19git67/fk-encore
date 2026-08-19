/**
 * Per-user "Bezugspersonen" — name → relationship tag mappings,
 * extended with typed family relations and derived tax-review defaults
 * (migration 0145, #991).
 *
 * Two consumers:
 *   - `documents/documents.ts` exposes CRUD endpoints so the user
 *     can manage the list from the frontend.
 *   - `documents/document-ops.ts` (`runClassify`) loads the list for
 *     the owning user and passes it through `llm-client.ts` so the
 *     classifier emits the matching relation_tag in `tags` whenever
 *     the OCR text mentions the configured name.
 *
 * Storage in `user_subject_persons` (migration 0091, extended 0145).
 * Uniqueness on (user_id, lower(full_name)) prevents duplicates per
 * user but still lets two users independently list the same name.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  documentSubjectPersonRemovals,
  userAssessmentSettings,
  userSubjectPersons,
} from "../db/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RelationKind = "self" | "spouse" | "child" | "parent" | "sibling" | "ward" | "other";
export type CostBearer = "user" | "person" | "unknown";
export type AssessmentType = "zusammen" | "einzeln" | "unknown";

export const RELATION_KINDS: readonly RelationKind[] = [
  "self", "spouse", "child", "parent", "sibling", "ward", "other",
];
export const COST_BEARERS: readonly CostBearer[] = ["user", "person", "unknown"];
export const ASSESSMENT_TYPES: readonly AssessmentType[] = ["zusammen", "einzeln", "unknown"];

export interface SubjectPerson {
  id: number;
  full_name: string;
  relation_tag: string;
  relation_kind: RelationKind;
  birth_date: string | null;
  in_household: boolean;
  tax_cost_bearer: CostBearer;
  requires_tax_review: boolean;
  requires_tax_review_override: boolean | null;
  // NULL = no own tax return. A year means: this person's tax documents with
  // tax_year >= this value belong to their own "Steuerakte", not the user's
  // review queue (migration 0146).
  own_tax_return_from_tax_year: number | null;
  created_at: string;
  updated_at: string;
}

export interface AssessmentSetting {
  id: number;
  assessment_type: AssessmentType;
  valid_from_tax_year: number | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  const codes: Array<string | undefined> = [
    (err as any)?.code,
    (err as any)?.cause?.code,
  ];
  return codes.includes("23505");
}

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

export function normaliseRelationTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s_-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function validateRelationKind(value: string): RelationKind {
  if (!(RELATION_KINDS as readonly string[]).includes(value)) {
    throw APIError.invalidArgument(`relation_kind must be one of: ${RELATION_KINDS.join(", ")}`);
  }
  return value as RelationKind;
}

function validateCostBearer(value: string): CostBearer {
  if (!(COST_BEARERS as readonly string[]).includes(value)) {
    throw APIError.invalidArgument(`tax_cost_bearer must be one of: ${COST_BEARERS.join(", ")}`);
  }
  return value as CostBearer;
}

function validateAssessmentType(value: string): AssessmentType {
  if (!(ASSESSMENT_TYPES as readonly string[]).includes(value)) {
    throw APIError.invalidArgument(`assessment_type must be one of: ${ASSESSMENT_TYPES.join(", ")}`);
  }
  return value as AssessmentType;
}

// Must match the tax_year bounds in llm-client.ts / llm-service.
const OWN_RETURN_YEAR_MIN = 1970;
const OWN_RETURN_YEAR_MAX = 2100;

function validateOwnTaxReturnYear(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < OWN_RETURN_YEAR_MIN || value > OWN_RETURN_YEAR_MAX) {
    throw APIError.invalidArgument(
      `own_tax_return_from_tax_year must be an integer between ${OWN_RETURN_YEAR_MIN} and ${OWN_RETURN_YEAR_MAX}`,
    );
  }
  return value;
}

// ─── Tax review derivation ──────────────────────────────────────────────────

// § 32 Abs. 4 EStG: children in education count until their 25th year.
// Deliberately a coarse year-granular heuristic — see deriveRequiresTaxReview.
export const CHILD_AGE_LIMIT_YEARS = 25;

function withinAgeLimit(birthDate: string, referenceYear?: number): boolean {
  const [y] = birthDate.split("-").map(Number);
  if (!y) return false;
  const year = referenceYear ?? new Date().getFullYear();
  return year - y < CHILD_AGE_LIMIT_YEARS;
}

export interface TaxReviewDerivationInput {
  relation_kind: RelationKind;
  in_household: boolean;
  tax_cost_bearer: CostBearer;
  birth_date: string | null;
  own_tax_return_from_tax_year?: number | null;
}

/**
 * True when this person files their own tax return for `taxYear` — their tax
 * documents from that year belong to their own "Steuerakte", not the user's
 * review queue. `taxYear=null` (document without a detected year) is treated
 * as "current year" by callers that need a decision.
 */
export function hasOwnTaxReturn(
  p: { own_tax_return_from_tax_year?: number | null },
  taxYear: number,
): boolean {
  const from = p.own_tax_return_from_tax_year;
  return from != null && taxYear >= from;
}

/**
 * Derive the default "requires tax review" for a person. `referenceYear` is
 * the tax year the decision is for — the age heuristic (§ 32 Abs. 4 EStG,
 * children count until their 25th year while in education) and the own-return
 * cutoff both depend on the year the document belongs to, not on "today".
 * Defaults to the current year for person-level decisions.
 */
export function deriveRequiresTaxReview(
  p: TaxReviewDerivationInput,
  settings: { assessment_type: AssessmentType },
  referenceYear?: number,
): boolean {
  const year = referenceYear ?? new Date().getFullYear();
  // A person filing their own return owns their tax documents from that year
  // on — they never need review for the *user's* return. Routing into the
  // person's Steuerakte happens separately (tax_return_person_id).
  if (hasOwnTaxReturn(p, year)) return false;
  if (p.tax_cost_bearer === "user") return false;
  switch (p.relation_kind) {
    case "self":
      return false;
    case "spouse":
      return settings.assessment_type !== "zusammen";
    case "child":
      return !(p.in_household && (p.birth_date === null || withinAgeLimit(p.birth_date, year)));
    default:
      return true;
  }
}

export function computeEffectiveRequiresTaxReview(
  p: TaxReviewDerivationInput & { requires_tax_review_override: boolean | null },
  settings: { assessment_type: AssessmentType },
  referenceYear?: number,
): boolean {
  // The own-return setting beats even a manual override: "files their own
  // return since year X" is the more specific, explicit statement — the
  // documents belong to the person's Steuerakte, not the user's queue.
  if (hasOwnTaxReturn(p, referenceYear ?? new Date().getFullYear())) return false;
  if (p.requires_tax_review_override !== null) return p.requires_tax_review_override;
  return deriveRequiresTaxReview(p, settings, referenceYear);
}

// ─── Assessment settings ────────────────────────────────────────────────────

const assessmentColumns = {
  id: userAssessmentSettings.id,
  assessment_type: userAssessmentSettings.assessment_type,
  valid_from_tax_year: userAssessmentSettings.valid_from_tax_year,
  created_at: userAssessmentSettings.created_at,
  updated_at: userAssessmentSettings.updated_at,
};

export async function listAssessmentSettings(userId: number): Promise<AssessmentSetting[]> {
  return dbAll<AssessmentSetting>(
    db
      .select(assessmentColumns)
      .from(userAssessmentSettings)
      .where(eq(userAssessmentSettings.user_id, userId))
      .orderBy(asc(userAssessmentSettings.valid_from_tax_year)),
  );
}

export async function getEffectiveAssessmentType(
  userId: number,
  taxYear?: number | null,
): Promise<AssessmentType> {
  if (taxYear != null) {
    const row = await dbFirst<{ assessment_type: AssessmentType }>(
      db
        .select({ assessment_type: userAssessmentSettings.assessment_type })
        .from(userAssessmentSettings)
        .where(
          and(
            eq(userAssessmentSettings.user_id, userId),
            sql`${userAssessmentSettings.valid_from_tax_year} <= ${taxYear}
                OR ${userAssessmentSettings.valid_from_tax_year} IS NULL`,
          ),
        )
        .orderBy(desc(userAssessmentSettings.valid_from_tax_year))
        .limit(1),
    );
    return row?.assessment_type ?? "unknown";
  }
  const row = await dbFirst<{ assessment_type: AssessmentType }>(
    db
      .select({ assessment_type: userAssessmentSettings.assessment_type })
      .from(userAssessmentSettings)
      .where(eq(userAssessmentSettings.user_id, userId))
      .orderBy(desc(userAssessmentSettings.valid_from_tax_year))
      .limit(1),
  );
  return row?.assessment_type ?? "unknown";
}

export async function upsertAssessmentSetting(
  userId: number,
  input: { assessment_type: string; valid_from_tax_year?: number | null },
): Promise<AssessmentSetting> {
  const assessment_type = validateAssessmentType(input.assessment_type);
  const validFrom = input.valid_from_tax_year ?? null;

  const existing = await dbFirst<{ id: number }>(
    db
      .select({ id: userAssessmentSettings.id })
      .from(userAssessmentSettings)
      .where(
        and(
          eq(userAssessmentSettings.user_id, userId),
          validFrom === null
            ? isNull(userAssessmentSettings.valid_from_tax_year)
            : eq(userAssessmentSettings.valid_from_tax_year, validFrom),
        ),
      ),
  );

  if (existing) {
    const [row] = await db
      .update(userAssessmentSettings)
      .set({ assessment_type, updated_at: new Date().toISOString() })
      .where(eq(userAssessmentSettings.id, existing.id))
      .returning(assessmentColumns);
    return row;
  }

  const [row] = await db
    .insert(userAssessmentSettings)
    .values({ user_id: userId, assessment_type, valid_from_tax_year: validFrom })
    .returning(assessmentColumns);
  return row;
}

export async function deleteAssessmentSetting(userId: number, id: number): Promise<void> {
  const deleted = await dbFirst<{ id: number }>(
    db
      .delete(userAssessmentSettings)
      .where(and(eq(userAssessmentSettings.id, id), eq(userAssessmentSettings.user_id, userId)))
      .returning({ id: userAssessmentSettings.id }),
  );
  if (!deleted) throw APIError.notFound("assessment setting not found");
}

// ─── Subject person columns (shared across queries) ─────────────────────────

const subjectPersonColumns = {
  id: userSubjectPersons.id,
  full_name: userSubjectPersons.full_name,
  relation_tag: userSubjectPersons.relation_tag,
  relation_kind: userSubjectPersons.relation_kind,
  birth_date: userSubjectPersons.birth_date,
  in_household: userSubjectPersons.in_household,
  tax_cost_bearer: userSubjectPersons.tax_cost_bearer,
  requires_tax_review: userSubjectPersons.requires_tax_review,
  requires_tax_review_override: userSubjectPersons.requires_tax_review_override,
  own_tax_return_from_tax_year: userSubjectPersons.own_tax_return_from_tax_year,
  created_at: userSubjectPersons.created_at,
  updated_at: userSubjectPersons.updated_at,
};

// ─── Subject person CRUD ────────────────────────────────────────────────────

export async function listSubjectPersons(userId: number): Promise<SubjectPerson[]> {
  return dbAll<SubjectPerson>(
    db
      .select(subjectPersonColumns)
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
}

export async function createSubjectPerson(
  userId: number,
  input: {
    full_name: string;
    relation_tag: string;
    relation_kind?: string;
    birth_date?: string | null;
    in_household?: boolean;
    tax_cost_bearer?: string;
    requires_tax_review?: boolean;
    requires_tax_review_override?: boolean | null;
    own_tax_return_from_tax_year?: number | null;
  },
): Promise<SubjectPerson> {
  const full_name = requireNonEmpty("full_name", input.full_name);
  const relation_tag = normaliseRelationTag(input.relation_tag);
  if (relation_tag.length === 0) {
    throw APIError.invalidArgument("relation_tag must contain at least one usable character");
  }
  const relation_kind = input.relation_kind ? validateRelationKind(input.relation_kind) : "other";
  const tax_cost_bearer = input.tax_cost_bearer ? validateCostBearer(input.tax_cost_bearer) : "unknown";
  const ownReturnYear = validateOwnTaxReturnYear(input.own_tax_return_from_tax_year ?? null);

  const assessmentType = await getEffectiveAssessmentType(userId);
  const override = input.requires_tax_review_override !== undefined
    ? input.requires_tax_review_override
    : (input.requires_tax_review !== undefined ? input.requires_tax_review : null);
  const effective = computeEffectiveRequiresTaxReview(
    { relation_kind, in_household: input.in_household ?? false, tax_cost_bearer, birth_date: input.birth_date ?? null, own_tax_return_from_tax_year: ownReturnYear, requires_tax_review_override: override },
    { assessment_type: assessmentType },
  );

  try {
    const [row] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: userId,
        full_name,
        relation_tag,
        relation_kind,
        birth_date: input.birth_date ?? null,
        in_household: input.in_household ?? false,
        tax_cost_bearer,
        requires_tax_review: effective,
        requires_tax_review_override: override,
        own_tax_return_from_tax_year: ownReturnYear,
      })
      .returning(subjectPersonColumns);
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
  input: {
    full_name?: string;
    relation_tag?: string;
    relation_kind?: string;
    birth_date?: string | null;
    in_household?: boolean;
    tax_cost_bearer?: string;
    requires_tax_review?: boolean;
    requires_tax_review_override?: boolean | null;
    own_tax_return_from_tax_year?: number | null;
  },
): Promise<{ person: SubjectPerson; effectiveChanged: boolean; ownReturnChanged: boolean }> {
  const existing = await dbFirst<SubjectPerson>(
    db.select(subjectPersonColumns).from(userSubjectPersons)
      .where(and(eq(userSubjectPersons.id, id), eq(userSubjectPersons.user_id, userId))),
  );
  if (!existing) throw APIError.notFound("subject person not found");

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.full_name !== undefined) {
    patch.full_name = requireNonEmpty("full_name", input.full_name);
  }
  if (input.relation_tag !== undefined) {
    const tag = normaliseRelationTag(input.relation_tag);
    if (tag.length === 0) throw APIError.invalidArgument("relation_tag must contain at least one usable character");
    patch.relation_tag = tag;
  }
  if (input.relation_kind !== undefined) {
    patch.relation_kind = validateRelationKind(input.relation_kind);
  }
  if (input.birth_date !== undefined) {
    patch.birth_date = input.birth_date;
  }
  if (input.in_household !== undefined) {
    patch.in_household = input.in_household;
  }
  if (input.tax_cost_bearer !== undefined) {
    patch.tax_cost_bearer = validateCostBearer(input.tax_cost_bearer);
  }

  if (input.requires_tax_review_override !== undefined) {
    patch.requires_tax_review_override = input.requires_tax_review_override;
  } else if (input.requires_tax_review !== undefined) {
    patch.requires_tax_review_override = input.requires_tax_review;
  }
  if (input.own_tax_return_from_tax_year !== undefined) {
    patch.own_tax_return_from_tax_year = validateOwnTaxReturnYear(input.own_tax_return_from_tax_year);
  }

  const merged = {
    relation_kind: (patch.relation_kind ?? existing.relation_kind) as RelationKind,
    in_household: (patch.in_household ?? existing.in_household) as boolean,
    tax_cost_bearer: (patch.tax_cost_bearer ?? existing.tax_cost_bearer) as CostBearer,
    birth_date: (patch.birth_date !== undefined ? patch.birth_date : existing.birth_date) as string | null,
    requires_tax_review_override: (patch.requires_tax_review_override !== undefined
      ? patch.requires_tax_review_override
      : existing.requires_tax_review_override) as boolean | null,
    own_tax_return_from_tax_year: (patch.own_tax_return_from_tax_year !== undefined
      ? patch.own_tax_return_from_tax_year
      : existing.own_tax_return_from_tax_year) as number | null,
  };

  const assessmentType = await getEffectiveAssessmentType(userId);
  const newEffective = computeEffectiveRequiresTaxReview(merged, { assessment_type: assessmentType });
  patch.requires_tax_review = newEffective;
  const effectiveChanged = newEffective !== existing.requires_tax_review;
  const ownReturnChanged =
    merged.own_tax_return_from_tax_year !== existing.own_tax_return_from_tax_year;

  try {
    const [row] = await db
      .update(userSubjectPersons)
      .set(patch)
      .where(and(eq(userSubjectPersons.id, id), eq(userSubjectPersons.user_id, userId)))
      .returning(subjectPersonColumns);
    if (!row) throw APIError.notFound("subject person not found");
    return { person: row, effectiveChanged, ownReturnChanged };
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

// ─── Shapes for classifier / match ──────────────────────────────────────────

export interface SubjectPersonHint {
  full_name: string;
  relation_tag: string;
  relation_kind: RelationKind;
}

export interface SubjectPersonMatch {
  id: number;
  full_name: string;
  relation_tag: string;
  // Stored effective value (computed with the current year at person-edit
  // time). Per-document decisions should prefer
  // computeEffectiveRequiresTaxReview with the document's tax_year.
  requires_tax_review: boolean;
  relation_kind: RelationKind;
  birth_date: string | null;
  in_household: boolean;
  tax_cost_bearer: CostBearer;
  requires_tax_review_override: boolean | null;
  own_tax_return_from_tax_year: number | null;
}

export async function loadSubjectPersonsForMatch(userId: number): Promise<SubjectPersonMatch[]> {
  return dbAll<SubjectPersonMatch>(
    db
      .select({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        requires_tax_review: userSubjectPersons.requires_tax_review,
        relation_kind: userSubjectPersons.relation_kind,
        birth_date: userSubjectPersons.birth_date,
        in_household: userSubjectPersons.in_household,
        tax_cost_bearer: userSubjectPersons.tax_cost_bearer,
        requires_tax_review_override: userSubjectPersons.requires_tax_review_override,
        own_tax_return_from_tax_year: userSubjectPersons.own_tax_return_from_tax_year,
      })
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
}

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
  return dbAll<SubjectPersonHint>(
    db
      .select({
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        relation_kind: userSubjectPersons.relation_kind,
      })
      .from(userSubjectPersons)
      .where(eq(userSubjectPersons.user_id, userId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
}

/**
 * Recompute the derived requires_tax_review for all persons of a user
 * whose override is NULL. Called when assessment settings change.
 * Returns the ids and new effective values for persons whose value flipped.
 */
export async function recomputeDerivedTaxReviewForUser(
  userId: number,
): Promise<Array<{ id: number; newEffective: boolean }>> {
  const persons = await dbAll<SubjectPerson>(
    db
      .select(subjectPersonColumns)
      .from(userSubjectPersons)
      .where(
        and(eq(userSubjectPersons.user_id, userId), isNull(userSubjectPersons.requires_tax_review_override)),
      ),
  );

  const assessmentType = await getEffectiveAssessmentType(userId);
  const flipped: Array<{ id: number; newEffective: boolean }> = [];

  for (const p of persons) {
    const newEffective = deriveRequiresTaxReview(p, { assessment_type: assessmentType });
    if (newEffective !== p.requires_tax_review) {
      await db
        .update(userSubjectPersons)
        .set({ requires_tax_review: newEffective, updated_at: new Date().toISOString() })
        .where(eq(userSubjectPersons.id, p.id));
      flipped.push({ id: p.id, newEffective });
    }
  }

  return flipped;
}
