/**
 * Form fields for the tax year 2025.
 *
 * Lines and Kennzahlen are not filled in yet: they have to be copied from
 * the official 2025 Vordrucke, which this catalogue was written without.
 * Until then every entry has `line: null`, `kennzahl: null`, `source: null`,
 * and the worksheet prints "Kennzahl prüfen". Labels follow the wording of
 * the forms; check them along with the Kennzahl.
 */

import type { FormField } from "./catalogue";

type Entry = Omit<FormField, "line" | "kennzahl" | "source">;

const unchecked = (e: Entry): FormField => ({ ...e, line: null, kennzahl: null, source: null });

const ENTRIES: readonly Entry[] = [
  // ── Anlage N ───────────────────────────────────────────────────────────
  { key: "n.bruttoarbeitslohn", anlage: "anlage-n", label: "Bruttoarbeitslohn", kind: "amount", scope: "person", prefilled: true },
  { key: "n.lohnsteuer", anlage: "anlage-n", label: "Lohnsteuer", kind: "amount", scope: "person", prefilled: true },
  { key: "n.solidaritaetszuschlag", anlage: "anlage-n", label: "Solidaritätszuschlag", kind: "amount", scope: "person", prefilled: true },
  { key: "n.kirchensteuer", anlage: "anlage-n", label: "Kirchensteuer des Arbeitnehmers", kind: "amount", scope: "person", prefilled: true },
  { key: "werbungskosten.arbeitsmittel", anlage: "werbungskosten-n", label: "Arbeitsmittel", kind: "amount", scope: "person", prefilled: false },
  { key: "werbungskosten.fortbildung", anlage: "werbungskosten-n", label: "Fortbildungskosten", kind: "amount", scope: "person", prefilled: false },
  { key: "werbungskosten.sonstige", anlage: "werbungskosten-n", label: "Weitere Werbungskosten", kind: "amount", scope: "person", prefilled: false },

  // ── Anlage Vorsorgeaufwand ─────────────────────────────────────────────
  { key: "vorsorge.rv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.rv_arbeitgeber", anlage: "vorsorgeaufwand", label: "Arbeitgeberanteil zur gesetzlichen Rentenversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.kv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.pv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur sozialen Pflegeversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.av_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur Arbeitslosenversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.kv_basis_privat", anlage: "vorsorgeaufwand", label: "Beiträge zur privaten Kranken-Basisabsicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.pv_privat", anlage: "vorsorgeaufwand", label: "Beiträge zur privaten Pflege-Pflichtversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.kv_wahlleistungen", anlage: "vorsorgeaufwand", label: "Beiträge für Wahlleistungen und Zusatzversicherungen", kind: "amount", scope: "person", prefilled: false },
  { key: "vorsorge.kv_erstattungen", anlage: "vorsorgeaufwand", label: "Erstattete Beiträge zur Kranken- und Pflegeversicherung", kind: "amount", scope: "person", prefilled: true },
  { key: "vorsorge.basisrente", anlage: "vorsorgeaufwand", label: "Beiträge zu eigenen Basisrentenverträgen", kind: "amount", scope: "person", prefilled: true },

  // ── Anlage KAP ─────────────────────────────────────────────────────────
  { key: "kap.ertraege", anlage: "anlage-kap", label: "Kapitalerträge, die dem inländischen Steuerabzug unterlegen haben", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.gewinne_aktien", anlage: "anlage-kap", label: "In den Kapitalerträgen enthaltene Gewinne aus Aktienveräußerungen", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.verluste_aktien", anlage: "anlage-kap", label: "Nicht ausgeglichene Verluste aus der Veräußerung von Aktien", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.verluste_sonstige", anlage: "anlage-kap", label: "Nicht ausgeglichene Verluste ohne Verluste aus Aktienveräußerungen", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.sparer_pauschbetrag", anlage: "anlage-kap", label: "In Anspruch genommener Sparer-Pauschbetrag", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.kapitalertragsteuer", anlage: "anlage-kap", label: "Kapitalertragsteuer", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.solidaritaetszuschlag", anlage: "anlage-kap", label: "Solidaritätszuschlag", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.kirchensteuer", anlage: "anlage-kap", label: "Kirchensteuer zur Kapitalertragsteuer", kind: "amount", scope: "person", prefilled: false },
  { key: "kap.auslaendische_steuer", anlage: "anlage-kap", label: "Anrechenbare noch nicht angerechnete ausländische Steuern", kind: "amount", scope: "person", prefilled: false },

  // ── Anlage R / AV ──────────────────────────────────────────────────────
  { key: "r.rente_jahresbetrag", anlage: "anlage-r", label: "Rentenbetrag (Jahresbetrag der Rente)", kind: "amount", scope: "person", prefilled: true },
  { key: "av.altersvorsorgebeitraege", anlage: "anlage-av", label: "Altersvorsorgebeiträge (Riester)", kind: "amount", scope: "person", prefilled: true },

  // ── Sonderausgaben ─────────────────────────────────────────────────────
  { key: "sonder.kirchensteuer_gezahlt", anlage: "sonderausgaben", label: "Gezahlte Kirchensteuer", kind: "amount", scope: "person", prefilled: false },
  { key: "sonder.kirchensteuer_erstattet", anlage: "sonderausgaben", label: "Erstattete Kirchensteuer", kind: "amount", scope: "person", prefilled: false },
  { key: "sonder.spenden", anlage: "sonderausgaben", label: "Zuwendungen an steuerbegünstigte Organisationen", kind: "amount", scope: "return", prefilled: false },
  { key: "sonder.spenden_parteien", anlage: "sonderausgaben", label: "Zuwendungen an politische Parteien", kind: "amount", scope: "return", prefilled: false },

  // ── Haushaltsnahe Aufwendungen (§ 35a EStG) ────────────────────────────
  { key: "haushaltsnahe.dienstleistungen", anlage: "haushaltsnahe", label: "Haushaltsnahe Dienstleistungen (Aufwendungen)", kind: "amount", scope: "return", prefilled: false },
  { key: "haushaltsnahe.handwerker", anlage: "haushaltsnahe", label: "Handwerkerleistungen (Arbeits-, Fahrt- und Maschinenkosten)", kind: "amount", scope: "return", prefilled: false },

  // ── Außergewöhnliche Belastungen ───────────────────────────────────────
  { key: "agb.krankheitskosten", anlage: "aussergewoehnliche", label: "Krankheitskosten", kind: "amount", scope: "return", prefilled: false },
  { key: "agb.krankheitskosten_erstattung", anlage: "aussergewoehnliche", label: "Erhaltene oder zu erwartende Erstattungen zu Krankheitskosten", kind: "amount", scope: "return", prefilled: false },
  { key: "agb.pflegekosten", anlage: "aussergewoehnliche", label: "Pflegekosten", kind: "amount", scope: "return", prefilled: false },

  // ── Anlage Kind ────────────────────────────────────────────────────────
  { key: "kind.betreuungskosten", anlage: "anlage-kind", label: "Kinderbetreuungskosten", kind: "amount", scope: "child", prefilled: false },
  { key: "kind.schulgeld", anlage: "anlage-kind", label: "Schulgeld", kind: "amount", scope: "child", prefilled: false },

  // ── Anlage V ───────────────────────────────────────────────────────────
  { key: "v.mieteinnahmen", anlage: "anlage-v", label: "Mieteinnahmen", kind: "amount", scope: "property", prefilled: false },
  { key: "v.umlagen", anlage: "anlage-v", label: "Vereinnahmte Umlagen", kind: "amount", scope: "property", prefilled: false },
  { key: "werbungskosten_v.schuldzinsen", anlage: "werbungskosten-v", label: "Schuldzinsen", kind: "amount", scope: "property", prefilled: false },
  { key: "werbungskosten_v.erhaltung", anlage: "werbungskosten-v", label: "Erhaltungsaufwendungen", kind: "amount", scope: "property", prefilled: false },
  { key: "werbungskosten_v.grundsteuer", anlage: "werbungskosten-v", label: "Grundsteuer", kind: "amount", scope: "property", prefilled: false },
  { key: "werbungskosten_v.versicherungen", anlage: "werbungskosten-v", label: "Versicherungen", kind: "amount", scope: "property", prefilled: false },
  { key: "werbungskosten_v.verwaltung", anlage: "werbungskosten-v", label: "Verwaltungskosten", kind: "amount", scope: "property", prefilled: false },
];

export const FORM_FIELDS_2025: readonly FormField[] = ENTRIES.map(unchecked);
