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
    hint: "Lohnsteuerbescheinigung, Gehaltsabrechnungen, Arbeitgeberbescheinigungen, Lohnersatzleistungen (Kurzarbeit, Elterngeld-Mitteilung). NICHT: Rentenbezugsmitteilungen, Honorarrechnungen, Dividendengutschriften, Wertpapierabrechnungen, Bank-/Broker-Mitteilungen, Kapitalertragsteuer-Abrechnungen (→ anlage-kap).",
  },
  {
    slug: "anlage-kap",
    group: "einkuenfte",
    name: "Anlage KAP — Kapitalerträge",
    hint: "Jahressteuerbescheinigung/Erträgnisaufstellung von Bank oder Broker (ING, DKB, Comdirect, Trade Republic, Scalable), Dividendengutschrift, Zins-/Dividenden-/Verlustbescheinigungen, Wertpapierabrechnungen (Kauf/Verkauf), Erträgnisaufstellungen. Auch Dokumente, die Kapitalertragsteuer (KESt), Solidaritätszuschlag oder Kirchensteuer im Kontext von Wertpapieren/Dividenden/Bank ausweisen, gehören hierher. NICHT in Anlage N.",
  },
  {
    slug: "anlage-v",
    group: "einkuenfte",
    name: "Anlage V — Vermietung & Verpachtung",
    hint: "Mieteinnahmen-Nachweise, Mietverträge, Nebenkostenabrechnungen an Mieter; nicht: Belege zu Werbungskosten am Mietobjekt (diese gehören zu werbungskosten-v); nicht: Verpachtung eines land-/forstwirtschaftlichen Betriebs oder land-/forstwirtschaftlicher Flächen (→ anlage-l).",
  },
  {
    slug: "anlage-r",
    group: "einkuenfte",
    name: "Anlage R — Renten",
    hint: "Rentenbezugsmitteilung der Deutschen Rentenversicherung, inländische gesetzliche/private Leibrenten, Versorgungswerk-Renten; nicht: Riester/bAV (anlage-r-av) oder Auslandsrenten (anlage-r-aus).",
  },
  {
    slug: "anlage-r-aus",
    group: "einkuenfte",
    name: "Anlage R-AUS — Ausländische Renten",
    hint: "Rentenmitteilungen/-auszahlungen ausländischer Versicherer oder Sozialversicherungen (z. B. AHV Schweiz, SVA Österreich, US Social Security); nicht: inländische Renten.",
  },
  {
    slug: "anlage-r-av",
    group: "einkuenfte",
    name: "Anlage R-AV/bAV",
    hint: "Leistungsmitteilung zu Riester-Auszahlungen oder betrieblicher Altersvorsorge (Pensionskasse, Pensionsfonds, Direktversicherung); nicht: Beitrags-/Zulagenbescheinigung während der Einzahlphase (anlage-av).",
  },
  {
    slug: "anlage-g",
    group: "einkuenfte",
    name: "Anlage G — Gewerbe",
    hint: "Einkünfte aus Gewerbebetrieb: Gewerbesteuerbescheid, Bilanz, Gewinn-/Verlustrechnung, Beteiligungsmitteilungen, Photovoltaik-Abrechnungen (Einspeisevergütung, Stromeinspeisung, kWp, Netzbetreiber-Abrechnung von z. B. Bayernwerk, E.ON, EnBW, Vattenfall). PV-Einspeiseabrechnungen sind IMMER steuerrelevant und gehören hierher; nicht: einzelne Ausgabenbelege des Betriebs bzw. der PV-Anlage (→ betriebsausgaben-g).",
  },
  {
    slug: "anlage-s",
    group: "einkuenfte",
    name: "Anlage S — Selbstständige Arbeit",
    hint: "Einkünfte aus freiberuflicher/selbstständiger Tätigkeit: ausgestellte Honorarrechnungen, Gewinnermittlung von Ärzten, Anwälten, Künstlern, IT-Freelancern.",
  },
  {
    slug: "anlage-l",
    group: "einkuenfte",
    name: "Anlage L — Land- und Forstwirtschaft",
    hint: "Einkünfte aus Land- und Forstwirtschaft (§13 EStG): Pachteinnahmen und Pachtverträge für verpachtete land-/forstwirtschaftliche Flächen oder Betriebe, Gewinnermittlung/EÜR der Land- und Forstwirtschaft; nicht: einzelne Ausgabenbelege des Betriebs (→ betriebsausgaben-l), nicht: Vermietung/Verpachtung von Wohn-/Gewerbeimmobilien (→ anlage-v), nicht: Gewerbebetrieb (→ anlage-g).",
  },
  {
    slug: "anlage-euer",
    group: "einkuenfte",
    name: "Anlage EÜR",
    hint: "Formular Einnahmen-Überschuss-Rechnung (EÜR) zur Gewinnermittlung; gehört als Anhang zu Anlage G, Anlage S oder Anlage L.",
  },
  {
    slug: "anlage-so",
    group: "einkuenfte",
    name: "Anlage SO — Sonstige Einkünfte",
    hint: "Sonstige Einkünfte: private Veräußerungsgeschäfte (Immobilien <10 J., Krypto <1 J.), empfangener Unterhalt vom Ex-Partner (Realsplitting), gelegentliche Leistungen.",
  },

  // ─── Abzüge (mindern Steuer) ────────────────────────────────────────
  {
    slug: "werbungskosten-n",
    group: "abzuege",
    name: "Werbungskosten (Anlage N)",
    hint: "Arbeitnehmer-Werbungskosten: Fahrtenbuch/Pendler, Arbeitsmittel (PC, Literatur), Fortbildungsrechnungen, Reisekostenabrechnung, Arbeitszimmer, Gewerkschaftsbeitrag. NICHT: Handwerkerrechnungen für die Privatwohnung (→ haushaltsnahe) — es sei denn, die Rechnung betrifft explizit das häusliche Arbeitszimmer.",
  },
  {
    slug: "werbungskosten-v",
    group: "abzuege",
    name: "Werbungskosten (Anlage V)",
    hint: "Werbungskosten am Mietobjekt: Handwerker-/Reparaturrechnungen, Darlehenszinsbescheinigung, Grundsteuerbescheid, Hausgeldabrechnung, Verwaltergebühr; nicht: Rechnungen für die selbst bewohnte Immobilie.",
  },
  {
    slug: "werbungskosten-kap",
    group: "abzuege",
    name: "Werbungskosten (Anlage KAP)",
    hint: "Seltene Werbungskosten zu Kapitalanlagen jenseits des Sparerpauschbetrags, z. B. Schuldzinsen bei Teileinkünfteverfahren/unternehmerischer Beteiligung.",
  },
  {
    slug: "werbungskosten-r",
    group: "abzuege",
    name: "Werbungskosten (Anlage R)",
    hint: "Werbungskosten rund um Renteneinkünfte, z. B. Rechnung eines Rentenberaters, Prozesskosten gegen Rentenversicherung, Fahrten zur Rentenberatung.",
  },
  {
    slug: "betriebsausgaben-l",
    group: "abzuege",
    name: "Betriebsausgaben (Anlage L)",
    hint: "Ausgabenbelege des land- und forstwirtschaftlichen Betriebs (§13 EStG), die in die Gewinnermittlung/EÜR eingehen: Reparatur-, Wartungs- und Werkstattrechnungen für Landmaschinen (Traktor, Schlepper, Mähdrescher, Anbaugeräte) sowie für Betriebsgebäude (Scheune, Stall, Maschinenhalle), Ersatzteile, Betriebsmittel (Diesel, Saatgut, Dünger, Futter), Beiträge zur landwirtschaftlichen Berufsgenossenschaft (SVLFG), Versicherungen des Betriebs, gezahlte Pacht. NICHT: Handwerkerrechnung am selbst bewohnten Haus (→ haushaltsnahe), NICHT: Rechnung am vermieteten Wohnobjekt (→ werbungskosten-v), NICHT: Werkstattrechnung für den privaten PKW (nicht steuerrelevant).",
  },
  {
    slug: "betriebsausgaben-g",
    group: "abzuege",
    name: "Betriebsausgaben (Anlage G)",
    hint: "Ausgabenbelege eines Gewerbebetriebs, die in die Gewinnermittlung/EÜR eingehen — insbesondere rund um eine Photovoltaik-Anlage: Wartung und Reparatur der Anlage, Wechselrichter-Tausch, Zählermiete/Messstellenbetrieb, Versicherung der PV-Anlage, Finanzierungszinsen der Anlage. NICHT: Einspeise-/EEG-Abrechnung des Netzbetreibers (→ anlage-g), NICHT: Stromrechnung für den privaten Eigenverbrauch (nicht steuerrelevant), NICHT: land-/forstwirtschaftliche Betriebsausgaben (→ betriebsausgaben-l).",
  },
  {
    slug: "sonderausgaben",
    group: "abzuege",
    name: "Sonderausgaben",
    hint: "Spendenquittung/Zuwendungsbestätigung, Kirchensteuerbescheid/-bescheinigung (z. B. Kath./Ev. Kirchensteueramt), Steuerberaterrechnung, gezahlter Unterhalt (Realsplitting, Anlage U); nicht: Versicherungsbeiträge (vorsorgeaufwand).",
  },
  {
    slug: "vorsorgeaufwand",
    group: "abzuege",
    name: "Anlage Vorsorgeaufwand",
    hint: "Beitragsbescheinigungen/Beitragsrechnungen zu Personenversicherungen: private Kranken- und Pflegeversicherung (z. B. HALLESCHE, DKV), gesetzliche Krankenkasse, Haftpflicht-, Unfall-, Risikolebens- und Rürup-/Basisrenten-Versicherung; nicht: Sachversicherungen (Wohngebäude-, Hausrat-, Kfz-Kasko, Rechtsschutz), Riester (anlage-av) oder Krankheitsrechnungen (aussergewoehnliche).",
  },
  {
    slug: "anlage-av",
    group: "abzuege",
    name: "Anlage AV — Altersvorsorge (Riester)",
    hint: "Riester-Beitragsbescheinigung nach §92 EStG, Zulagenantrag/-bescheid der ZfA (Beitragsphase); nicht: Auszahlungsmitteilung (anlage-r-av).",
  },
  {
    slug: "aussergewoehnliche",
    group: "abzuege",
    name: "Außergewöhnliche Belastungen",
    hint: "Selbst getragene Krankheitskosten: privatärztliche/zahnärztliche Liquidation (GOÄ/GOZ), Rezeptgebühren, Brille/Hörgerät, Pflegeheim-/Pflegekosten, Kur, Beerdigungskosten; nicht: laufende Versicherungsbeiträge (vorsorgeaufwand).",
  },
  {
    slug: "haushaltsnahe",
    group: "abzuege",
    name: "Haushaltsnahe Aufwendungen / §35a",
    hint: "Lohnanteil von Leistungen für die selbst bewohnte Wohnung / das eigene Haus: Handwerker (Maler, Sanitär, Elektriker, Heizungsbauer, Haustechnik, Dachdecker, Schreiner, Fliesenleger), Schornsteinfeger, Gärtner, Winterdienst, Putzkraft, Haushaltshilfe sowie haushaltsnahe Dienstleistungen wie ambulante Pflege/Sozialstation (z. B. Caritas). Immer mit Überweisung (kein Bargeld). Rechnungen mit ausgewiesenem 'absetzbarem Anteil nach §35a EStG' gehören IMMER hierher. Nicht: Mietobjekt (→ werbungskosten-v), nicht: Arbeitszimmer-Renovierung des Arbeitnehmers (→ werbungskosten-n).",
  },
  {
    slug: "anlage-kind",
    group: "abzuege",
    name: "Anlage Kind",
    hint: "Unterlagen pro Kind: Geburtsurkunde, Kindergeldbescheid/Familienkasse, Schul-/Studien-/Ausbildungsbescheinigung, Kita-/Hort-Rechnung mit Überweisungsnachweis.",
  },
  {
    slug: "anlage-unterhalt",
    group: "abzuege",
    name: "Anlage Unterhalt",
    hint: "Nachweise über Unterhaltszahlungen an bedürftige Angehörige nach §33a EStG (Eltern, volljährige Kinder ohne Kindergeldanspruch), inkl. Bedürftigkeitsnachweis.",
  },
  {
    slug: "anlage-energetisch",
    group: "abzuege",
    name: "Energetische Maßnahmen §35c",
    hint: "Handwerkerrechnung plus amtliche Fachunternehmerbescheinigung nach §35c EStG über Dämmung, Fenster, Heizung, Lüftung der selbst genutzten Immobilie.",
  },

  // ─── Bescheid ───────────────────────────────────────────────────────
  {
    slug: "steuerbescheid",
    group: "bescheid",
    name: "Steuerbescheid",
    hint: "Einkommensteuerbescheid des Finanzamts (Ergebnis der Steuererklärung): Finanzamt-Briefkopf, Steuernummer/Identifikationsnummer, Wortlaut „Bescheid für 20XX über Einkommensteuer…\", Festsetzungstabelle mit festgesetzter Einkommensteuer, Solidaritätszuschlag und Kirchensteuer sowie ausgewiesener Erstattung/Nachzahlung; auch Vorauszahlungsbescheid zur Einkommensteuer. NICHT: Grundsteuer-, Gewerbesteuer- oder sonstige kommunale Abgabenbescheide (Stadt/Gemeinde/Landratsamt), Gerichts-/Amtsgerichtsbescheide, einzelne Kirchensteuerbescheinigungen.",
  },

  // ─── Rahmen / Stammdaten ────────────────────────────────────────────
  {
    slug: "mantelbogen",
    group: "rahmen",
    name: "Mantelbogen / Stammdaten",
    hint: "Stammdaten-Nachweise zur Person: Heiratsurkunde, Scheidungsurteil, Meldebescheinigung, Behindertenausweis; meist nicht einzureichen.",
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
