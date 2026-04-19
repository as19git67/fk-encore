/**
 * Canonical list of German income-tax-return sections (Anlagen) that a
 * private household document can belong to.
 *
 * Used in three places:
 *   1. `llm-service/main.py` — sent as part of the `/classify` prompt so
 *      the LLM picks one (or several) slugs from this fixed set.
 *   2. `documents/llm-client.ts` — validates the slugs on the way back.
 *   3. Frontend — groups the "Steuer" view by `group` and renders `name`.
 *
 * Decision: a document may belong to **multiple** sections (N:M), see
 * docs/tax-document-detection.md § 8.1. The join table
 * `document_tax_sections` stores (document_id, slug, confidence, source).
 *
 * `hint` is a short German sentence telling both the LLM and the user
 * what kind of document belongs in this section. Kept deliberately
 * concrete (types of paperwork, not statute numbers) so the LLM can match
 * against the OCR text.
 */

export type TaxSectionGroup = "einkuenfte" | "abzuege" | "bescheid" | "rahmen";

export interface TaxSection {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  hint: string;
}

export const TAX_SECTIONS: readonly TaxSection[] = [
  // ─── Einkünfte (Einnahmen) ──────────────────────────────────────────
  {
    slug: "anlage-n",
    group: "einkuenfte",
    name: "Anlage N — Nichtselbstständige Arbeit",
    hint: "Lohnsteuerbescheinigung, Gehaltsabrechnungen, Arbeitgeberbescheinigungen.",
  },
  {
    slug: "anlage-kap",
    group: "einkuenfte",
    name: "Anlage KAP — Kapitalerträge",
    hint: "Jahressteuerbescheinigung der Bank/Broker, Zins- und Dividendenabrechnungen.",
  },
  {
    slug: "anlage-v",
    group: "einkuenfte",
    name: "Anlage V — Vermietung & Verpachtung",
    hint: "Mieteinnahmen-Nachweise, Nebenkostenabrechnungen als Vermieter.",
  },
  {
    slug: "anlage-r",
    group: "einkuenfte",
    name: "Anlage R — Renten",
    hint: "Rentenbezugsmitteilungen der Deutschen Rentenversicherung, inländische private Rentenauszahlungen.",
  },
  {
    slug: "anlage-r-aus",
    group: "einkuenfte",
    name: "Anlage R-AUS — Ausländische Renten",
    hint: "Rentenmitteilungen/-auszahlungen aus dem Ausland.",
  },
  {
    slug: "anlage-r-av",
    group: "einkuenfte",
    name: "Anlage R-AV/bAV",
    hint: "Leistungen aus betrieblicher Altersvorsorge oder Riester-Auszahlungen.",
  },
  {
    slug: "anlage-g",
    group: "einkuenfte",
    name: "Anlage G — Gewerbe",
    hint: "Einkünfte aus Gewerbebetrieb, Bilanzen, Gewerbesteuerbescheid.",
  },
  {
    slug: "anlage-s",
    group: "einkuenfte",
    name: "Anlage S — Selbstständige Arbeit",
    hint: "Einkünfte aus freiberuflicher bzw. selbstständiger Tätigkeit.",
  },
  {
    slug: "anlage-euer",
    group: "einkuenfte",
    name: "Anlage EÜR",
    hint: "Einnahmen-Überschuss-Rechnung; gehört zu Anlage G oder Anlage S.",
  },
  {
    slug: "anlage-so",
    group: "einkuenfte",
    name: "Anlage SO — Sonstige Einkünfte",
    hint: "Private Veräußerungsgeschäfte, empfangener Unterhalt, gelegentliche Leistungen.",
  },

  // ─── Abzüge (mindern Steuer) ────────────────────────────────────────
  {
    slug: "werbungskosten-n",
    group: "abzuege",
    name: "Werbungskosten (Anlage N)",
    hint: "Arbeitnehmer-Werbungskosten: Fahrten zur Arbeit, Arbeitsmittel, Fortbildung, Reisekosten, Arbeitszimmer.",
  },
  {
    slug: "werbungskosten-v",
    group: "abzuege",
    name: "Werbungskosten (Anlage V)",
    hint: "Vermietungs-Werbungskosten: Reparaturen/Handwerker am Mietobjekt, Darlehenszinsen, Grundsteuer und Hausgeld der Mietimmobilie.",
  },
  {
    slug: "werbungskosten-kap",
    group: "abzuege",
    name: "Werbungskosten (Anlage KAP)",
    hint: "Werbungskosten rund um Kapitalanlagen (Sonderfälle jenseits des Sparerpauschbetrags).",
  },
  {
    slug: "werbungskosten-r",
    group: "abzuege",
    name: "Werbungskosten (Anlage R)",
    hint: "Werbungskosten rund um Renten, z. B. Rentenberatung.",
  },
  {
    slug: "sonderausgaben",
    group: "abzuege",
    name: "Sonderausgaben",
    hint: "Spendenquittungen, Kirchensteuernachweis, Unterhalt nach §10, Steuerberatungskosten.",
  },
  {
    slug: "vorsorgeaufwand",
    group: "abzuege",
    name: "Anlage Vorsorgeaufwand",
    hint: "Beiträge zu Kranken- und Pflegeversicherung, Rürup-Rente, Haftpflicht, Unfallversicherung.",
  },
  {
    slug: "anlage-av",
    group: "abzuege",
    name: "Anlage AV — Altersvorsorge (Riester)",
    hint: "Riester-Beitragsbescheinigung, Zulagenantrag.",
  },
  {
    slug: "aussergewoehnliche",
    group: "abzuege",
    name: "Außergewöhnliche Belastungen",
    hint: "Krankheitskosten, Zahnarzt, Rezepte/Medikamente, Brillen, Pflegeheim, Kur, Beerdigung.",
  },
  {
    slug: "haushaltsnahe",
    group: "abzuege",
    name: "Haushaltsnahe Aufwendungen / §35a",
    hint: "Rechnungen für Putzkraft, Gartenarbeit, Winterdienst, Handwerker (Lohnanteil) in der selbst genutzten Wohnung — nur mit Kontobeleg.",
  },
  {
    slug: "anlage-kind",
    group: "abzuege",
    name: "Anlage Kind",
    hint: "Geburtsurkunde, Kindergeldnachweis, Schul-/Studienbescheinigung, Kinderbetreuungskosten.",
  },
  {
    slug: "anlage-unterhalt",
    group: "abzuege",
    name: "Anlage Unterhalt",
    hint: "Unterhaltszahlungen an bedürftige Personen.",
  },
  {
    slug: "anlage-energetisch",
    group: "abzuege",
    name: "Energetische Maßnahmen §35c",
    hint: "Rechnung + Fachunternehmerbescheinigung über energetische Sanierung der selbst genutzten Immobilie.",
  },

  // ─── Bescheid ───────────────────────────────────────────────────────
  {
    slug: "steuerbescheid",
    group: "bescheid",
    name: "Steuerbescheid",
    hint: "Einkommensteuerbescheid oder Vorauszahlungsbescheid des Finanzamts.",
  },

  // ─── Rahmen / Stammdaten ────────────────────────────────────────────
  {
    slug: "mantelbogen",
    group: "rahmen",
    name: "Mantelbogen / Stammdaten",
    hint: "Stammdaten-Nachweise (Heiratsurkunde, Adressnachweis). Meist nicht einzureichen.",
  },
] as const;

