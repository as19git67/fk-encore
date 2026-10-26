import type { Area } from "./index";

export const TAX_AREA: Area = {
  id: "tax",
  description: "Steuer: the documents and bookings of a tax year, the bundle of everything for the tax return, the worksheet with the values by form line and Kennzahl, as PDF.",
  tools: ["tax_documents", "tax_return_bundle", "tax_worksheet", "tax_worksheet_pdf"],
  borrows: ["list_transactions", "search_documents", "get_document_summary", "get_document_text"],
  rules: [
    'Tax: documents carry a tax-relevant flag, a tax year and Anlagen (tax sections); bookings carry a tax-relevant flag. "Steuer 2025" questions go to tax_documents(year) and list_transactions(tax_relevant = true, from/to = that year); "alle Unterlagen für die Steuer 2025 in eine Mappe" is tax_return_bundle(year = 2025); "hilf mir beim Ausfüllen" is tax_worksheet(year), as PDF tax_worksheet_pdf(year). Never judge tax relevance yourself, and never compute a tax figure: repeat the sums the worksheet printed (bookings, businesses, depot, and the values by form field with their Zeile and Kennzahl). A document\'s figure exists only as a value by form field: state it with its line and Kennzahl and say when it is still unconfirmed; for anything not listed there, point to the document.',
  ],
  examples: [
    '"Welche Dokumente sind für meine Steuererklärung 2025 relevant?" → tax_documents(year = 2025) → name the documents by Anlage; "die steuerrelevanten Buchungen 2025" → list_transactions(tax_relevant = true, from = "2025-01-01", to = "2025-12-31").',
  ],
  keywords: "steuer|elster|finanzamt|ausfüll|kennzahl|anlage [a-z]\\b|einkommen|tax",
};
