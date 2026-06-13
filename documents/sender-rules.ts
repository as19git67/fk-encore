/**
 * Deterministic sender → category routing rules.
 *
 * Background: an embedding-clustering analysis of the existing corpus showed
 * that for this household the document *sender* is almost a deterministic
 * predictor of the category — each recurring institution maps to exactly one
 * document type — yet the zero-shot LLM funnels ~65 % of documents into the
 * generic "finanzen-rechnungen" bucket. These rules encode the known recurring
 * senders and are applied AFTER the LLM in `runClassify` to override the
 * category when a high-precision sender match exists.
 *
 * Design:
 *   - Matching is on a normalized form (lowercase, non-alphanumerics removed)
 *     so OCR/spacing/case variants ("Comdirect" / "comdirect",
 *     "HALLESCHE" / "HALLESCHE Krankenversicherung") collapse together.
 *   - Rules are evaluated top-to-bottom; the FIRST match wins. Put more
 *     specific rules (with `requireAny`) before the broader fallback.
 *   - `requireAny` / `excludeAny` test the normalized title + text so a single
 *     sender that issues several document kinds (e.g. the employer issuing both
 *     payslips and a forwarded tax assessment) can be disambiguated.
 *   - Every `category` must be a slug that exists in `taxonomy.ts`
 *     (enforced by sender-rules.test.ts).
 *
 * This is intentionally a plain data table so the list can grow as new
 * recurring senders appear, without touching the matching logic.
 */

export interface SenderRule {
  /** What this rule covers — documentation only. */
  note: string;
  /** Normalized sender fragments; rule matches if the normalized sender
   *  CONTAINS any of these. Give them already normalized (no spaces/punct). */
  senders: string[];
  /** Optional: only fire when normalized title+text contains any of these. */
  requireAny?: string[];
  /** Optional: never fire when normalized title+text contains any of these. */
  excludeAny?: string[];
  /** Target taxonomy category slug. */
  category: string;
}

/** Lowercase and strip everything except letters (incl. umlauts) and digits. */
export function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
}

