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
