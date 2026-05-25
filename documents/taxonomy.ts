// Starter taxonomy for private household document management.
// Loaded by db/seed.ts into the `document_categories` table and sent to the
// LLM classifier as the available label set. Heuristic set — meant to evolve
// through the AI suggestion loop (see document_category_suggestions table).

export interface CategorySeed {
  slug: string;
  name: string;
  icon?: string;
  children?: CategorySeed[];
}

export const categoryTaxonomy: CategorySeed[] = [
  {
    slug: "finanzen",
    name: "Finanzen",
    icon: "pi-euro",
    children: [
      { slug: "finanzen-kontoauszuege", name: "Kontoauszüge" },
      { slug: "finanzen-gehalt", name: "Gehaltsabrechnungen" },
      { slug: "finanzen-rechnungen", name: "Rechnungen" },
      { slug: "finanzen-steuern", name: "Steuern" },
    ],
  },
  {
    slug: "wohnen",
    name: "Wohnen",
    icon: "pi-home",
    children: [
      { slug: "wohnen-miete", name: "Miete" },
      { slug: "wohnen-nebenkosten", name: "Nebenkosten" },
      { slug: "wohnen-versicherung", name: "Versicherungen" },
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
      { slug: "altersvorsorge-lebensversicherung", name: "Kapital-Lebensversicherung" },
      { slug: "altersvorsorge-rentenversicherung", name: "Private Rentenversicherung (inkl. Riester/Rürup)" },
      { slug: "altersvorsorge-betrieblich", name: "Betriebliche Altersvorsorge (bAV)" },
      { slug: "altersvorsorge-gesetzlich", name: "Gesetzliche Rente (DRV)" },
    ],
  },
  {
    slug: "gesundheit",
    name: "Gesundheit",
    icon: "pi-heart",
    children: [
      { slug: "gesundheit-arzt", name: "Arztrechnungen" },
      { slug: "gesundheit-rezepte", name: "Rezepte" },
      { slug: "gesundheit-kasse", name: "Krankenkasse" },
      { slug: "gesundheit-pflege", name: "Pflegeleistungen (Sozialstation)" },
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
      { slug: "vertraege-telekom", name: "Telekommunikation" },
      { slug: "vertraege-strom", name: "Strom" },
      { slug: "vertraege-gas", name: "Gas" },
      { slug: "vertraege-abos", name: "Abonnements" },
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
      { slug: "familie-schule", name: "Schule" },
    ],
  },
  {
    slug: "behoerden",
    name: "Behörden",
    icon: "pi-building",
    children: [
      { slug: "behoerden-bescheide", name: "Bescheide" },
      { slug: "behoerden-steuerbescheid", name: "Steuerbescheide" },
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
    slug: "sonstiges",
    name: "Sonstiges",
    icon: "pi-file",
  },
];

export function flattenTaxonomy(
  nodes: CategorySeed[] = categoryTaxonomy,
  parentSlug: string | null = null,
): Array<{ slug: string; name: string; icon: string | null; parent_slug: string | null; sort_order: number }> {
  const out: Array<{ slug: string; name: string; icon: string | null; parent_slug: string | null; sort_order: number }> = [];
  nodes.forEach((node, idx) => {
    out.push({
      slug: node.slug,
      name: node.name,
      icon: node.icon ?? null,
      parent_slug: parentSlug,
      sort_order: idx,
    });
    if (node.children?.length) {
      out.push(...flattenTaxonomy(node.children, node.slug));
    }
  });
  return out;
}
