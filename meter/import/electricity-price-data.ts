export interface ElectricityPriceImportEntry {
  kind:
    | "grid_import"
    | "base_price"
    | "feed_in"
    | "self_consumption_value"
    | "pv_investment_net"
    | "pv_investment_vat"
    | "opportunity_cost_year"
    | "opportunity_cost_total"
    | "amortization_years";
  validFrom: string;
  amount: number;
  unit: "eur_per_kwh" | "eur_per_month" | "eur" | "years";
  taxStatus?: string | null;
  name?: string | null;
  capacityLimitKw?: number | null;
  source?: Record<string, unknown>;
}

const source = (row: number, label: string | null, formula: string | null, note: string | null) => ({
  file: "/Users/anton/Library/CloudStorage/Dropbox/MA/Haus/Statistik Wärmepumpe und Stromzählerstand.xlsx",
  sheet: "Preise ",
  row,
  label,
  formula,
  note,
});

export const electricityPriceData: ElectricityPriceImportEntry[] = [
  { kind: "grid_import", validFrom: "2021-07-01", amount: 0.2682, unit: "eur_per_kwh", taxStatus: "gross", source: source(4, "Strompreis ab 1.7.2021", null, "incl. MwSt.") },
  { kind: "grid_import", validFrom: "2022-07-01", amount: 0.2238, unit: "eur_per_kwh", taxStatus: "gross", source: source(5, "Strompreis ab 1.7.2022", null, "incl. MwSt.") },
  { kind: "grid_import", validFrom: "2023-01-01", amount: 0.3691, unit: "eur_per_kwh", taxStatus: "gross", source: source(6, "Strompreis ab 1.1.2023", null, "incl. MwSt.") },
  { kind: "grid_import", validFrom: "2023-07-01", amount: 0.3257, unit: "eur_per_kwh", taxStatus: "gross", source: source(7, "Strompreis ab 1.7.2023", null, "incl. MwSt.") },
  { kind: "grid_import", validFrom: "2024-11-01", amount: 0.3535, unit: "eur_per_kwh", taxStatus: "gross", source: source(8, "Strompreis ab 1.11.2024", null, "incl. MwSt.") },
  { kind: "grid_import", validFrom: "2026-03-01", amount: 0.2999, unit: "eur_per_kwh", taxStatus: "gross", source: source(9, "Strompreis ab 1.3.2026", null, "incl. MwSt.") },

  { kind: "base_price", validFrom: "2021-07-01", amount: 12.51, unit: "eur_per_month", taxStatus: "gross", source: source(10, "Grundpreis Strom / Monat", null, "incl. MwSt.") },
  { kind: "base_price", validFrom: "2023-01-01", amount: 13.65, unit: "eur_per_month", taxStatus: "gross", source: source(11, "Grundpreis Strom / Monat ab 1.1.2023", null, "incl. MwSt.") },
  { kind: "base_price", validFrom: "2023-07-01", amount: 13.16, unit: "eur_per_month", taxStatus: "gross", source: source(12, "Grundpreis Strom / Monat ab 1.7.2023", null, "incl. MwSt.") },
  { kind: "base_price", validFrom: "2024-11-01", amount: 17.46, unit: "eur_per_month", taxStatus: "gross", source: source(13, "Grundpreis Strom / Monat ab 1.11.2024", null, "incl. MwSt.") },
  { kind: "base_price", validFrom: "2026-03-01", amount: 15.1608333333, unit: "eur_per_month", taxStatus: "gross", source: source(14, "Grundpreis Strom / Monat ab 1.3.2026", "=181.93/12", "incl. MwSt.") },

  // The source sheet has no explicit date for feed-in tariffs; use the first
  // known electricity tariff date as start so the values are available across
  // the imported PV history and can be superseded by future changes.
  { kind: "feed_in", validFrom: "2021-07-01", amount: 0.0792, unit: "eur_per_kwh", taxStatus: "net", name: "Einspeisevergütung bis 10kW", capacityLimitKw: 10, source: source(2, "Einspeisevergütung bis 10kW", null, "ohne MwSt") },
  { kind: "feed_in", validFrom: "2021-07-01", amount: 0.077, unit: "eur_per_kwh", taxStatus: "net", name: "Einspeisevergütung bis 40 kW", capacityLimitKw: 40, source: source(3, "Einspeisevergütung bis 40 kW", null, "ohne MwSt") },
  { kind: "self_consumption_value", validFrom: "2021-07-01", amount: 0.2, unit: "eur_per_kwh", taxStatus: "assumed_net_plus_vat", source: source(1, "Strompreis Eigenverbrauch", null, "ist angenommener Strompreis, auf den dann MwSt. bezahlt werden muss (EEG)") },

  { kind: "pv_investment_net", validFrom: "2021-07-01", amount: 22587.73, unit: "eur", taxStatus: "net", source: source(15, "Anschaffungskosten E3DC + PV", null, "(ohne MwSt.)") },
  { kind: "pv_investment_vat", validFrom: "2021-07-01", amount: 4291.67, unit: "eur", source: source(16, "Mehrwertsteuer Anlage", null, null) },
  { kind: "opportunity_cost_year", validFrom: "2021-07-01", amount: 1129.3865, unit: "eur", source: source(19, null, "=B15*0.05", "Opportunitätskosten pro Jahr") },
  { kind: "opportunity_cost_total", validFrom: "2021-07-01", amount: 10829.6198866741, unit: "eur", source: source(20, null, "=B19*B22", "Opportunitätskosten gesamte Amortisationszeit") },
  { kind: "amortization_years", validFrom: "2021-07-01", amount: 9.5889404439, unit: "years", source: source(22, "Amortisation nach rund", "=(B15+10470)/(MEDIAN(Zählerstände!BL24,Zählerstände!BL36,Zählerstände!BL48))", "Jahren") },
];
