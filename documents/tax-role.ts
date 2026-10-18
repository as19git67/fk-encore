/**
 * Resolve a document's role for the income-tax return
 * (documentation/plans/steuer-belegrolle.md, stage 1).
 *
 * The classifier names a role (`beleg` / `bezug` / `keine`); whether a
 * `beleg` may stand is decided here, deterministically, from the document
 * type (Dokumentart facet) and the evidence matrix `TAX_EVIDENCE` in
 * tax-sections.ts. The resolver only ever downgrades (`beleg` → `bezug`): an unknown
 * document type leaves the model's answer alone, and a wrong type can cost
 * a document its evidence status but never invent one. The high-precision
 * text rules in tax-rules.ts run after this and may force `beleg`.
 *
 * Pure functions — unit-tested in tax-role.test.ts.
 */

import type { TaxAssignment } from "./llm-client";
import { isValidDocumentTypeSlug, type DocumentTypeSlug } from "./document-types";
import { TAX_EVIDENCE, isValidTaxSectionSlug, type TaxRole, type TaxSectionSlug } from "./tax-sections";

export interface ResolveTaxRoleInput {
  /** The role the classifier named (already validated). */
  role: TaxRole;
  taxSections: readonly TaxAssignment[];
  /** Dokumentart facet slug, or null when unknown. */
  documentType: string | null;
}

export interface ResolvedTaxRole {
  role: TaxRole;
  taxSections: TaxAssignment[];
  /** True when the matrix turned a `beleg` into a `bezug`. */
  downgraded: boolean;
}

/** Whether `documentType` can be evidence for `section`. */
export function isEvidenceFor(section: TaxSectionSlug, documentType: DocumentTypeSlug): boolean {
  return TAX_EVIDENCE[section].includes(documentType);
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
  const evidence = taxSections.some((s) => isEvidenceFor(s.slug as TaxSectionSlug, type));
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
