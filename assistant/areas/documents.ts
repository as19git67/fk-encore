import type { Area } from "./index";

export const DOCUMENTS_AREA: Area = {
  id: "documents",
  description: "Dokumente: the document archive — search by text, sender and category, a document's summary or full text, where a phrase stands on which page, follow-ups, collections (Sammelmappen) with redaction and their PDF.",
  tools: [
    "list_categories",
    "search_documents",
    "get_document_summary",
    "get_document_text",
    "find_text_in_document",
    "create_document_follow_up",
    "create_collection",
    "build_collection_pdf",
  ],
  rules: [
    'When the user answers an offer you made ("Soll ich eines davon genauer ansehen?" → "ja"), act on the rows of your previous answer — their ids are in the earlier tool results — with get_document_summary(ids = …) or get_document_text; never search again for them.',
    'A search for documents of a sender or about a matter is search_documents(q, correspondent, category …); list_categories first only when the question names a category or a place the archive files under ("die Wohnung in Musterstadt"). "Auf welchen Seiten steht …" is find_text_in_document; blacking out (schwärzen) is create_collection with redact = the values as printed, then build_collection_pdf.',
  ],
  examples: [
    '"Gib mir die Protokolle der Eigentümerversammlung der Wohnung in Musterstadt." → list_categories → search_documents(q = "Protokoll Eigentümerversammlung", category = the matching slug) → name the documents that fit.',
    'After an answer listing documents of a purchase: "Schwärze den Kaufpreis und mach ein PDF daraus." → find the price first if it is not known (get_document_summary of the contract) → create_collection(name = …, from_previous_result = true, redact = [the price as printed, e.g. "450.000,00"]) → say how many pages get blacked out, name documents without word positions, and that the boxes should be checked in the Sammelmappe before passing the PDF on.',
    '"Zeig mir je Absender das größte Dokument." → search_documents(rank_by = "size_bytes", direction = "desc", group_by = "correspondent"); the same rank_by/group_by exist for date and year, and rank_by always comes with direction.',
    '"Zeig mir alles zum Kauf der Wohnung in Beispielheim." → list_categories → search_documents(q = "Kauf Wohnung Beispielheim", category = the matching slug) → switch_area("finance") → list_transactions(q = "Beispielheim", from/to = around the dates of the documents found) → name the documents and the bookings (notary, land registry, purchase price) together; "alles zu …", "was … relevant war" about a purchase, a renovation or a damage means documents and bookings both, and the bookings need the finance area when it is not in play.',
  ],
  keywords:
    "dokument|unterlage|rechnung|vertrag|beleg|brief|protokoll|abrechnung|mahnung|bescheid|schwärz|pdf|seite|sammelmappe|mappe|absender|kaufunterlagen|immobilie|archiv|"
    + "document|invoice|contract|receipt|letter|redact|collection|folder|sender",
};
