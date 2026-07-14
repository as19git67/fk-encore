/**
 * Canonical correspondent (Korrespondent) resolution.
 *
 * `documents.sender` is free-form text the LLM extracts from a document.
 * It is great for the speaking filename, but far too unstable to use
 * directly as a *folder* name: "Janitos", "Janitos Versicherung AG" and
 * "Janitos AG" would each spawn their own directory. This module maps a
 * raw sender onto a **stable correspondent identity** so callers can build
 * a deduplicated `<category>/<correspondent>/<year>/…` folder tree.
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

export interface CorrespondentIdentity {
  /** Filesystem-safe folder segment, e.g. "janitos". */
  slug: string;
  /** Human-readable name for display/UX, e.g. "Janitos". */
  display: string;
}

interface CorrespondentRegistryEntry {
  slug: string;
  display: string;
  /**
   * Normalised sender fragments (already run through the same folding as
   * `normalizeForMatch`: lower-case, only `[a-z0-9äöüß]`). The entry matches
   * when the normalised sender CONTAINS any fragment.
   */
  fragments: string[];
}

/**
 * Known recurring correspondents for this household, seeded from the
 * institutions in `sender-rules.ts`. Deliberately excludes overly generic
 * fragments (e.g. "gemeinde", "bausparkasse", "gymnasium") — those carry no
 * institution identity and are better handled by the slugified fallback.
 */
export const CORRESPONDENT_REGISTRY: readonly CorrespondentRegistryEntry[] = [
  // ── Employer document portals (Contoso/Contoso deliver the employer's
  //    payslips, SV notifications, forwarded tax assessments). Unified so all
  //    employer paperwork lands under one correspondent. ──
  { slug: "arbeitgeber", display: "Arbeitgeber", fragments: ["contoso", "contoso"] },

  // ── Banks / brokers ──
  { slug: "comdirect", display: "comdirect", fragments: ["comdirect"] },
  { slug: "commerzbank", display: "Commerzbank", fragments: ["commerzbank"] },
  { slug: "mlp", display: "MLP", fragments: ["mlpbank", "mlpbanking", "mlplebensversicherung"] },

  // ── Doctors / dentists / care ──
  { slug: "kiesewetter", display: "Zahnarzt Kiesewetter", fragments: ["kiesewetter"] },
  { slug: "enzensberger", display: "Ärztin Enzensberger", fragments: ["enzensberger"] },
  { slug: "caritas-sozialstation", display: "Caritas-Sozialstation", fragments: ["caritassozialstation"] },

  // ── Health insurance (gesetzliche Krankenkassen) ──
  { slug: "barmer", display: "BARMER", fragments: ["barmer"] },
  { slug: "techniker-krankenkasse", display: "Techniker Krankenkasse", fragments: ["technikerkrankenkasse", "technikerkasse"] },
  { slug: "aok", display: "AOK", fragments: ["aokbayern", "aokplus"] },

  // ── Private health / life / property insurance ──
  { slug: "hallesche", display: "HALLESCHE", fragments: ["hallesche"] },
  { slug: "dkv", display: "DKV", fragments: ["dkvdeutsche"] },
  { slug: "heidelberger-leben", display: "Heidelberger Leben", fragments: ["heidelbergerleben", "heidelbergerlebensversicherung"] },
  { slug: "axa", display: "AXA", fragments: ["axalebensversicherung", "axaversicherung"] },
  { slug: "janitos", display: "Janitos", fragments: ["janitos"] },
  { slug: "marsh", display: "Marsh", fragments: ["marshgmbh"] },
  { slug: "hvs", display: "HVS", fragments: ["hvsversicherung"] },

  // ── Pension / authorities / tax ──
  { slug: "deutsche-rentenversicherung", display: "Deutsche Rentenversicherung", fragments: ["deutscherentenversicherung", "bundesversicherungsanstalt"] },
  { slug: "treukontax", display: "Treukontax", fragments: ["treukontax"] },
  { slug: "stadt-eutin", display: "Stadt Eutin", fragments: ["stadteutin", "stadtverwaltungeutin"] },

  // ── Telecom / memberships / vehicle ──
  { slug: "lew-telnet", display: "LEW TelNet", fragments: ["lewtelnet", "telnet"] },
  { slug: "telefonica", display: "Telefónica/O2", fragments: ["telefnica", "telefonica"] },
  { slug: "vodafone", display: "Vodafone", fragments: ["vodafone"] },
  { slug: "telekom", display: "Telekom", fragments: ["deutschetelekom", "telekom"] },
  { slug: "clever-fit", display: "Clever Fit", fragments: ["cleverfit"] },
  { slug: "tuev-sued", display: "TÜV SÜD", fragments: ["tüvsüd", "tuvsud"] },
];

/**
 * Resolve the canonical correspondent for a raw sender string.
 *
 * Returns `null` when the sender is empty or reduces to nothing after
 * slugification, so the caller can place the document in an
 * "unknown correspondent" fallback folder.
 */
export function resolveCorrespondent(
  sender: string | null | undefined,
): CorrespondentIdentity | null {
  const normalized = normalizeForMatch(sender);
  if (!normalized) return null;

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
): string | null {
  const correspondent = resolveCorrespondent(input.sender);
  if (!correspondent) return null;
  const product = resolveProductSlug(input.title);
  const contract = extractContractAnchor(input.tags);
  return [correspondent.slug, product?.slug, contract]
    .filter((part): part is string => Boolean(part))
    .join("-");
}
