/**
 * Deterministic tax post-processing rules applied to the classifier output in
 * `runClassify`. Pure functions — unit-tested in tax-rules.test.ts.
 *
 * Background: a cloud-LLM audit (Claude vs. the local Qwen classifier) showed
 * the local model marks nearly EVERY private pension/life/Riester insurance
 * document as tax-relevant (→ `anlage-av` / `vorsorgeaufwand` / `anlage-r-av`),
 * even though only the actual certificate is a tax document. Claude confirmed
 * only ~24 % of the `anlage-av` assignments; the rest were mere admin mail:
 * Erhöhungsnachträge, Statusreports, Dynamik-Widersprüche, Standmitteilungen,
 * Fondsumschichtungen, Kontaktänderungen. The explicit prompt rule did not fix
 * this — the small model can't reliably make the distinction — so we enforce it
 * deterministically here, mirroring the content-rule approach in sender-rules.ts.
 */

import { normalizeForMatch } from "./sender-rules";
import type { TaxAssignment } from "./llm-client";

/**
 * Tax sections a private pension/life/Riester insurance document is (wrongly)
 * assigned. A mere admin notice — without an actual certificate — must not
 * carry these. Other sections (e.g. `aussergewoehnliche`) are never touched.
 */
const INSURANCE_TAX_SLUGS = new Set(["anlage-av", "vorsorgeaufwand", "anlage-r-av"]);

/**
 * Markers of insurance ADMIN mail (not a tax document). Given already
 * normalized (lowercase, no spaces/punctuation, umlauts kept). `dynami`
 * covers "Dynamik", "dynamische Erhöhung", "Dynamiknachtrag" and
 * "Dynamik-Widerspruch" at once.
 */
const ADMIN_MARKERS: readonly string[] = [
  "erhöhungsnachtrag",
  "dynami",
  "statusreport",
  "standmitteilung",
  "fondsumschichtung",
  "fondsersetzung",
  "fondswechsel",
  "kontaktdaten",
  "adressänderung",
  "anschriftenänderung",
];

/**
 * Markers whose presence means the document IS a genuine tax certificate and
 * must keep its tax sections. Checked against the OCR text only (see
 * `applyInsuranceAdminTaxRule`) so an unreliable LLM-generated title claiming
 * "Beitragsbescheinigung" cannot save an actual Dynamik-Widerspruch.
 */
const BELEG_MARKERS: readonly string[] = [
  "beitragsbescheinigung",
  "zulagenbescheinigung",
  "10aestg", // "§ 10a EStG" — Riester Sonderausgabenabzug
  "92estg", // "§ 92 EStG" — Riester-Zulagenbescheinigung
  "10estg", // "§ 10 EStG" — Vorsorgeaufwand-Bescheinigung
  "leistungsmitteilung",
  "rentenbezugsmitteilung",
  "steuerbescheinigung",
];

/**
 * Strip the insurance/pension tax sections from a document that is clearly
 * insurance ADMIN mail (an admin marker present) and carries NO certificate
 * marker. When that empties the tax-section list, the document is no longer
 * tax-relevant. Everything else passes through unchanged.
 *
 * Deliberately conservative: it only fires when the document already has one of
 * the insurance sections AND an admin marker AND no certificate marker — so a
 * genuine Beitrags-/Zulagenbescheinigung (certificate marker present) keeps its
 * status, and non-insurance documents are never affected.
 *
 * `text` should be the OCR-extracted document text, NOT the LLM title.
 */
export function applyInsuranceAdminTaxRule(input: {
  text: string;
  taxSections: readonly TaxAssignment[];
  taxRelevant: boolean;
}): { taxSections: TaxAssignment[]; taxRelevant: boolean } {
  const passthrough = {
    taxSections: [...input.taxSections],
    taxRelevant: input.taxRelevant,
  };

  const hasInsuranceSection = input.taxSections.some((s) => INSURANCE_TAX_SLUGS.has(s.slug));
  if (!hasInsuranceSection) return passthrough;

  const ctx = normalizeForMatch(input.text);
  if (!ctx) return passthrough;

  const hasAdmin = ADMIN_MARKERS.some((m) => ctx.includes(m));
  const hasBeleg = BELEG_MARKERS.some((m) => ctx.includes(m));
  if (!hasAdmin || hasBeleg) return passthrough;

  const kept = input.taxSections.filter((s) => !INSURANCE_TAX_SLUGS.has(s.slug));
  return {
    taxSections: kept,
    taxRelevant: kept.length > 0 ? input.taxRelevant : false,
  };
}

/** Exposed for tests / diagnostics. */
export const INSURANCE_ADMIN_TAX_RULE_INTERNALS = {
  INSURANCE_TAX_SLUGS,
  ADMIN_MARKERS,
  BELEG_MARKERS,
};
