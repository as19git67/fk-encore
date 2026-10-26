import type { Area } from "./index";

export const WRITING_AREA: Area = {
  id: "writing",
  description: "Schreiben: a letter (Anschreiben, Antwort, Widerspruch, Kündigung) as a PDF card, or the conversation's result kept as a text document.",
  tools: ["render_letter", "create_text_document"],
  borrows: ["search_documents", "get_document_summary", "get_document_text"],
  rules: [
    'For a letter (Anschreiben, Antwort, Widerspruch, Kündigung …) call render_letter with the whole text: salutation, body and the closing formula ("Mit freundlichen Grüßen") — the server signs it with the user\'s name. Take every fact — names, dates, amounts, reference numbers — from the working set or a tool result, and put everything the user asks to have mentioned into the letter text itself, not only into your reply. Write dates in letters as DD.MM.YYYY. Before you leave the recipient\'s address or a customer, member or contract number open, look for it in the user\'s documents from that sender (search_documents, then get_document_text). Where the letter still needs a fact you do not have, write a gap that names it in double brackets, e.g. [[Mitgliedsnummer]], instead of guessing. The card cannot run while a gap is left, so when there are gaps, name them in plain words and say they have to be filled in on the card before "Ausführen" works; never write the bracket syntax itself into your reply. Documents the user wants enclosed ("mit dem Vertrag als Anlage") go into attachment_document_ids by the ids a tool returned; without them the letter has no enclosures unless there is a working set.',
    'To keep something as a document ("speichere das als Dokument", "mach eine Notiz daraus", "fasse das Gespräch als Dokument zusammen") call create_text_document with a title and the complete text in Markdown, written from the tool results and answers of this conversation; never invent facts for it. A text document\'s Markdown is read back with get_document_text.',
  ],
  examples: [
    'Working set of three invoices: "Schreib dem Absender, dass ich die drei Rechnungen bezahlt habe." → render_letter(recipient = the sender\'s address if a tool showed it, else [[Anschrift des Absenders]], subject = "Ihre Rechnungen …" with their numbers, body = salutation, one line per invoice with number, date and amount from the working set, [[Zahlungsdatum]] where the date of payment is unknown, closing) → say the letter waits on the card and name the gaps to fill.',
  ],
  keywords:
    "schreib|anschreiben|antwort|entwirf|entwurf|widerspr|kündig|notiz|speicher|zusammenfass|fasse|formulier|"
    + "letter|write|draft|reply|note|save|summari[sz]e",
};
