// Starter taxonomy for private household document management.
// Loaded by db/seed.ts into the `document_categories` table and sent to the
// LLM classifier as the available label set. Heuristic set — meant to evolve
// through the AI suggestion loop (see document_category_suggestions table).

export interface FilesystemGroupingConfig {
  source: "subject_person";
  /** Folder used when this category requires a person but none is linked. */
  missingSegment?: string;
  /** Folder used when more than one distinct person is linked. */
  multipleSegment?: string;
}

export interface CategorySeed {
  slug: string;
  name: string;
  icon?: string;
  // Optional one-line hint sent to the LLM classifier alongside slug + name
  // to disambiguate borderline documents (e.g. a dividend tax statement that
  // is heavy on tax vocabulary but belongs with the securities documents).
  hint?: string;
  /** Optional extra filesystem dimension inserted directly below this category. */
  filesystemGrouping?: FilesystemGroupingConfig;
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
        hint: "Monatliche Entgelt-/Gehalts-/Lohnabrechnung, Verdienstbescheinigung, Lohnsteuerbescheinigung — ausgestellt vom Arbeitgeber (z. B. Open Text Software, IXOS). NICHT als allgemeine Rechnung einordnen. NICHT: jährliche Meldung/Entgeltnachweis zur Sozialversicherung (→ finanzen-sozialversicherung). Steuerlich Anlage N.",
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
        hint: "Allgemeine Steuerunterlagen: Einkommensteuererklärung (Mantelbogen, Anlagen), Fragebogen zur steuerlichen Erfassung, W-8BEN, Korrespondenz mit dem Finanzamt/Steuerberater. NICHT für Wertpapier-/Dividenden-Steuermitteilungen (→ finanzen-wertpapiere), Steuerbescheide (→ behoerden-steuerbescheid), Kirchensteuer (→ finanzen-kirchensteuer) oder Spendenquittungen (→ finanzen-spenden).",
      },
      {
        slug: "finanzen-kirchensteuer",
        name: "Kirchensteuer",
        hint: "Kirchensteuerbescheid, Kirchensteuer-Festsetzung/-Erstattung (z. B. Katholisches/Evangelisches Kirchensteueramt). Steuerlich Sonderausgaben.",
      },
      {
        slug: "finanzen-spenden",
        name: "Spenden & Zuwendungen",
        hint: "Spendenquittungen, Zuwendungsbestätigungen und Sammelbestätigungen gemeinnütziger Organisationen (z. B. UNICEF, Deutsches Rotes Kreuz, Feuerwehr, Kirchenstiftung, Caritas). Steuerlich Sonderausgaben (§10b EStG). NICHT: Meldungen oder Entgeltnachweise zur Sozialversicherung (→ finanzen-sozialversicherung).",
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
          {
            slug: "wohnen-haus-hausgeld",
            name: "Wirtschaftsplan / Hausgeld",
            hint: "Wirtschaftsplan oder Hausgeldabrechnung der selbst bewohnten Eigentumswohnung. NICHT Kapitalanlage-Immobilie (→ kapitalanlage-immobilie-hausgeld).",
          },
          {
            slug: "wohnen-haus-weg-jahresabrechnung",
            name: "WEG-Jahresabrechnung",
            hint: "WEG-Jahresabrechnung der selbst bewohnten Eigentumswohnung. NICHT Kapitalanlage-Immobilie (→ kapitalanlage-immobilie-weg-jahresabrechnung).",
          },
          { slug: "wohnen-haus-grundsteuer", name: "Grundsteuer" },
          {
            slug: "wohnen-haus-gebaeudeversicherung",
            name: "Gebäudeversicherung",
            hint: "Wohngebäudeversicherung des selbst bewohnten Hauses: Beitragsrechnungen, Policen, Anpassungen (z. B. DOMCURA, Allianz, Janitos Privatschutz mit Sparte Wohngebäude).",
          },
          {
            slug: "wohnen-haus-instandhaltung",
            name: "Instandhaltung / Handwerker",
            hint: "Handwerkerrechnungen, Reparaturen, Renovierung am selbst bewohnten Haus: Maler, Sanitär, Dachdecker, Heizungsbauer, Fassadenanstrich, Gerüstbau. Steuerlich §35a (haushaltsnahe).",
          },
          { slug: "wohnen-haus-finanzierung", name: "Finanzierung / Darlehen" },
          {
            slug: "wohnen-haus-kaufvertrag",
            name: "Kaufvertrag / Grundbuch",
            hint: "Notarieller Kaufvertrag, Grundbuchauszug, Übergabeprotokoll der selbst bewohnten Immobilie.",
          },
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
      {
        slug: "kapitalanlage-immobilie-mietvertrag",
        name: "Mietvertrag",
        hint: "Mietvertrag, Vollmacht zur Vermietung, Verwaltervertrag, Vermietungsvereinbarung einer Kapitalanlage-Immobilie (vermietete Eigentumswohnung / Sondereigentum).",
      },
      {
        slug: "kapitalanlage-immobilie-mieteingaenge",
        name: "Mieteingänge",
        hint: "Gesamtübersicht Sondereigentum (SEV), Mieteingangsübersichten, Hausgeld-Überführung der vermieteten Kapitalanlage-Immobilie.",
      },
      { slug: "kapitalanlage-immobilie-nebenkostenabrechnung", name: "Nebenkostenabrechnung" },
      { slug: "kapitalanlage-immobilie-eigentuemerversammlung", name: "Eigentümerversammlung" },
      { slug: "kapitalanlage-immobilie-hausgeld", name: "Wirtschaftsplan / Hausgeld" },
      {
        slug: "kapitalanlage-immobilie-weg-jahresabrechnung",
        name: "WEG-Jahresabrechnung",
        hint: "WEG-Jahresabrechnung einer vermieteten Kapitalanlage-Immobilie. Signale: 'Pflegezimmer', 'Sondereigentum', 'SEV', Einheit im 2./3. OG. Steuerlich Anlage V / Werbungskosten V.",
      },
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
        hint: "NUR klassische Kapital-Lebensversicherung mit Ablaufleistung/Deckungskapital/Rückkaufswert: Kündigung, Ablauf, Standmitteilung (z. B. HDI-Gerling, CosmosDirekt, AXA Lebensversicherung). NICHT fondsgebundene Rentenversicherung, NICHT Riester/Rürup (→ altersvorsorge-rentenversicherung). Unterscheidung: 'Rentenversicherung' oder 'Zulagenbescheinigung nach §92 EStG' im Text → rentenversicherung; 'Kapital-Lebensversicherung', 'Deckungskapital', 'Rückkaufswert' → hierher.",
      },
      {
        slug: "altersvorsorge-rentenversicherung",
        name: "Private Rentenversicherung (inkl. Riester/Rürup)",
        hint: "Fondsgebundene Rentenversicherung, Riester-Rentenversicherung (§10a EStG, Zulagenbescheinigung nach §92, Grundzulage, Kinderzulage, ZfA), Rürup-/Basisrentenversicherung, Förder Rente invest. Statusreports, Erhöhungsnachträge, Beitragsbescheinigungen (z. B. Heidelberger Leben / MLP balanced invest, Zurich DWS Premium, Allianz KinderPolice). Auch wenn der Absender 'Lebensversicherung AG' heißt — entscheidend ist 'Rentenversicherung' oder 'Riester' im Vertragsinhalt. NICHT Kapital-Lebensversicherung mit Ablaufleistung (→ altersvorsorge-lebensversicherung).",
      },
      {
        slug: "altersvorsorge-betrieblich",
        name: "Betriebliche Altersvorsorge (bAV)",
        hint: "Leistungsmitteilung einer Unterstützungskasse, Pensionskasse, Pensionsfonds oder Direktversicherung (z. B. Open Text Unterstützungskasse e.V.). Arbeitgeberfinanzierte Altersvorsorge.",
      },
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
    filesystemGrouping: {
      source: "subject_person",
      multipleSegment: "_mehrere-bezugspersonen",
    },
    children: [
      {
        slug: "gesundheit-arzt",
        name: "Arztrechnungen",
        hint: "Privatärztliche/zahnärztliche Rechnungen (GOÄ/GOZ), Liquidationen niedergelassener Ärzte/Zahnärzte, Heil- und Kostenpläne. Steuerlich außergewöhnliche Belastungen (Krankheitskosten).",
      },
      {
        slug: "gesundheit-rezepte",
        name: "Rezepte",
        hint: "Ärztliche Rezepte (Rp.), Apothekenrechnungen für verschreibungspflichtige Medikamente, Impfbescheinigungen, internationaler Impfausweis, Impfbuch, STIKO-Empfehlungen, Corona-Impfzertifikate (Robert Koch-Institut).",
      },
      {
        slug: "gesundheit-kasse",
        name: "Krankenkasse",
        hint: "Gesetzliche Krankenkasse (z. B. AOK, Techniker, Barmer): Mitgliedsbescheinigungen, Kostenübernahmen, Bescheide, Familienversicherung, Krankenpflegeleistungen. Auch Arbeitsunfähigkeitsbescheinigungen. NICHT private Krankenversicherung (→ versicherungen-kranken).",
      },
      {
        slug: "gesundheit-pflege",
        name: "Pflegeleistungen (Sozialstation)",
        hint: "Rechnungen/Leistungsnachweise ambulanter Pflege/Sozialstationen (z. B. Caritas-Sozialstation), häusliche Krankenpflege. NICHT: Meldung/Entgeltnachweis zur Sozialversicherung vom Arbeitgeber (→ finanzen-sozialversicherung) — „Sozialstation\" ≠ „Sozialversicherung\". Steuerlich haushaltsnahe Aufwendungen / außergewöhnliche Belastungen.",
      },
      {
        slug: "gesundheit-pflegekasse",
        name: "Pflegekasse",
        hint: "Pflegekasse (bei AOK, Techniker etc.): Pflegegrad-Bescheide, Fragebogen zu Pflegepersonen (§44 SGB XI), Leistungsbescheide zur Pflegeversicherung.",
      },
    ],
  },
  {
    slug: "fahrzeug",
    name: "Fahrzeug",
    icon: "pi-car",
    children: [
      {
        slug: "fahrzeug-papiere",
        name: "Kfz-Papiere",
        hint: "Fahrzeugschein, Fahrzeugbrief, Zulassungsbescheinigung, Führerschein, Schlüsselzahlen, Umweltplakette (auch französische Crit'Air), Fahrzeugliste, ADAC-Dokumente. NICHT Kfz-Versicherung (→ fahrzeug-versicherung).",
      },
      {
        slug: "fahrzeug-versicherung",
        name: "Kfz-Versicherung",
        hint: "Kfz-Haftpflicht-, Teilkasko-, Vollkaskoversicherung: Beitragsrechnungen, Versicherungsscheine, Schadenmeldungen, Deckungskarten (z. B. HDI, HUK-COBURG, Allianz). Auch THG-Bonus/Prämie. NICHT Sachversicherung (→ versicherungen-sach).",
      },
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
      {
        slug: "vertraege-strom",
        name: "Strom",
        hint: "Stromliefervertrag, Stromrechnung/Jahresabrechnung für Eigenverbrauch (z. B. Lechwerke/LEW, Stadtwerke, E.ON). NICHT Einspeisevergütung/PV-Abrechnung (→ wohnen-haus-photovoltaik).",
      },
      {
        slug: "vertraege-gas",
        name: "Gas",
        hint: "Gasliefervertrag, Gasrechnung/Jahresabrechnung (z. B. Stadtwerke, E.ON).",
      },
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
        hint: "Private Kranken-, Pflege- und Krankenzusatzversicherung: Beitragsrechnungen, Beitragsanpassungen, Beitragsbescheinigungen, Leistungsabrechnungen (z. B. HALLESCHE, DKV, R+V Krankenversicherung). Steuerlich Vorsorgeaufwand. NICHT: gesetzliche Krankenkasse (→ gesundheit-kasse), NICHT Lebensversicherung (→ altersvorsorge-lebensversicherung), NICHT Rentenversicherung/Riester (→ altersvorsorge-rentenversicherung), NICHT Kfz-Versicherung (→ fahrzeug-versicherung), NICHT Wohngebäudeversicherung (→ wohnen-haus-gebaeudeversicherung), NICHT Freistellungsauftrag (→ finanzen-wertpapiere).",
      },
      {
        slug: "versicherungen-sach",
        name: "Sach- & Haftpflichtversicherung",
        hint: "Privathaftpflicht-, Hausrat-, Rechtsschutz-, Unfallversicherung: Beiträge, Policen, Schadenfälle (z. B. Janitos Privatschutz Haftpflicht; Makler wie Marsh, HVS). NICHT: Kfz-Versicherung (→ fahrzeug-versicherung), NICHT Wohngebäudeversicherung (→ wohnen-haus-gebaeudeversicherung oder wohnen-versicherung), NICHT Führerschein/Fahrzeugpapiere (→ fahrzeug-papiere).",
      },
    ],
  },
  {
    slug: "beruf",
    name: "Beruf",
    icon: "pi-briefcase",
    children: [
      {
        slug: "beruf-arbeitsvertrag",
        name: "Arbeitsvertrag",
        hint: "Arbeitsvertrag, Berufsausbildungsvertrag, Stellenbeschreibung, Änderungsvertrag, Kündigung. Auch Zeiterfassung, Urlaubsanträge, Reisekostenerstattung (arbeitsrechtliche Dokumente).",
      },
      { slug: "beruf-zeugnisse", name: "Arbeitszeugnisse" },
    ],
  },
  {
    slug: "familie",
    name: "Familie",
    icon: "pi-users",
    filesystemGrouping: {
      source: "subject_person",
      multipleSegment: "_mehrere-bezugspersonen",
    },
    children: [
      {
        slug: "familie-urkunden",
        name: "Urkunden",
        hint: "Personenstands- und kirchliche Urkunden: Geburtsurkunde, Heiratsurkunde, kirchliche Trauurkunde, Sterbeurkunde, Taufurkunde. Auch Firmung (kirchliches Sakrament). NICHT Vereins-, Sport- oder Feuerwehr-Ehrungen (→ vereine-urkunden).",
      },
      { slug: "familie-ausweise", name: "Ausweise" },
      {
        slug: "familie-schule",
        name: "Schule",
        hint: "Schulische Dokumente aller Art: Schulaufgaben, Klassenarbeiten, Probearbeiten, Leseproben, Arbeitsblätter (Deutsch, Englisch, Französisch, Mathematik), Lernpläne, Testvorbereitungen, Notenbescheide, Bewertungen, Schulferienkalender, Elternbriefe, Anmeldungen, Klassenfahrten, Einwilligungserklärungen. Auch kirchliche Jugendarbeit: Firmvorbereitung, Firm-Orientierungs-Wochenende, Terminpläne für Firmlinge (z. B. Gymnasium, Pfarrei). NICHT Bildungszertifikate (→ bildung-zertifikate).",
      },
    ],
  },
  {
    slug: "vereine",
    name: "Vereine",
    icon: "pi-users",
    filesystemGrouping: {
      source: "subject_person",
      multipleSegment: "_mehrere-bezugspersonen",
    },
    children: [
      {
        slug: "vereine-urkunden",
        name: "Urkunden & Ehrungen",
        hint: "Urkunden, Ehrungen und Auszeichnungen von Sportvereinen, Feuerwehr und anderen Vereinen: Leistungs- und Wettkampfurkunden, Ehrenzeichen, Jubiläums- und Dankesurkunden. NICHT Personenstands- oder kirchliche Urkunden (→ familie-urkunden), NICHT Lehrgangs- und Fortbildungsnachweise (→ bildung-zertifikate).",
      },
      {
        slug: "vereine-mitgliedschaft",
        name: "Mitgliedschaft",
        hint: "Unterlagen zur Vereinsmitgliedschaft: Aufnahmeanträge und -bestätigungen, Mitgliedsausweise, Kündigungen, Satzungen, Beitragsbescheide und Korrespondenz zur Mitgliedschaft. NICHT Spendenbescheinigungen (→ finanzen-spenden), NICHT Urkunden oder Ehrungen (→ vereine-urkunden).",
      },
    ],
  },
  {
    slug: "behoerden",
    name: "Behörden",
    icon: "pi-building",
    children: [
      {
        slug: "behoerden-bescheide",
        name: "Bescheide",
        hint: "Behördliche Bescheide und Schreiben: Steuerliche Identifikationsnummer (Bundeszentralamt für Steuern), Ehrungen/Gutscheine (Landratsamt), Baugenehmigungen, Meldebescheinigungen. NICHT Steuerbescheide (→ behoerden-steuerbescheid), NICHT kommunale Gebühren (→ wohnen-kommunale-abgaben).",
      },
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
    filesystemGrouping: {
      source: "subject_person",
      missingSegment: "_ohne-betreuten",
      multipleSegment: "_mehrere-betreute",
    },
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
    filesystemGrouping: {
      source: "subject_person",
      multipleSegment: "_mehrere-bezugspersonen",
    },
    children: [
      {
        slug: "bildung-zeugnisse",
        name: "Zeugnisse",
        hint: "Schul-/Hochschulzeugnisse, Diplomurkunden, Abiturzeugnis, Bachelor-/Masterzeugnis.",
      },
      {
        slug: "bildung-zertifikate",
        name: "Zertifikate",
        hint: "Teilnahmebescheinigungen, Fortbildungszertifikate, Sprachzertifikate, Erste-Hilfe-Ausbildung, berufliche Weiterbildungsnachweise. NICHT Schulzeugnisse (→ bildung-zeugnisse).",
      },
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
    hint: "LETZTE WAHL — nur verwenden, wenn das Dokument in KEINE andere Kategorie passt. Prüfe zuerst: Schuldokumente → familie-schule, Rechnungen → finanzen-rechnungen, Steuererklärungen → finanzen-steuern, Impfdokumente → gesundheit-rezepte, Urkunden → familie-urkunden, Behördenschreiben → behoerden-bescheide, WEG-Abrechnungen → kapitalanlage-immobilie-weg-jahresabrechnung oder wohnen-haus-weg-jahresabrechnung.",
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

/**
 * Return the first filesystem grouping configured on an actual root-to-leaf
 * category path. Keeping this metadata in the taxonomy avoids category-name
 * conditionals in the generic filesystem path builder.
 */
export function filesystemGroupingForCategoryPath(
  categorySlugs: readonly string[],
): { categorySlug: string; config: FilesystemGroupingConfig } | null {
  let nodes = categoryTaxonomy;
  for (const slug of categorySlugs) {
    const node = nodes.find((candidate) => candidate.slug === slug);
    if (!node) return null;
    if (node.filesystemGrouping) {
      return { categorySlug: node.slug, config: node.filesystemGrouping };
    }
    nodes = node.children ?? [];
  }
  return null;
}
