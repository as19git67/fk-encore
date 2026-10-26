import type { Area } from "./index";

export const BUSINESSES_AREA: Area = {
  id: "businesses",
  description: "Betriebe: a leased farm, a PV system or a trade as a business — fixed assets and depreciation (AfA), parcels with lessee and rent, the EÜR (Einnahmen-Überschuss-Rechnung), tax exemption of a PV system, the business's documents.",
  tools: ["list_businesses", "business_assets", "euer_report", "euer_pdf", "business_documents"],
  borrows: ["get_document_summary", "get_document_text"],
  rules: [
    'Businesses (Betriebe): a leased farm, a PV system or a trade is a business in the register with its fixed assets (Anlagegüter), their depreciation (AfA) and, for a farm, its parcels (Flurstücke) with lessee and rent. "Welche Anlagegüter hat die Landwirtschaft", "wie hoch ist die AfA 2025", "welche Flächen sind verpachtet" go to list_businesses → business_assets(business_id, year); quote the AfA and book values the tool printed, never recompute them. "EÜR", "Gewinn der Landwirtschaft", "Betriebseinnahmen und -ausgaben" go to euer_report(business_id, year), and "als PDF" to euer_pdf(business_id, year); repeat the line sums, the totals and the result the tool printed. "Ist die PV-Anlage steuerfrei" is list_businesses → business_assets(the PV business, year): repeat the status and the reason the tool printed (§ 3 Nr. 72 EStG, up to 30 kWp from 2022), never decide it yourself. "Der Pachtvertrag der Fläche", "die Rechnung zum Stall", "Unterlagen der Landwirtschaft" go to business_documents(business_id); for a document\'s content, get_document_summary or get_document_text on the ids it printed.',
  ],
  examples: [
    '"Wie hoch ist die AfA der Landwirtschaft 2025, und welche Flächen gehören dazu?" → list_businesses → business_assets(business_id = the farm\'s id, year = 2025) → repeat the AfA, the book values and the parcels the tool printed.',
  ],
  keywords:
    "betrieb|anlageg|anlagevermögen|afa|abschreibung|fläche|flurstück|pacht|pächter|landwirtschaft|pv-anlage|photovoltaik|eür|einnahmen-überschuss|betriebseinnahme|betriebsausgabe|steuerfrei|"
    + "business|asset|parcel|lease|depreciation",
};
