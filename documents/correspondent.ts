/**
 * Canonical correspondent (Korrespondent) resolution.
 *
 * `documents.sender` is free-form text the LLM extracts from a document.
 * It is great for the speaking filename, but far too unstable to use
 * directly as a *folder* name: "Janitos", "Janitos Versicherung AG" and
 * "Janitos AG" would each spawn their own directory. This module maps a
 * raw sender onto a **stable correspondent identity** so callers can build
 * a deduplicated `<category>/<correspondent>/…` folder tree.
 *
 * Sender resolution order:
 *   1. empty / unrecognisable sender          → `null` (caller falls back)
 *   2. registry hit (known recurring sender)  → canonical `{ slug, display }`
 *   3. otherwise                              → slugified raw sender
 *      (accepted long-tail fragmentation for one-off senders)
 *
 * The registry is a plain data table — like `SENDER_RULES` — seeded from the
 * institutions already catalogued in `sender-rules.ts`. It can grow without
 * touching the matching logic. Entries are evaluated top-to-bottom and the
 * FIRST fragment match wins, so keep more specific fragments earlier.
 *
 * Folder-slug composition (`buildCorrespondentFolderSlug`): so that several
 * contracts from the *same* provider don't collapse into one directory, the
 * folder segment combines up to three parts:
 *
 *   <sender>[-<product>][-<contract-anchor>]
 *
 *   - product        — from a keyword table over the document TITLE
 *     (privathaftpflicht, hausrat, kfz, …); omitted when no known product.
 *   - contract-anchor — the stable Versicherungsschein-/Vertragsnummer that
 *     already lives in the document's reference tags (`versicherungsnr:…`,
 *     `vertragsnr:…`; see `extractReferenceNumberTags`). Appended whenever
 *     present. Deliberately NOT `document_number`, which is a per-document
 *     number (see metadata-extract.ts, #664), not a per-contract anchor.
 *
 * This module is intentionally side-effect free and DB-free so it can be
 * unit-tested in isolation (see `correspondent.test.ts`).
 */

import { normalizeForMatch } from "./sender-rules";
import { slugifyName } from "./documents.service";
import { INSTITUTIONS } from "./institutions";

export interface CorrespondentIdentity {
  /** Filesystem-safe folder segment, e.g. "janitos". */
  slug: string;
  /** Human-readable name for display/UX, e.g. "Janitos". */
  display: string;
}

/**
 * A user-defined correspondent override: when the normalised sender contains
 * `pattern`, force the given identity instead of consulting the registry.
 * If several overrides match, the longest (most specific) pattern wins; equal
 * lengths use the pattern text as a deterministic tie-breaker.
 * Loaded from the DB by `correspondent-overrides.ts` and passed in so this
 * module stays pure/DB-free.
 */
export interface CorrespondentOverride {
  /** Normalised sender fragment to match (same folding as `normalizeForMatch`). */
  pattern: string;
  slug: string;
  display: string;
}

/**
 * Known recurring correspondents for this household. Single-sourced from
 * `institutions.ts`, which is kept in lock-step with the sender rules by
 * `institutions.test.ts`. Overly generic senders (e.g. "gemeinde",
 * "bausparkasse") are intentionally absent and fall through to the slugified
 * fallback in `resolveCorrespondent`.
 */
export const CORRESPONDENT_REGISTRY = INSTITUTIONS;

/**
 * Resolve the canonical correspondent for a raw sender string.
 *
 * Returns `null` when the sender is empty or reduces to nothing after
 * slugification, so the caller can place the document in an
 * "unknown correspondent" fallback folder.
 */
export function resolveCorrespondent(
  sender: string | null | undefined,
  overrides?: readonly CorrespondentOverride[],
): CorrespondentIdentity | null {
  const normalized = normalizeForMatch(sender);
  if (!normalized) return null;

  // User overrides win over the built-in registry.
  if (overrides) {
    let bestMatch: CorrespondentOverride | undefined;
    for (const o of overrides) {
      if (o.pattern.length === 0 || !normalized.includes(o.pattern)) continue;
      if (
        !bestMatch ||
        o.pattern.length > bestMatch.pattern.length ||
        (o.pattern.length === bestMatch.pattern.length && o.pattern < bestMatch.pattern)
      ) bestMatch = o;
    }
    if (bestMatch) {
      return { slug: bestMatch.slug, display: bestMatch.display };
    }
  }

  for (const entry of CORRESPONDENT_REGISTRY) {
    if (entry.fragments.some((frag) => normalized.includes(frag))) {
      return { slug: entry.slug, display: entry.display };
    }
  }

  // Long-tail: no known institution. Derive a stable slug from the raw
  // sender. Some near-duplicate fragmentation is accepted here — the
  // registry above is the place to unify recurring senders.
  const slug = slugifyName(sender ?? "", 40);
  if (!slug) return null;
  return { slug, display: (sender ?? "").trim() };
}

// ─── Product (Sparte) resolution ───────────────────────────────────────────

export interface ProductIdentity {
  slug: string;
  display: string;
}

interface ProductRule {
  slug: string;
  display: string;
  /**
   * Normalised keyword fragments (same folding as `normalizeForMatch`). The
   * rule matches when the normalised TITLE contains any fragment. Matching is
   * on the title only (not the full body text): a title almost always names
   * the product, while the body frequently mentions other Sparten in passing —
   * matching the body would mis-file documents into a wrong product folder.
   */
  keywords: string[];
}

