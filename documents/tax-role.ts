/**
 * Resolve a document's role for the income-tax return
 * (documentation/plans/steuer-belegrolle.md, stage 1).
 *
 * The classifier names a role (`beleg` / `bezug` / `keine`); whether a
 * `beleg` may stand is decided here, deterministically, from the document
 * type (Dokumentart facet) and the evidence matrix `TAX_EVIDENCE` in
 * tax-sections.ts, plus the household facts a model cannot know (a child's
 * age). The resolver only ever downgrades (`beleg` → `bezug`): an unknown
 * document type leaves the model's answer alone, and a wrong type can cost
 * a document its evidence status but never invent one. The high-precision
 * text rules in tax-rules.ts run after this and may force `beleg`.
 *
 * Pure functions — unit-tested in tax-role.test.ts.
 */

import type { TaxAssignment } from "./llm-client";
import { isValidDocumentTypeSlug, type DocumentTypeSlug } from "./document-types";
import {
  TAX_EVIDENCE,
  isValidTaxSectionSlug,
  type TaxEvidenceCondition,
  type TaxRole,
  type TaxSectionSlug,
} from "./tax-sections";

/** Household facts that decide a conditional matrix entry. */
export interface TaxHouseholdFacts {
  /**
   * A matched Bezugsperson is a child aged 18 or more in the document's tax
   * year (§ 32 Abs. 4 EStG). Only then is a school/study/training
   * certificate evidence for Anlage Kind.
   */
  adultChild: boolean;
}

export const NO_HOUSEHOLD_FACTS: TaxHouseholdFacts = { adultChild: false };

export interface ResolveTaxRoleInput {
  /** The role the classifier named (already validated). */
  role: TaxRole;
  taxSections: readonly TaxAssignment[];
  /** Dokumentart facet slug, or null when unknown. */
  documentType: string | null;
  facts?: TaxHouseholdFacts;
}

export interface ResolvedTaxRole {
  role: TaxRole;
  taxSections: TaxAssignment[];
  /** True when the matrix turned a `beleg` into a `bezug`. */
  downgraded: boolean;
}

function conditionHolds(condition: TaxEvidenceCondition, facts: TaxHouseholdFacts): boolean {
  switch (condition) {
    case "adult_child":
      return facts.adultChild;
  }
}

/**
 * Whether `documentType` can be evidence for `section` under `facts`.
 */
export function isEvidenceFor(
  section: TaxSectionSlug,
  documentType: DocumentTypeSlug,
  facts: TaxHouseholdFacts = NO_HOUSEHOLD_FACTS,
): boolean {
  for (const entry of TAX_EVIDENCE[section]) {
    if (typeof entry === "string") {
      if (entry === documentType) return true;
    } else if (entry.type === documentType && conditionHolds(entry.when, facts)) {
      return true;
    }
  }
  return false;
}

/**
 * Apply the invariants and the evidence matrix:
 *
 * - no sections → `keine`;
 * - sections but role `keine` → `bezug` (the sections say there is a tax
 *   relation; the model just did not call it evidence);
 * - role `beleg` with a known document type that is evidence for none of
 *   the assigned sections → `bezug`;
 * - everything else passes through.
 */
export function resolveTaxRole(input: ResolveTaxRoleInput): ResolvedTaxRole {
  const facts = input.facts ?? NO_HOUSEHOLD_FACTS;
  const taxSections = input.taxSections.filter((s) => isValidTaxSectionSlug(s.slug));
  if (taxSections.length === 0) {
    return { role: "keine", taxSections: [], downgraded: false };
  }
  if (input.role === "keine") {
    return { role: "bezug", taxSections, downgraded: false };
  }
  if (input.role === "bezug") {
    return { role: "bezug", taxSections, downgraded: false };
  }
  const type = input.documentType?.trim().toLowerCase() ?? "";
  if (!isValidDocumentTypeSlug(type)) {
    return { role: "beleg", taxSections, downgraded: false };
  }
  const evidence = taxSections.some((s) => isEvidenceFor(s.slug as TaxSectionSlug, type, facts));
  return evidence
    ? { role: "beleg", taxSections, downgraded: false }
    : { role: "bezug", taxSections, downgraded: true };
}

/**
 * Role for data that only carries the old boolean (an older llm-service, the
 * pre-0261 API shape): the evidence when relevant, a `bezug` when sections
 * exist without relevance, otherwise nothing.
 */
export function roleFromLegacy(taxRelevant: boolean, taxSections: readonly unknown[]): TaxRole {
  if (taxRelevant) return "beleg";
  return taxSections.length > 0 ? "bezug" : "keine";
}

/** The slice of a Bezugsperson the household facts are read from. */
export interface TaxFactPerson {
  relation_kind: string;
  /** "YYYY-MM-DD" or null when unknown. */
  birth_date: string | null;
}

/** Age in years a child reaches in the tax year to count as an adult for
 *  Anlage Kind evidence (the Finanzamt asks for a school/training certificate
 *  from 18 on, § 32 Abs. 4 EStG). Year-granular like the review heuristic. */
export const ADULT_CHILD_AGE_YEARS = 18;

/**
 * Household facts for the matrix, read off the Bezugspersonen matched in the
 * document. The reference year is the document's tax year; without one the
 * current year, like the review derivation in document-ops.ts.
 */
export function householdTaxFacts(
  matchedPersons: readonly TaxFactPerson[],
  taxYear: number | null,
  now: Date = new Date(),
): TaxHouseholdFacts {
  const referenceYear = taxYear ?? now.getFullYear();
  const adultChild = matchedPersons.some((p) => {
    if (p.relation_kind !== "child" || !p.birth_date) return false;
    const birthYear = Number(p.birth_date.slice(0, 4));
    return Number.isInteger(birthYear) && referenceYear - birthYear >= ADULT_CHILD_AGE_YEARS;
  });
  return { adultChild };
}
