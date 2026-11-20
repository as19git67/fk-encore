/**
 * Rules for text documents the user writes in the app.
 *
 * The endpoints live in documents.ts next to the upload they mirror
 * (`POST /documents/text`, `PUT /documents/:id/text`); the PDF comes from
 * markdown-pdf.ts. What is checked here is what both endpoints share.
 */

import { APIError } from "encore.dev/api";
import { slugifyName } from "./documents.service";

export const TEXT_DOCUMENT_TITLE_MAX = 200;
/** Generous for prose, small enough that a render stays quick. */
export const TEXT_DOCUMENT_MARKDOWN_MAX = 500_000;

export interface TextDocumentInput {
  title: string;
  markdown: string;
}

/** Trims and checks title and Markdown; throws invalid_argument when unusable. */
export function validateTextDocument(input: TextDocumentInput): TextDocumentInput {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw APIError.invalidArgument("a text document needs a title");
  if (title.length > TEXT_DOCUMENT_TITLE_MAX) {
    throw APIError.invalidArgument(`the title may have at most ${TEXT_DOCUMENT_TITLE_MAX} characters`);
  }
  const markdown = (input.markdown ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (markdown.length > TEXT_DOCUMENT_MARKDOWN_MAX) {
    throw APIError.invalidArgument(`the text may have at most ${TEXT_DOCUMENT_MARKDOWN_MAX} characters`);
  }
  return { title, markdown: markdown ? `${markdown}\n` : "" };
}

/** File name of the rendered PDF, from the title: "Notizen zur Heizung" → "notizen-zur-heizung.pdf". */
export function textDocumentFilename(title: string): string {
  return `${slugifyName(title) || "textdokument"}.pdf`;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * The Markdown with `addition` below it; what stood there stays byte for
 * byte. A list item after a list item continues the list, anything else is
 * a paragraph of its own. With `followList`, a plain line said to a note
 * that ends in a list becomes its next item ("Milch" on a shopping list).
 * An addition that is only blank is refused.
 */
export function appendedMarkdown(markdown: string, addition: string, followList = false): string {
  let text = (addition ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw APIError.invalidArgument("there is nothing to add");
  const before = markdown.replace(/\s+$/, "");
  if (!before) return `${text}\n`;
  const endsInList = LIST_ITEM.test(before.slice(before.lastIndexOf("\n") + 1));
  if (endsInList && followList && !LIST_ITEM.test(text) && !text.includes("\n")) text = `- ${text}`;
  const joint = endsInList && LIST_ITEM.test(text) ? "\n" : "\n\n";
  return `${before}${joint}${text}\n`;
}

const EXCERPT_MAX = 120;

/** The first line with words in it, without Markdown marks, for a picker row. */
export function excerptOf(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, "").replace(/[*_`~]/g, "").trim())
    .find((l) => l.length > 0) ?? "";
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : line;
}