/**
 * Product/Sparte keyword table. Evaluated top-to-bottom, FIRST match wins, so
 * keep more specific products earlier (e.g. a Kfz-Haftpflicht before a bare
 * Haftpflicht). Focused on the recurring insurance/financial products in this
 * household; grows as new product types appear.
 */
export const PRODUCT_RULES: readonly ProductRule[] = [
  { slug: "kfz", display: "Kfz-Versicherung", keywords: ["kraftfahrtversicherung", "kraftfahrzeugversicherung", "kfzversicherung", "kfzhaftpflicht", "kaskoversicherung", "teilkasko", "vollkasko"] },
  { slug: "privathaftpflicht", display: "Privathaftpflicht", keywords: ["privathaftpflicht", "privatehaftpflicht"] },
  { slug: "tierhalterhaftpflicht", display: "Tierhalterhaftpflicht", keywords: ["tierhalterhaftpflicht", "hundehaftpflicht"] },
  { slug: "hausrat", display: "Hausratversicherung", keywords: ["hausratversicherung", "hausrat"] },
  { slug: "wohngebaeude", display: "Wohngebäudeversicherung", keywords: ["wohngebäudeversicherung", "wohngebäude", "gebäudeversicherung"] },
  { slug: "rechtsschutz", display: "Rechtsschutzversicherung", keywords: ["rechtsschutzversicherung", "rechtsschutz"] },
  { slug: "unfall", display: "Unfallversicherung", keywords: ["unfallversicherung"] },
  { slug: "berufsunfaehigkeit", display: "Berufsunfähigkeitsversicherung", keywords: ["berufsunfähigkeitsversicherung", "berufsunfähigkeit"] },
  { slug: "rentenversicherung", display: "Rentenversicherung", keywords: ["rentenversicherung", "riester", "rürup", "basisrente", "fondsgebundenerentenversicherung"] },
  { slug: "lebensversicherung", display: "Lebensversicherung", keywords: ["risikolebensversicherung", "kapitallebensversicherung", "lebensversicherung"] },
  { slug: "zahnzusatz", display: "Zahnzusatzversicherung", keywords: ["zahnzusatzversicherung", "zahnzusatz"] },
  { slug: "krankenzusatz", display: "Krankenzusatzversicherung", keywords: ["krankenzusatzversicherung", "krankenzusatz"] },
  { slug: "krankenversicherung", display: "Krankenversicherung", keywords: ["krankenversicherung", "krankenvollversicherung"] },
  { slug: "pflege", display: "Pflegeversicherung", keywords: ["pflegezusatzversicherung", "pflegeversicherung"] },
  { slug: "reise", display: "Reiseversicherung", keywords: ["reiserücktrittsversicherung", "auslandskrankenversicherung", "reiseversicherung"] },
  { slug: "bausparen", display: "Bausparvertrag", keywords: ["bausparvertrag", "bausparen"] },
];

/**
 * Resolve a product/Sparte slug from the document title, or `null` when the
 * title names no known product.
 */
export function resolveProductSlug(
  title: string | null | undefined,
): ProductIdentity | null {
  const normalized = normalizeForMatch(title);
  if (!normalized) return null;
  for (const rule of PRODUCT_RULES) {
    if (rule.keywords.some((k) => normalized.includes(k))) {
      return { slug: rule.slug, display: rule.display };
    }
  }
  return null;
}

// ─── Contract anchor (stable per-contract number) ──────────────────────────

/**
 * Reference-tag prefixes that identify a *contract* (not a customer or order),
 * in priority order. These are produced by `extractReferenceNumberTags`.
 * `kundennr`/`auftragsnr` are intentionally excluded: a customer number spans
 * all of a provider's contracts, an order number is per-transaction.
 */
const CONTRACT_TAG_PREFIXES = ["versicherungsnr", "vertragsnr"] as const;

/**
 * Pull a stable contract anchor slug out of the document's tags, preferring a
 * Versicherungsschein-/Policennummer over a generic Vertragsnummer. Returns
 * `null` when no contract tag is present.
 */
export function extractContractAnchor(
  tags: readonly string[] | null | undefined,
): string | null {
  if (!tags || tags.length === 0) return null;
  for (const prefix of CONTRACT_TAG_PREFIXES) {
    for (const tag of tags) {
      const t = tag.trim().toLowerCase();
      if (t.startsWith(`${prefix}:`)) {
        const slug = slugifyName(t.slice(prefix.length + 1), 32);
        if (slug) return slug;
      }
    }
  }
  return null;
}

// ─── Composite folder slug ─────────────────────────────────────────────────

export interface CorrespondentFolderInput {
  /** Free-form extracted sender/absender. */
  sender: string | null | undefined;
  /** Classified title — used for product detection. */
  title?: string | null;
  /** Document tags (must include any `versicherungsnr:`/`vertragsnr:` tags). */
  tags?: readonly string[] | null;
}

/**
 * Build the correspondent folder segment `<sender>[-<product>][-<contract>]`.
 *
 * Returns `null` when there is no usable sender, so the caller can place the
 * document under an "unknown correspondent" fallback folder. Product and
 * contract parts are appended only when detected, degrading gracefully to a
 * plain `<sender>` slug.
 */
export function buildCorrespondentFolderSlug(
  input: CorrespondentFolderInput,
  overrides?: readonly CorrespondentOverride[],
): string | null {
  const correspondent = resolveCorrespondent(input.sender, overrides);
  if (!correspondent) return null;
  const product = resolveProductSlug(input.title);
  const contract = extractContractAnchor(input.tags);
  return [correspondent.slug, product?.slug, contract]
    .filter((part): part is string => Boolean(part))
    .join("-");
}
