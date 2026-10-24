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

const LIFE_INSURERS: string[] = [
  "heidelbergerleben",
  "heidelbergerlebensversicherung",
  "axalebensversicherung",
  "mlplebensversicherung",
];

/** The contract pays out an annuity. */
const ANNUITY_MARKERS: string[] = [
  "rentenversicherung",
  "garantierterente",
  "monatlicherente",
  "lebenslangerente",
  "altersrente",
  "rentenbeginn",
];

/** The contract pays out a lump sum. */
const LUMP_SUM_MARKERS: string[] = [
  "kapitallebensversicherung",
  "kapitalversicherung",
  "ablaufleistung",
  "erlebensfallleistung",
];

// Being moved into the database: the seed copies this list into
// document_sender_rule_overrides once (db/seed-sender-rules.ts, migration
// 0274), and a follow-up empties it here. New rules go into the table via
// `/documents/sender-rule-overrides`, not into this file.
export const SENDER_RULES: readonly SenderRule[] = [
  {
    note: "Familienkasse → Familienleistungen",
    senders: ["familienkasse"],
    category: "familie-familienleistungen",
  },
  // ── Employer / other household-specific senders ────────────────────────
  // Household-specific institutions (the actual employer, parish, etc.) are
  // deliberately NOT hard-coded here — this file is public. They are
  // configured as DB-backed overrides instead (migration 0141, see
  // `sender-rule-overrides.ts` and the `/documents/sender-rule-overrides`
  // API), which `matchSenderRule` below consults FIRST, ahead of this
  // built-in list. Use the same shape as `SenderRule` above, e.g. an
  // "Arbeitgeber" rule with `requireAny: SV_MELDUNG_KEYWORDS` for the DEÜV
  // notification case and a bare fallback rule for the monthly payslip.

  // ── Banks / brokers ─────────────────────────────────────────────────────
  {
    // The monthly Finanzreport lists giro, call money, card and depot on one
    // statement — an account statement, not a securities document.
    note: "Comdirect Finanzreport → Kontoauszüge",
    senders: ["comdirect"],
    requireAny: ["finanzreport"],
    category: "finanzen-kontoauszuege",
  },
  {
    note: "Comdirect → Wertpapiere & Dividenden",
    senders: ["comdirect"],
    category: "finanzen-wertpapiere",
  },
  {
    note: "MLP / Commerzbank Darlehens-/Kontoauszüge → Kontoauszüge",
    // "darlehenskonto", not "darlehen": a loan contract or payout instruction
    // from the same bank is a Kredit/Finanzierung document, only the account
    // statement of the loan account belongs here.
    senders: ["mlpbank", "mlpbanking", "mlpfinanzdienstleistungen", "commerzbank"],
    requireAny: ["darlehenskonto", "kontoauszug", "rechnungsabschluss", "kontonachweis"],
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
  // Life insurers sell both kinds of contract, and the company name says
  // "Lebensversicherung" either way. What decides is the benefit: an annuity →
  // Rentenversicherung, a lump sum → Kapital-Lebensversicherung. A letter that
  // names neither (a Dynamik notice, a direct-debit note) gets no rule and is
  // left to the model, which sees the taxonomy hints on both categories.
  {
    note: "Lebensversicherer, Leistung als Rente → private Rentenversicherung",
    senders: LIFE_INSURERS,
    requireAny: ANNUITY_MARKERS,
    category: "altersvorsorge-rentenversicherung",
  },
  {
    note: "Lebensversicherer, Leistung als Kapital → Kapital-Lebensversicherung",
    senders: LIFE_INSURERS,
    requireAny: LUMP_SUM_MARKERS,
    category: "altersvorsorge-lebensversicherung",
  },
  {
    note: "Janitos / Marsh / HVS → Sach-, Haftpflicht- & Rechtsschutzversicherung",
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
    senders: ["gemeinde"],
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
export function matchSenderRule(
  input: {
    sender?: string | null;
    title?: string | null;
    text?: string | null;
  },
  overrides?: readonly SenderRule[],
): string | null {
  const sender = normalizeForMatch(input.sender);
  if (!sender) return null;
  const ctx = normalizeForMatch(`${input.title ?? ""} ${input.text ?? ""}`);
  // DB-backed household overrides win over the built-in list (see the
  // "Employer / other household-specific senders" note above).
  for (const rule of overrides ?? []) {
    if (!rule.senders.some((frag) => sender.includes(frag))) continue;
    if (rule.requireAny && !rule.requireAny.some((frag) => ctx.includes(frag))) continue;
    if (rule.excludeAny && rule.excludeAny.some((frag) => ctx.includes(frag))) continue;
    return rule.category;
  }
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
 *   - A life insurer issues a Kapital-Lebensversicherung, a (Riester/
 *     fondsgebundene) Rentenversicherung AND a stand-alone BU policy — a
 *     §92/§10a/Riester marker or the BU policy name settles it before any
 *     sender rule looks at the benefit.
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
    // Riester/Rürup and fond-linked pension contracts. First on purpose: the
    // Zulage application asks for the Kindergeldnummer of every child it
    // claims a Kinderzulage for, so the Kindergeld rule below would otherwise
    // file every Riester document as a family benefit (2026-10 teacher run).
    // The markers below are
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
    // High-precision Kindergeld document markers. Deliberately no bare
    // "kindergeld": an Einkommensteuerbescheid or Anlage Kind may mention it
    // without being a Familienkasse document.
    note: "Kindergeldbescheid/-akte → Familienleistungen",
    keywords: [
      "bescheidüberkindergeld",
      "kindergeldnummer",
      "festsetzungdeskindergeldes",
      "kindergeldfestsetzung",
    ],
    category: "familie-familienleistungen",
  },
  {
    // A stand-alone BU policy. Insurers that also sell pension and life
    // contracts (the sender rules) cannot tell it apart; the policy name can.
    // A BU *rider* on a pension contract ("Berufsunfähigkeits-Zusatzversicherung")
    // normalizes to "berufsunfähigkeitszusatzversicherung" and stays with the
    // main contract.
    note: "Berufs-/Erwerbsunfähigkeitsversicherung → BU",
    keywords: ["berufsunfähigkeitsversicherung", "erwerbsunfähigkeitsversicherung"],
    category: "versicherungen-berufsunfaehigkeit",
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