export const SENDER_RULES: readonly SenderRule[] = [
  // ── Employer: payslips vs. a forwarded income-tax assessment ────────────
  // Specific case first: the employer occasionally forwards an
  // Einkommensteuerbescheid — that is a tax assessment, not a payslip.
  {
    note: "Arbeitgeber leitet ausnahmsweise einen Einkommensteuerbescheid weiter",
    senders: ["opentext", "ixos"],
    requireAny: ["einkommensteuerbescheid", "steuerbescheid"],
    category: "behoerden-steuerbescheid",
  },
  {
    note: "Arbeitgeber → Entgelt-/Gehaltsabrechnung, Sozialversicherungsnachweis",
    senders: ["opentext", "ixos"],
    category: "finanzen-gehalt",
  },
  {
    note: "Kirchlicher Arbeitgeber (Erzb. Ordinariat / St. Ulrich) → SV-/Entgeltnachweis",
    senders: ["ordinariat", "stulrich"],
    requireAny: [
      "sozialversicherung",
      "entgeltnachweis",
      "entgeltabrechnung",
      "verdienstbescheinigung",
      "beitragsnachweis",
    ],
    category: "finanzen-gehalt",
  },

  // ── Banks / brokers ─────────────────────────────────────────────────────
  {
    note: "Comdirect → Wertpapiere & Dividenden",
    senders: ["comdirect"],
    category: "finanzen-wertpapiere",
  },
  {
    note: "MLP / Commerzbank Darlehens-/Kontoauszüge → Kontoauszüge",
    senders: ["mlpbank", "mlpbanking", "commerzbank"],
    requireAny: ["darlehen", "kontoauszug", "rechnungsabschluss", "kontonachweis"],
    category: "finanzen-kontoauszuege",
  },
  {
    note: "Bausparkasse → Bausparen",
    senders: ["bausparkasse"],
    category: "finanzen-bausparen",
  },

  // ── Doctors / dentists / care ───────────────────────────────────────────
  {
    note: "Zahnarzt Kiesewetter → Arztrechnungen",
    senders: ["kiesewetter"],
    category: "gesundheit-arzt",
  },
  {
    note: "Ärztin Enzensberger → Arztrechnungen",
    senders: ["enzensberger"],
    category: "gesundheit-arzt",
  },
  {
    note: "Caritas-Sozialstation → Pflegeleistungen",
    senders: ["caritassozialstation", "sozialstation"],
    category: "gesundheit-pflege",
  },

  // ── Insurances ──────────────────────────────────────────────────────────
  {
    note: "HALLESCHE / DKV → Private Kranken-/Zusatzversicherung",
    senders: ["hallesche", "dkvdeutsche", "dkvdeutschekranken"],
    category: "versicherungen-kranken",
  },
  {
    note: "Heidelberger / AXA Lebensversicherung → Kapital-Lebensversicherung",
    senders: ["heidelbergerleben", "heidelbergerlebensversicherung", "axalebensversicherung"],
    category: "altersvorsorge-lebensversicherung",
  },
  {
    note: "Janitos / Marsh / HVS → Sach- & Haftpflichtversicherung",
    senders: ["janitos", "marshgmbh", "hvsversicherung"],
    category: "versicherungen-sach",
  },

  // ── Pension / authorities / municipal ───────────────────────────────────
  {
    note: "Deutsche Rentenversicherung (Renteninformation/-bescheid) → gesetzliche Rente",
    senders: ["deutscherentenversicherung", "bundesversicherungsanstalt"],
    requireAny: ["renteninformation", "rentenbescheid", "rentenanpassung", "rentenbezugsmitteilung", "rente"],
    category: "altersvorsorge-gesetzlich",
  },
  {
    note: "Kirchensteueramt → Kirchensteuer",
    senders: ["kirchensteueramt", "kirchensteuer"],
    category: "finanzen-kirchensteuer",
  },
  {
    note: "Steuerberater Treukontax → allgemeine Steuerunterlagen",
    senders: ["treukontax"],
    category: "finanzen-steuern",
  },
  {
    note: "Gemeinde (Wasser/Abwasser/Müll/Gebühren) → kommunale Abgaben",
    senders: ["gemeindemerching", "gemeinde"],
    requireAny: ["wasser", "abwasser", "müll", "abfall", "gebühr", "benutzungsgeb", "straßenreinigung"],
    category: "wohnen-kommunale-abgaben",
  },

  // ── Telecom / memberships / vehicle ─────────────────────────────────────
  {
    note: "LEW TelNet / Telekom-Provider → Telekommunikation",
    senders: ["telnet"],
    category: "vertraege-telekom",
  },
  {
    note: "Clever Fit → Abonnements/Mitgliedschaft",
    senders: ["cleverfit"],
    category: "vertraege-abos",
  },
  {
    note: "TÜV SÜD Hauptuntersuchung → TÜV",
    senders: ["tüvsüd", "tuvsud"],
    requireAny: ["hauptuntersuchung", "mängel", "stvzo"],
    category: "fahrzeug-tuev",
  },
  {
    note: "Gymnasium → Schule",
    senders: ["gymnasium"],
    category: "familie-schule",
  },
];

/**
 * Return the category slug a deterministic sender rule assigns, or null when
 * no high-precision rule matches. Owner/recipient names never match (the rules
 * only list external institutions), so the known "owner extracted as sender"
 * bug simply yields no override.
 */
export function matchSenderRule(input: {
  sender?: string | null;
  title?: string | null;
  text?: string | null;
}): string | null {
  const sender = normalizeForMatch(input.sender);
  if (!sender) return null;
  const ctx = normalizeForMatch(`${input.title ?? ""} ${input.text ?? ""}`);
  for (const rule of SENDER_RULES) {
    if (!rule.senders.some((frag) => sender.includes(frag))) continue;
    if (rule.requireAny && !rule.requireAny.some((frag) => ctx.includes(frag))) continue;
    if (rule.excludeAny && rule.excludeAny.some((frag) => ctx.includes(frag))) continue;
    return rule.category;
  }
  return null;
}
