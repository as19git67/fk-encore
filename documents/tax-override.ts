/**
 * Validation of a manual tax override, shared by `POST /documents/:id/tax`
 * (documents.ts) and the batch endpoint (batch-ops.ts).
 */

import { APIError } from "encore.dev/api";
import { isTaxRole, isValidTaxSectionSlug, type TaxRole } from "./tax-sections";

export interface TaxOverrideInput {
  tax_relevant?: boolean;
  tax_role?: TaxRole;
  tax_year?: number | null;
  tax_sections?: string[];
}

/**
 * Validate a manual tax override (single document and batch alike) and
 * resolve the role: `tax_role` when given, else the old boolean (`true` =
 * beleg, `false` = keine). A `beleg` needs a year and at least one section;
 * a `bezug` needs at least one section and may carry a year; `keine` wipes
 * both.
 */
export function validateTaxOverride(req: TaxOverrideInput): {
  role: TaxRole;
  year: number | null;
  slugs: string[];
} {
  const role: TaxRole = req.tax_role ?? (req.tax_relevant ? "beleg" : "keine");
  if (!isTaxRole(role)) {
    throw APIError.invalidArgument(`unknown tax_role: ${String(req.tax_role)}`);
  }

  let year: number | null = null;
  if (role !== "keine" && req.tax_year !== undefined && req.tax_year !== null) {
    if (!Number.isInteger(req.tax_year) || req.tax_year < 2000 || req.tax_year > 2100) {
      throw APIError.invalidArgument("tax_year must be an integer between 2000 and 2100");
    }
    year = req.tax_year;
  }
  if (role === "beleg" && year === null) {
    throw APIError.invalidArgument("tax_year is required when tax_role=beleg");
  }

  const slugs = role === "keine" ? [] : (req.tax_sections ?? []).map((s) => s.trim().toLowerCase());
  if (role !== "keine" && slugs.length === 0) {
    throw APIError.invalidArgument(`tax_sections must not be empty when tax_role=${role}`);
  }
  for (const s of slugs) {
    if (!isValidTaxSectionSlug(s)) {
      throw APIError.invalidArgument(`unknown tax section slug: ${s}`);
    }
  }
  return { role, year, slugs: [...new Set(slugs)] };
}
