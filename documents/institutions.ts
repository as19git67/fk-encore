/**
 * Canonical institution list — the single source of truth for known
 * correspondents.
 *
 * Both the correspondent registry (documents/correspondent.ts) and the
 * deterministic sender routing (documents/sender-rules.ts) deal with the same
 * recurring institutions. To avoid maintaining that identity in two places,
 * the correspondent side is defined here once and every fragment is kept in
 * lock-step with the sender rules by `institutions.test.ts` (which fails if an
 * institution names a sender fragment that no sender rule knows about).
 *
 * Each institution maps one or more normalised sender fragments (same folding
 * as `normalizeForMatch`) to a stable correspondent identity.
 */

export interface Institution {
  /** Filesystem-safe correspondent slug, e.g. "janitos". */
  slug: string;
  /** Human-readable correspondent name, e.g. "Janitos". */
  display: string;
  /**
   * Normalised sender fragments (lower-case, `[a-z0-9äöüß]` only). The
   * institution matches when a normalised sender CONTAINS any fragment. Every
   * fragment must also be a known sender in `sender-rules.ts` (enforced by
   * `institutions.test.ts`).
   */
  fragments: string[];
}

/**
 * Known recurring institutions for this household. Deliberately excludes overly
 * generic sender fragments (e.g. "gemeinde", "bausparkasse", "gymnasium",
 * "kirchensteueramt") that carry no single-institution identity — those are
 * handled by the slugified fallback in `resolveCorrespondent`.
 */
export const INSTITUTIONS: readonly Institution[] = [
  // Employer document portals (OpenText/IXOS deliver the employer's payslips,
  // SV notifications, forwarded tax assessments). Unified so all employer
  // paperwork lands under one correspondent.
  { slug: "arbeitgeber", display: "Arbeitgeber", fragments: ["opentext", "ixos"] },

  // Banks / brokers
  { slug: "comdirect", display: "comdirect", fragments: ["comdirect"] },
  { slug: "commerzbank", display: "Commerzbank", fragments: ["commerzbank"] },
  { slug: "mlp", display: "MLP", fragments: ["mlpbank", "mlpbanking", "mlplebensversicherung"] },

  // Doctors / dentists / care
  { slug: "kiesewetter", display: "Zahnarzt Kiesewetter", fragments: ["kiesewetter"] },
  { slug: "enzensberger", display: "Ärztin Enzensberger", fragments: ["enzensberger"] },
  { slug: "caritas-sozialstation", display: "Caritas-Sozialstation", fragments: ["caritassozialstation"] },

  // Health insurance (gesetzliche Krankenkassen)
  { slug: "barmer", display: "BARMER", fragments: ["barmer"] },
  { slug: "techniker-krankenkasse", display: "Techniker Krankenkasse", fragments: ["techniker"] },
  { slug: "aok", display: "AOK", fragments: ["aokbayern", "aokplus"] },

  // Private health / life / property insurance
  { slug: "hallesche", display: "HALLESCHE", fragments: ["hallesche"] },
  { slug: "dkv", display: "DKV", fragments: ["dkvdeutsche", "dkvdeutschekranken"] },
  { slug: "heidelberger-leben", display: "Heidelberger Leben", fragments: ["heidelbergerleben", "heidelbergerlebensversicherung"] },
  { slug: "axa", display: "AXA", fragments: ["axalebensversicherung"] },
  { slug: "janitos", display: "Janitos", fragments: ["janitos"] },
  { slug: "marsh", display: "Marsh", fragments: ["marshgmbh"] },
  { slug: "hvs", display: "HVS", fragments: ["hvsversicherung"] },

  // Pension / authorities / tax
  { slug: "deutsche-rentenversicherung", display: "Deutsche Rentenversicherung", fragments: ["deutscherentenversicherung", "bundesversicherungsanstalt"] },
  { slug: "treukontax", display: "Treukontax", fragments: ["treukontax"] },
  { slug: "stadt-eutin", display: "Stadt Eutin", fragments: ["stadteutin", "stadtverwaltungeutin"] },

  // Telecom / memberships / vehicle
  { slug: "lew-telnet", display: "LEW TelNet", fragments: ["telnet"] },
  { slug: "telefonica", display: "Telefónica/O2", fragments: ["telefnica", "telefonica"] },
  { slug: "vodafone", display: "Vodafone", fragments: ["vodafone"] },
  { slug: "telekom", display: "Telekom", fragments: ["telekom"] },
  { slug: "clever-fit", display: "Clever Fit", fragments: ["cleverfit"] },
  { slug: "tuev-sued", display: "TÜV SÜD", fragments: ["tüvsüd", "tuvsud"] },
];
