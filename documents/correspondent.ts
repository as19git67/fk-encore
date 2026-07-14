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
 * Resolution order:
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
  // ── Employer document portals (OpenText/IXOS deliver the employer's
  //    payslips, SV notifications, forwarded tax assessments). Unified so all
  //    employer paperwork lands under one correspondent. ──
  { slug: "arbeitgeber", display: "Arbeitgeber", fragments: ["opentext", "ixos"] },

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
