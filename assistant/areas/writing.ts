import type { Area } from "./index";

export const WRITING_AREA: Area = {
  id: "writing",
  description: "Schreiben: a letter (Anschreiben, Antwort, Widerspruch, Kündigung) as a PDF card, notes (new, added to, rewritten), or the conversation's result kept as a text document.",
  tools: ["render_letter", "create_text_document", "append_to_text_document", "rewrite_text_document"],
  borrows: ["search_documents", "get_document_summary", "get_document_text"],
  rules: [
    'For a letter (Anschreiben, Antwort, Widerspruch, Kündigung …) call render_letter with the whole text: salutation, body and the closing formula ("Mit freundlichen Grüßen") — the server signs it with the user\'s name. Take every fact — names, dates, amounts, reference numbers — from the working set or a tool result, and put everything the user asks to have mentioned into the letter text itself, not only into your reply. Write dates in letters as DD.MM.YYYY. Before you leave the recipient\'s address or a customer, member or contract number open, look for it in the user\'s documents from that sender (search_documents, then get_document_text). Where the letter still needs a fact you do not have, write a gap that names it in double brackets, e.g. [[Mitgliedsnummer]], instead of guessing. The card cannot run while a gap is left, so when there are gaps, name them in plain words and say they have to be filled in on the card before "Ausführen" works; never write the bracket syntax itself into your reply. Documents the user wants enclosed ("mit dem Vertrag als Anlage") go into attachment_document_ids by the ids a tool returned; without them the letter has no enclosures unless there is a working set.',
    'To note or keep something ("notiere …", "speichere das als Dokument") call create_text_document with a title and the whole text in Markdown; never invent facts. To add to a note use append_to_text_document with its title and only the new text. Both run at once. To change what a note says, read it with get_document_text, then rewrite_text_document.',
  ],
  examples: [
    'Working set of three invoices: "Schreib dem Absender, dass ich die drei Rechnungen bezahlt habe." → render_letter(recipient = the sender\'s address if a tool showed it, else [[Anschrift des Absenders]], subject = "Ihre Rechnungen …" with their numbers, body = salutation, one line per invoice with number, date and amount from the working set, [[Zahlungsdatum]] where the date of payment is unknown, closing) → say the letter waits on the card and name the gaps to fill.',
    'Working set: a reminder (Mahnung). "Entwirf einen Widerspruch dagegen und nenne die Rechnungsnummer und die Zahlungsfrist aus dem Schreiben." → get_document_text(id = the document\'s id) → render_letter(body with the invoice number and the deadline exactly as the text prints them, e.g. "Ihre Mahnung zur Rechnung RE-2026-0101 mit Zahlungsfrist bis 15.11.2026") — every fact the user asks to have named stands in the body, even one you would leave out yourself; a reply never explains why a named fact was left out.',
  ],
  keywords:
    "schreib|anschreiben|antwort|entwirf|entwurf|widerspr|kündig|notiz|notier|einkaufsliste|anhäng|häng |ergänz|speicher|zusammenfass|fasse|formulier|"
    + "letter|write|draft|reply|note|save|summari[sz]e",
};
