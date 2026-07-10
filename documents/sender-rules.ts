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

/**
 * Document-type keywords that mark an employer document as a *Meldung zur
 * Sozialversicherung* (DEÜV annual SV notification), as opposed to a monthly
 * payslip. Written as space-less fragments because `normalizeForMatch` strips
 * whitespace. Deliberately excludes the bare word "sozialversicherung", which
 * also appears on ordinary payslips (the SV-deduction line) and would pull
 * those into the wrong category.
 */
const SV_MELDUNG_KEYWORDS: string[] = [
  "entgeltnachweis",
  "sozialversicherungsnachweis",
  "sozialversicherungsmeldung",
  "meldungzursozialversicherung",
  "meldebescheinigungzursozialversicherung",
  "beitragsnachweis",
  "deüv",
];

export const SENDER_RULES: readonly SenderRule[] = [
  // ── Employer: payslips vs. forwarded tax assessment vs. SV notification ──
  // Order matters (first match wins): the most specific document types come
  // first, the unguarded payslip fallback last.
  //
  // Specific case first: the employer occasionally forwards an
  // Einkommensteuerbescheid — that is a tax assessment, not a payslip.
  {
    note: "Arbeitgeber leitet ausnahmsweise einen Einkommensteuerbescheid weiter",
    senders: ["contoso", "contoso"],
    requireAny: ["einkommensteuerbescheid", "steuerbescheid"],
    category: "behoerden-steuerbescheid",
  },
  {
    note: "Arbeitgeber → jährliche Meldung/Entgeltnachweis zur Sozialversicherung (DEÜV)",
    senders: ["contoso", "contoso"],
    requireAny: SV_MELDUNG_KEYWORDS,
    category: "finanzen-sozialversicherung",
  },
  {
    note: "Arbeitgeber → monatliche Entgelt-/Gehaltsabrechnung (Fallback)",
    senders: ["contoso", "contoso"],
    category: "finanzen-gehalt",
  },
  {
    note: "Kirchlicher Arbeitgeber (Erzb. Verwaltungsstelle / St. Beispiel) → Meldung zur Sozialversicherung",
    senders: ["verwaltungsstelle", "musterpfarrei"],
    requireAny: SV_MELDUNG_KEYWORDS,
    category: "finanzen-sozialversicherung",
  },
  {
    note: "Kirchlicher Arbeitgeber (Erzb. Verwaltungsstelle / St. Beispiel) → Entgelt-/Gehaltsabrechnung",
    senders: ["verwaltungsstelle", "musterpfarrei"],
    requireAny: ["entgeltabrechnung", "gehaltsabrechnung", "lohnabrechnung", "verdienstbescheinigung"],
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

  // ── Health insurance (gesetzliche Krankenkassen) ─────────────────────────
  {
    note: "BARMER / Techniker Krankenkasse / AOK → gesetzliche Krankenkasse",
    senders: ["barmer", "techniker", "aokbayern", "aokplus"],
    category: "gesundheit-kasse",
  },

  // ── Insurances ──────────────────────────────────────────────────────────
  {
    note: "HALLESCHE / DKV → Private Kranken-/Zusatzversicherung",
    senders: ["hallesche", "dkvdeutsche", "dkvdeutschekranken"],
    category: "versicherungen-kranken",
  },
  {
    note: "Heidelberger / AXA / MLP Lebensversicherung → Kapital-Lebensversicherung",
    senders: ["heidelbergerleben", "heidelbergerlebensversicherung", "axalebensversicherung", "mlplebensversicherung"],
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
    senders: ["gemeindebeispielstadt", "gemeinde"],
    requireAny: ["wasser", "abwasser", "müll", "abfall", "gebühr", "benutzungsgeb", "straßenreinigung"],
    category: "wohnen-kommunale-abgaben",
  },
  {
    note: "Stadtverwaltung Eutin (Grundsteuerbescheid) → kommunale Abgaben",
    senders: ["stadteutin", "stadtverwaltungeutin"],
    requireAny: ["grundsteuer", "grundsteuerbescheid", "grundsteuermessbetrag"],
    category: "wohnen-kommunale-abgaben",
  },

  // ── Telecom / memberships / vehicle ─────────────────────────────────────
  {
    note: "Telekom-Provider (LEW TelNet, Telefónica/O2, Vodafone, Telekom) → Telekommunikation",
    // 'telefnica' matches the normalized 'Telefónica' (the ó is stripped by
    // normalizeForMatch); 'telefonica' covers OCR without the accent.
    senders: ["telnet", "telefnica", "telefonica", "vodafone", "telekom"],
    // Guard: a Deutsche-Telekom share/dividend statement names the provider
    // but belongs to securities — keep those out of the telecom bucket.
    excludeAny: [
      "dividende",
      "aktie",
      "wertpapier",
      "depot",
      "isin",
      "erträgnis",
      "ausschüttung",
      "kapitalertrag",
    ],
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

/**
 * Content-keyword routing rules — a sibling to the sender rules for the case
 * the sender CANNOT disambiguate: the same institution issues several document
 * types that only a document-type keyword tells apart (a cloud-LLM audit showed
 * the local model consistently confuses these):
 *
 *   - Heidelberger / MLP issue both a Kapital-Lebensversicherung AND a
 *     (Riester/fondsgebundene) Rentenversicherung — the sender rule forces
 *     "altersvorsorge-lebensversicherung", but a §92/§10a/Riester marker means
 *     it is really "altersvorsorge-rentenversicherung".
 *   - A Kfz-insurer's Kasko/Kraftfahrt policy is a fahrzeug-versicherung, not a
 *     generic Sach-/Personenversicherung.
 *
 * These are matched on the normalized title + text only (no sender), and — see
 * `matchContentRule`'s use in `runClassify` — take precedence OVER the sender
 * rules, because a document-type keyword is more specific than the issuer.
 */
export interface ContentRule {
  /** What this rule covers — documentation only. */
  note: string;
  /** Normalized keyword fragments; matches if the normalized title+text
   *  CONTAINS any of these. Give them already normalized (no spaces/punct). */
  keywords: string[];
  /** Optional: never fire when normalized title+text contains any of these. */
  excludeAny?: string[];
  /** Target taxonomy category slug. */
  category: string;
}

export const CONTENT_RULES: readonly ContentRule[] = [
  {
    // Riester/Rürup and fond-linked pension contracts. The markers below are
    // unique to a state-subsidised/annuity pension (never on a plain capital
    // life policy). The excludeAny guards an actual monthly payslip whose body
    // might list a "Riester" deduction line — a payslip carries the brutto/
    // net markers a pension status report never does.
    note: "Riester/Rürup/fondsgebundene Rentenversicherung → private Rentenversicherung",
    keywords: [
      "riester",
      "rürup",
      "basisrente",
      "zulagenbescheinigung",
      "altersvorsorgezulage",
      "grundzulage",
      "kinderzulage",
      "förderrente",
      "fondsgebundenerentenversicherung",
      "92estg", // "§ 92 EStG" — Riester-Zulagenbescheinigung
      "10aestg", // "§ 10a EStG" — Riester/Rürup Sonderausgabenabzug
    ],
    excludeAny: [
      "gesamtbrutto",
      "steuerbrutto",
      "svbrutto",
      "auszahlungsbetrag",
      "nettoverdienst",
    ],
    category: "altersvorsorge-rentenversicherung",
  },
  {
    note: "Kfz-Haftpflicht/Kasko/Kraftfahrtversicherung → Kfz-Versicherung",
    keywords: [
      "kraftfahrtversicherung",
      "kraftfahrzeugversicherung",
      "kfzversicherung",
      "kfzhaftpflicht",
      "teilkasko",
      "vollkasko",
      "kaskoversicherung",
    ],
    category: "fahrzeug-versicherung",
  },
  {
    // Building insurance for the SELF-OCCUPIED home. A rented object's building
    // insurance belongs to the Kapitalanlage branch, so exclude those markers.
    note: "Wohngebäudeversicherung (selbst bewohnt) → Gebäudeversicherung Haus",
    keywords: ["wohngebäudeversicherung", "wohngebäude"],
    excludeAny: ["sondereigentum", "kapitalanlage", "vermietet", "vermietung", "mieteinnahmen"],
    category: "wohnen-haus-gebaeudeversicherung",
  },
];

/**
 * Return the category slug a deterministic CONTENT rule assigns, or null. Keyed
 * purely on the normalized title + text (the sender is irrelevant here). Used
 * ahead of `matchSenderRule` in `runClassify`.
 */
export function matchContentRule(input: {
  title?: string | null;
  text?: string | null;
}): string | null {
  const ctx = normalizeForMatch(`${input.title ?? ""} ${input.text ?? ""}`);
  if (!ctx) return null;
  for (const rule of CONTENT_RULES) {
    if (!rule.keywords.some((frag) => ctx.includes(frag))) continue;
    if (rule.excludeAny && rule.excludeAny.some((frag) => ctx.includes(frag))) continue;
    return rule.category;
  }
  return null;
}
