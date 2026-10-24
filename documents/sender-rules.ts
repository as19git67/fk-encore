/**
 * Deterministic sender → category routing rules.
 *
 * Background: an embedding-clustering analysis of the existing corpus showed
 * that the document *sender* is almost a deterministic predictor of the
 * category — each recurring institution maps to exactly one document type —
 * yet the zero-shot LLM funnels most documents into the generic
 * "finanzen-rechnungen" bucket. Sender rules encode the known recurring
 * senders and are applied AFTER the LLM in `runClassify` to override the
 * category when a high-precision sender match exists.
 *
 * The rules themselves are the household's data, not code: they live in
 * document_sender_rule_overrides (migration 0141, `sender-rule-overrides.ts`,
 * API `/documents/sender-rule-overrides`). This file is public, so it names no
 * institution; it only holds the matcher and the sender-independent content
 * rules below.
 *
 * Design:
 *   - Matching is on a normalized form (lowercase, non-alphanumerics removed)
 *     so OCR/spacing/case variants ("Beispielbank" / "BEISPIEL BANK AG")
 *     collapse together.
 *   - Rules are evaluated top-to-bottom; the FIRST match wins. Put more
 *     specific rules (with `requireAny`) before the broader fallback.
 *   - `requireAny` / `excludeAny` test the normalized title + text so a single
 *     sender that issues several document kinds (e.g. the employer issuing both
 *     payslips and a forwarded tax assessment) can be disambiguated.
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
 * Return the category slug a deterministic sender rule assigns, or null when
 * no high-precision rule matches. `rules` are the household's rules from
 * `loadSenderRuleOverrides`. Owner/recipient names never match (the rules only
 * list external institutions), so the known "owner extracted as sender" bug
 * simply yields no override.
 */
export function matchSenderRule(
  input: {
    sender?: string | null;
    title?: string | null;
    text?: string | null;
  },
  rules: readonly SenderRule[],
): string | null {
  const sender = normalizeForMatch(input.sender);
  if (!sender) return null;
  const ctx = normalizeForMatch(`${input.title ?? ""} ${input.text ?? ""}`);
  for (const rule of rules) {
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
