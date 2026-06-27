// Starter taxonomy for private household document management.
// Loaded by db/seed.ts into the `document_categories` table and sent to the
// LLM classifier as the available label set. Heuristic set — meant to evolve
// through the AI suggestion loop (see document_category_suggestions table).

export interface CategorySeed {
  slug: string;
  name: string;
  icon?: string;
  // Optional one-line hint sent to the LLM classifier alongside slug + name
  // to disambiguate borderline documents (e.g. a dividend tax statement that
  // is heavy on tax vocabulary but belongs with the securities documents).
  hint?: string;
  children?: CategorySeed[];
}

export const categoryTaxonomy: CategorySeed[] = [
  {
    slug: "finanzen",
    name: "Finanzen",
    icon: "pi-euro",
    children: [
      {
        slug: "finanzen-kontoauszuege",
        name: "Kontoauszüge",
        hint: "Kontoauszüge und Rechnungsabschlüsse von Giro-, Tagesgeld- oder Darlehenskonten (z. B. MLP, Commerzbank).",
      },
      {
        slug: "finanzen-gehalt",
        name: "Gehaltsabrechnungen",
        hint: "Monatliche Entgelt-/Gehalts-/Lohnabrechnung, Verdienstbescheinigung, Lohnsteuerbescheinigung — ausgestellt vom Arbeitgeber (z. B. Contoso Software, Contoso). NICHT als allgemeine Rechnung einordnen. NICHT: jährliche Meldung/Entgeltnachweis zur Sozialversicherung (→ finanzen-sozialversicherung). Steuerlich Anlage N.",
      },
      {
        slug: "finanzen-sozialversicherung",
        name: "Meldung zur Sozialversicherung",
        hint: "Meldebescheinigung bzw. Entgeltnachweis/Jahresmeldung zur Sozialversicherung nach DEÜV — vom Arbeitgeber ausgestellter Nachweis der gemeldeten SV-Entgelte (Renten-, Kranken-, Pflege-, Arbeitslosenversicherung). NICHT die monatliche Gehaltsabrechnung (→ finanzen-gehalt). „Sozialversicherung\" NICHT mit „Sozialstation\" verwechseln: Pflegeleistungen einer Sozialstation gehören zu gesundheit-pflege.",
      },
      {
        slug: "finanzen-bausparen",
        name: "Bausparen",
        hint: "Bausparverträge: Kontoauszüge, Jahresmeldungen, Zuteilungsmitteilungen (z. B. Wüstenrot Bausparkasse).",
      },
      {
        slug: "finanzen-rechnungen",
        name: "Rechnungen",
        hint: "Sammelkategorie — NUR wählen, wenn keine spezifischere Kategorie und kein bekannter Absender passt. NICHT für: Gehaltsabrechnungen (finanzen-gehalt), Arzt-/Zahnarztrechnungen (gesundheit-arzt), Pflege (gesundheit-pflege), Versicherungsbeiträge (versicherungen-*, altersvorsorge-*), Renten (altersvorsorge-gesetzlich), Steuerbescheide (behoerden-steuerbescheid), Kirchensteuer (finanzen-kirchensteuer).",
      },
      {
        slug: "finanzen-wertpapiere",
        name: "Wertpapiere & Dividenden",
        hint: "Dividendengutschriften, Steuermitteilungen / steuerliche Behandlung zu Wertpapieren (auch 'KEINE STEUERBESCHEINIGUNG'), Erträgnisaufstellungen, Depot- und Wertpapierabrechnungen (Kauf/Verkauf) von Bank oder Broker (z. B. Comdirect). Steuerlich Anlage KAP. NICHT: Einspeisevergütungs-Abrechnungen / Stromeinspeisung von Netzbetreibern für PV-Anlagen (→ wohnen-haus-photovoltaik).",
      },
      {
        slug: "finanzen-steuern",
        name: "Steuern",
        hint: "Allgemeine Steuerunterlagen: Steuererklärung, Korrespondenz mit dem Finanzamt/Steuerberater. NICHT für Wertpapier-/Dividenden-Steuermitteilungen (siehe finanzen-wertpapiere), Steuerbescheide (siehe behoerden-steuerbescheid) oder Kirchensteuer (finanzen-kirchensteuer).",
      },
      {
        slug: "finanzen-kirchensteuer",
        name: "Kirchensteuer",
        hint: "Kirchensteuerbescheid, Kirchensteuer-Festsetzung/-Erstattung (z. B. Katholisches/Evangelisches Kirchensteueramt). Steuerlich Sonderausgaben.",
      },
      {
        slug: "finanzen-spenden",
        name: "Spenden & Zuwendungen",
        hint: "Spendenquittungen, Zuwendungsbestätigungen und Sammelbestätigungen gemeinnütziger Organisationen (z. B. UNICEF, Deutsches Rotes Kreuz, Caritas). Steuerlich Sonderausgaben. NICHT: Meldungen oder Entgeltnachweise zur Sozialversicherung (→ finanzen-sozialversicherung).",
      },
    ],
  },
  {
    slug: "wohnen",
    name: "Wohnen",
    icon: "pi-home",
    children: [
      { slug: "wohnen-miete", name: "Miete" },
      { slug: "wohnen-nebenkosten", name: "Nebenkosten" },
      {
        slug: "wohnen-kommunale-abgaben",
        name: "Kommunale Abgaben",
        hint: "Kommunale Gebührenbescheide: Wasser/Abwasser, Müll/Abfall, Straßenreinigung, Benutzungsgebühren (Gemeinde/Stadt).",
      },
      {
        slug: "wohnen-versicherung",
        name: "Versicherungen",
        hint: "Wohngebäude- und Hausratversicherung zur selbst bewohnten Wohnung.",
      },
      {
        slug: "wohnen-haus",
        name: "Haus & Grund",
        children: [
          { slug: "wohnen-haus-eigentuemerversammlung", name: "Eigentümerversammlung" },
          { slug: "wohnen-haus-hausgeld", name: "Wirtschaftsplan / Hausgeld" },
          { slug: "wohnen-haus-weg-jahresabrechnung", name: "WEG-Jahresabrechnung" },
          { slug: "wohnen-haus-grundsteuer", name: "Grundsteuer" },
          { slug: "wohnen-haus-gebaeudeversicherung", name: "Gebäudeversicherung" },
          { slug: "wohnen-haus-instandhaltung", name: "Instandhaltung / Handwerker" },
          { slug: "wohnen-haus-finanzierung", name: "Finanzierung / Darlehen" },
          { slug: "wohnen-haus-kaufvertrag", name: "Kaufvertrag / Grundbuch" },
          {
            slug: "wohnen-haus-photovoltaik",
            name: "Photovoltaik",
            hint: "Einspeisevergütungs-Abrechnungen eines Netzbetreibers (Bayernwerk, E.ON, EnBW, Vattenfall u. a.), EEG-Abrechnungen, Stromeinspeisung, Erzeugungsanlage, kWp, Abschlagszahlungen für PV-Einspeisung, Inbetriebnahme-Protokolle, Anmeldung beim Marktstammdatenregister. NICHT: Stromlieferverträge oder Stromrechnungen für den Eigenverbrauch (→ vertraege-strom).",
          },
        ],
      },
    ],
  },
  {
    slug: "kapitalanlage-immobilie",
    name: "Kapitalanlage Immobilie",
    icon: "pi-key",
    children: [
      { slug: "kapitalanlage-immobilie-mietvertrag", name: "Mietvertrag" },
      { slug: "kapitalanlage-immobilie-mieteingaenge", name: "Mieteingänge" },
      { slug: "kapitalanlage-immobilie-nebenkostenabrechnung", name: "Nebenkostenabrechnung" },
      { slug: "kapitalanlage-immobilie-eigentuemerversammlung", name: "Eigentümerversammlung" },
      { slug: "kapitalanlage-immobilie-hausgeld", name: "Wirtschaftsplan / Hausgeld" },
      { slug: "kapitalanlage-immobilie-weg-jahresabrechnung", name: "WEG-Jahresabrechnung" },
      { slug: "kapitalanlage-immobilie-grundsteuer", name: "Grundsteuer" },
      { slug: "kapitalanlage-immobilie-gebaeudeversicherung", name: "Gebäudeversicherung" },
      { slug: "kapitalanlage-immobilie-instandhaltung", name: "Instandhaltung / Handwerker" },
      { slug: "kapitalanlage-immobilie-finanzierung", name: "Finanzierung / Darlehen" },
      { slug: "kapitalanlage-immobilie-kaufvertrag", name: "Kaufvertrag / Grundbuch" },
      { slug: "kapitalanlage-immobilie-anlage-v", name: "Steuer — Anlage V" },
    ],
  },
  {
    slug: "altersvorsorge",
    name: "Altersvorsorge",
    icon: "pi-shield",
    children: [
      {
        slug: "altersvorsorge-lebensversicherung",
        name: "Kapital-Lebensversicherung",
        hint: "Kapital-Lebensversicherung: Kostenbescheinigungen, Statusreports, Leistungsübersichten, Beitrags-/Wertmitteilungen (z. B. Heidelberger Leben, AXA Lebensversicherung).",
      },
      { slug: "altersvorsorge-rentenversicherung", name: "Private Rentenversicherung (inkl. Riester/Rürup)" },
      { slug: "altersvorsorge-betrieblich", name: "Betriebliche Altersvorsorge (bAV)" },
      {
        slug: "altersvorsorge-gesetzlich",
        name: "Gesetzliche Rente (DRV)",
        hint: "Renteninformation, Rentenbescheid, Rentenanpassungsmitteilung, Renten(bezugs)mitteilung der Deutschen Rentenversicherung (DRV).",
      },
    ],
  },
  {
    slug: "gesundheit",
    name: "Gesundheit",
    icon: "pi-heart",
    children: [
      {
        slug: "gesundheit-arzt",
        name: "Arztrechnungen",
        hint: "Privatärztliche/zahnärztliche Rechnungen (GOÄ/GOZ), Liquidationen niedergelassener Ärzte/Zahnärzte, Heil- und Kostenpläne. Steuerlich außergewöhnliche Belastungen (Krankheitskosten).",
      },
      { slug: "gesundheit-rezepte", name: "Rezepte" },
      {
        slug: "gesundheit-kasse",
        name: "Krankenkasse",
        hint: "Gesetzliche Krankenkasse (z. B. AOK, Techniker, Barmer): Mitgliedsbescheinigungen, Kostenübernahmen, Bescheide. NICHT private Krankenversicherung (versicherungen-kranken).",
      },
      {
        slug: "gesundheit-pflege",
        name: "Pflegeleistungen (Sozialstation)",
        hint: "Rechnungen/Leistungsnachweise ambulanter Pflege/Sozialstationen (z. B. Caritas-Sozialstation), häusliche Krankenpflege. NICHT: Meldung/Entgeltnachweis zur Sozialversicherung vom Arbeitgeber (→ finanzen-sozialversicherung) — „Sozialstation\" ≠ „Sozialversicherung\". Steuerlich haushaltsnahe Aufwendungen / außergewöhnliche Belastungen.",
      },
      { slug: "gesundheit-pflegekasse", name: "Pflegekasse" },
    ],
  },
  {
    slug: "fahrzeug",
    name: "Fahrzeug",
    icon: "pi-car",
    children: [
      { slug: "fahrzeug-papiere", name: "Kfz-Papiere" },
      { slug: "fahrzeug-tuev", name: "TÜV / Hauptuntersuchung" },
      { slug: "fahrzeug-werkstatt", name: "Werkstatt" },
    ],
  },
  {
    slug: "vertraege",
    name: "Verträge",
    icon: "pi-file-edit",
    children: [
      {
        slug: "vertraege-telekom",
        name: "Telekommunikation",
        hint: "Telefon, Internet, Mobilfunk, Kabel (z. B. Telekom, Vodafone, LEW TelNet).",
      },
      { slug: "vertraege-strom", name: "Strom" },
      { slug: "vertraege-gas", name: "Gas" },
      {
        slug: "vertraege-abos",
        name: "Abonnements",
        hint: "Mitgliedschaften und Abos: Fitnessstudio, Vereine, Streaming, Zeitschriften (z. B. Clever Fit).",
      },
    ],
  },
  {
    slug: "versicherungen",
    name: "Versicherungen",
    icon: "pi-shield",
    hint: "Personen- und Sachversicherungen, die nicht zu Wohnen, Fahrzeug oder Altersvorsorge gehören.",
    children: [
      {
        slug: "versicherungen-kranken",
        name: "Private Kranken-/Zusatzversicherung",
        hint: "Private Kranken-, Pflege- und Krankenzusatzversicherung: Beitragsrechnungen, Beitragsanpassungen, Beitragsbescheinigungen, Leistungsabrechnungen (z. B. HALLESCHE, DKV). Steuerlich Vorsorgeaufwand. NICHT gesetzliche Krankenkasse (gesundheit-kasse).",
      },
      {
        slug: "versicherungen-sach",
        name: "Sach- & Haftpflichtversicherung",
        hint: "Haftpflicht-, Hausrat-, Rechtsschutz-, Unfallversicherung: Beiträge, Policen, Schadenfälle (z. B. Privatschutz; Makler wie Marsh, HVS). NICHT Wohngebäude (wohnen-versicherung) oder Kfz (fahrzeug).",
      },
    ],
  },
  {
    slug: "beruf",
    name: "Beruf",
    icon: "pi-briefcase",
    children: [
      { slug: "beruf-arbeitsvertrag", name: "Arbeitsvertrag" },
      { slug: "beruf-zeugnisse", name: "Arbeitszeugnisse" },
    ],
  },
  {
    slug: "familie",
    name: "Familie",
    icon: "pi-users",
    children: [
      { slug: "familie-urkunden", name: "Urkunden" },
      { slug: "familie-ausweise", name: "Ausweise" },
      {
        slug: "familie-schule",
        name: "Schule",
        hint: "Schul-Korrespondenz: Elternbriefe, Anmeldungen, Klassenfahrten (z. B. Gymnasium).",
      },
    ],
  },
  {
    slug: "behoerden",
    name: "Behörden",
    icon: "pi-building",
    children: [
      { slug: "behoerden-bescheide", name: "Bescheide" },
      {
        slug: "behoerden-steuerbescheid",
        name: "Steuerbescheide",
        hint: "Einkommensteuerbescheid/-bescheinigung, Vorauszahlungsbescheid vom Finanzamt. NICHT Lohnsteuerbescheinigung (finanzen-gehalt) oder Kirchensteuerbescheid (finanzen-kirchensteuer).",
      },
    ],
  },
  {
    slug: "betreuung",
    name: "Rechtliche Betreuung",
    icon: "pi-id-card",
    children: [
      { slug: "betreuung-bestellung", name: "Bestellungsurkunde / Betreuerausweis" },
      { slug: "betreuung-rechenschaftsbericht", name: "Rechenschaftsbericht" },
      { slug: "betreuung-vermoegensverzeichnis", name: "Vermögensverzeichnis" },
      { slug: "betreuung-genehmigung", name: "Gerichtliche Genehmigung" },
      { slug: "betreuung-korrespondenz", name: "Korrespondenz Betreuungsgericht" },
    ],
  },
  {
    slug: "bildung",
    name: "Bildung",
    icon: "pi-graduation-cap",
    children: [
      { slug: "bildung-zeugnisse", name: "Zeugnisse" },
      { slug: "bildung-zertifikate", name: "Zertifikate" },
    ],
  },
  {
    slug: "belege",
    name: "Belege",
    icon: "pi-receipt",
    hint: "Kassenbons / Kaufbelege / Quittungen aus dem Einzelhandel (Supermarkt, Drogerie, Tankstelle, Restaurant), typischerweise per Foto erfasst und an eine Bargeldbuchung gehängt. NICHT für förmliche Rechnungen mit Briefkopf (→ finanzen-rechnungen) oder Arzt-/Handwerkerrechnungen.",
  },
  {
    slug: "sonstiges",
    name: "Sonstiges",
    icon: "pi-file",
  },
];

export function flattenTaxonomy(
  nodes: CategorySeed[] = categoryTaxonomy,
  parentSlug: string | null = null,
): Array<{ slug: string; name: string; icon: string | null; hint: string | null; parent_slug: string | null; sort_order: number }> {
  const out: Array<{ slug: string; name: string; icon: string | null; hint: string | null; parent_slug: string | null; sort_order: number }> = [];
  nodes.forEach((node, idx) => {
    out.push({
      slug: node.slug,
      name: node.name,
      icon: node.icon ?? null,
      hint: node.hint ?? null,
      parent_slug: parentSlug,
      sort_order: idx,
    });
    if (node.children?.length) {
      out.push(...flattenTaxonomy(node.children, node.slug));
    }
  });
  return out;
}

/** Slug → classifier hint, derived from the seed taxonomy. Used to enrich
 *  the DB-loaded category list at classify time without a DB column. */
export function taxonomyHints(
  nodes: CategorySeed[] = categoryTaxonomy,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) {
    if (node.hint) out.set(node.slug, node.hint);
    if (node.children?.length) {
      for (const [slug, hint] of taxonomyHints(node.children)) out.set(slug, hint);
    }
  }
  return out;
}
