/**
 * Text documents the assistant writes for the user: an answer, a summary of
 * the conversation, notes on a topic — filed as a Markdown text document like
 * the ones written in the documents module (documents/text-documents.ts).
 * Reading one needs nothing new: get_document_text returns its Markdown.
 *
 * Like every write tool it only proposes; the card shows the text, and the
 * document is filed when the user confirms, dated today with the user as
 * sender.
 */

import { documents } from "~encore/clients";
import { str } from "../format";
import type { TextDocumentPreview, WriteToolDefinition } from "../proposals";

/** Mirrors TEXT_DOCUMENT_* in documents/text-documents.ts; the endpoint checks again. */
const MAX_TITLE = 200;
const MAX_MARKDOWN = 500_000;

function previewOf(args: Record<string, unknown>): TextDocumentPreview {
  return { title: String(args.title ?? ""), markdown: String(args.markdown ?? "") };
}

export const createTextDocument: WriteToolDefinition = {
  name: "create_text_document",
  summary: "Propose to file a text document the user can open, search and edit in the documents module: a title and the text in Markdown (headings, lists, tables). Use it when the user wants something kept as a document — 'speichere das als Dokument', 'mach daraus eine Notiz', 'fasse unser Gespräch als Dokument zusammen'. Write the complete text yourself, from tool results and this conversation; the server dates it today and names the user as author.",
  permissions: ["module.documents", "documents.upload"],
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "short German title of the document" },
      markdown: { type: "string", description: "the whole text in Markdown; start with the content, not with the title again" },
    },
    required: ["title", "markdown"],
  },
  async prepare(args) {
    const title = str(args.title)?.replace(/\s+/g, " ");
    if (!title) throw new Error("title is required");
    if (title.length > MAX_TITLE) throw new Error(`title may have at most ${MAX_TITLE} characters`);
    const markdown = typeof args.markdown === "string" ? args.markdown.replace(/\r\n?/g, "\n").trim() : "";
    if (!markdown) throw new Error("markdown is required: write the text of the document");
    if (markdown.length > MAX_MARKDOWN) throw new Error(`markdown may have at most ${MAX_MARKDOWN} characters`);
    return {
      summary: `Textdokument „${title}“ ablegen`,
      arguments: { title, markdown },
      note: "The card shows the text; after filing, the user can change it with \"Bearbeiten\" on the document.",
    };
  },
  async execute(args) {
    const doc = (await documents.createTextDocument({
      title: String(args.title),
      markdown: String(args.markdown),
    })) as unknown as { id: number; title: string | null };
    return {
      summary: `Textdokument „${doc.title ?? String(args.title)}“ abgelegt`,
      route: `/dokumente/${doc.id}`,
      details: { document_id: doc.id },
    };
  },
  preview: previewOf,
};
