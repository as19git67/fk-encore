/**
 * DB-backed overrides for the per-section `hint` strings sent to the
 * LLM in the classify prompt. Slug / name / group stay in
 * `tax-sections.ts` (canonical set); only the hint is user-tunable.
 *
 * A row in `tax_section_hint_overrides` replaces the default hint for
 * its slug. Unknown slugs are rejected at the API boundary so garbage
 * can't accumulate.
 */

import { eq } from "drizzle-orm";
import db from "../db/database";
import { taxSectionHintOverrides } from "../db/schema";
import {
  TAX_SECTIONS,
  isValidTaxSectionSlug,
  type TaxSection,
} from "./tax-sections";

export type TaxSectionHintMap = Readonly<Record<string, string>>;

/**
 * Load every override row and return a `slug → hint` map. Called once per
 * classification run — cheap enough (< a few dozen rows) not to cache.
 */
export async function loadTaxHintOverrideMap(): Promise<TaxSectionHintMap> {
  const rows = await db
    .select({ slug: taxSectionHintOverrides.slug, hint: taxSectionHintOverrides.hint })
    .from(taxSectionHintOverrides);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.slug] = r.hint;
  return map;
}

/**
 * Merge the canonical sections with any overrides so the LLM always
 * sees the current effective hint.
 */
export async function loadEffectiveTaxSections(): Promise<TaxSection[]> {
  const overrides = await loadTaxHintOverrideMap();
  return TAX_SECTIONS.map((s) => ({
    ...s,
    hint: overrides[s.slug] ?? s.hint,
  }));
}

export interface TaxHintEntry {
  slug: string;
  name: string;
  group: TaxSection["group"];
  default_hint: string;
  effective_hint: string;
  is_overridden: boolean;
  updated_at: string | null;
}

/**
 * List every section together with default hint, effective hint, and
 * override timestamp. The admin UI renders this directly.
 */
export async function listTaxHintEntries(): Promise<TaxHintEntry[]> {
  const rows = await db
    .select({
      slug: taxSectionHintOverrides.slug,
      hint: taxSectionHintOverrides.hint,
      updated_at: taxSectionHintOverrides.updated_at,
    })
    .from(taxSectionHintOverrides);

  const bySlug = new Map<string, { hint: string; updated_at: string }>();
  for (const r of rows) bySlug.set(r.slug, { hint: r.hint, updated_at: r.updated_at });

  return TAX_SECTIONS.map((s) => {
    const ov = bySlug.get(s.slug);
    return {
      slug: s.slug,
      name: s.name,
      group: s.group,
      default_hint: s.hint,
      effective_hint: ov?.hint ?? s.hint,
      is_overridden: ov !== undefined,
      updated_at: ov?.updated_at ?? null,
    };
  });
}

/** Upsert a hint override. Rejects unknown slugs and empty hints. */
export async function upsertTaxHintOverride(slug: string, hint: string): Promise<void> {
  if (!isValidTaxSectionSlug(slug)) {
    throw new Error(`unknown tax section slug: ${slug}`);
  }
  const trimmed = hint.trim();
  if (trimmed.length === 0) {
    throw new Error("hint must not be empty");
  }
  await db
    .insert(taxSectionHintOverrides)
    .values({ slug, hint: trimmed })
    .onConflictDoUpdate({
      target: taxSectionHintOverrides.slug,
      set: { hint: trimmed, updated_at: new Date().toISOString() },
    });
}

/** Remove an override so the default from tax-sections.ts takes over again. */
export async function deleteTaxHintOverride(slug: string): Promise<void> {
  if (!isValidTaxSectionSlug(slug)) {
    throw new Error(`unknown tax section slug: ${slug}`);
  }
  await db.delete(taxSectionHintOverrides).where(eq(taxSectionHintOverrides.slug, slug));
}