export type TaxSectionSlug = typeof TAX_SECTIONS[number]["slug"];

const SLUGS: ReadonlySet<string> = new Set(TAX_SECTIONS.map((s) => s.slug));

export function isValidTaxSectionSlug(slug: unknown): slug is TaxSectionSlug {
  return typeof slug === "string" && SLUGS.has(slug);
}

export function findTaxSection(slug: string): TaxSection | undefined {
  return TAX_SECTIONS.find((s) => s.slug === slug);
}

export const TAX_SECTION_GROUP_ORDER: readonly TaxSectionGroup[] = [
  "einkuenfte",
  "abzuege",
  "bescheid",
  "rahmen",
];

/**
 * Return `TaxSection` metadata for the supplied slugs, in canonical order
 * (group order → declaration order inside a group). Invalid or duplicate
 * slugs are silently dropped so the frontend can pass whatever the DB
 * contains.
 */
export function orderTaxSectionSlugs(slugs: readonly string[]): TaxSection[] {
  const present = new Set<string>();
  for (const s of slugs) {
    if (typeof s !== "string") continue;
    const norm = s.trim().toLowerCase();
    if (isValidTaxSectionSlug(norm)) present.add(norm);
  }
  // TAX_SECTIONS is declared in canonical order (see file top), so a
  // simple filter preserves the ordering we want.
  return TAX_SECTIONS.filter((s) => present.has(s.slug));
}
