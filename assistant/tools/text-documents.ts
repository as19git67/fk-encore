/**
 * Text documents the assistant writes for the user: notes, an answer, a
 * summary of the conversation — filed as a Markdown text document like the
 * ones written in the documents module (documents/text-documents.ts).
 * Reading one needs nothing new: get_document_text returns its Markdown.
 *
 * Two of them run at once, without a card to confirm (`immediate`): filing a
 * new note and adding text at the end of one. Neither loses anything the
 * user had, and the card under the answer offers "Rückgängig" — it deletes
 * the new note, or puts the text back as it was before the addition, as long
 * as nobody changed the document since. Rewriting a note changes what is
 * there, so it stays a proposal the user confirms.
 */

import { documents } from "~encore/clients";
import { str } from "../format";
import type { ActionResult, TextDocumentPreview, WriteToolDefinition } from "../proposals";
import type { ToolContext } from "../types";

/** Mirrors TEXT_DOCUMENT_* in documents/text-documents.ts; the endpoint checks again. */
const MAX_TITLE = 200;
const MAX_MARKDOWN = 500_000;
/** Text documents read to find a note by its title. */
const NOTE_LOOKUP_LIMIT = 100;

interface TextDocumentDetail {
  id: number;
  title: string | null;
  markdown_source: string | null;
  content_revision: string;
}

interface NoteRow {
  id: number;
  title: string;
}

function previewOf(args: Record<string, unknown>): TextDocumentPreview {
  return { title: String(args.title ?? ""), markdown: String(args.markdown ?? "") };
}

function cleanTitle(value: unknown): string {
  const title = str(value)?.replace(/\s+/g, " ");
  if (!title) throw new Error("title is required");
  if (title.length > MAX_TITLE) throw new Error(`title may have at most ${MAX_TITLE} characters`);
  return title;
}

function cleanMarkdown(value: unknown, field: string): string {
  const markdown = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  if (!markdown) throw new Error(`${field} is required: write the text`);
  if (markdown.length > MAX_MARKDOWN) throw new Error(`${field} may have at most ${MAX_MARKDOWN} characters`);
  return markdown;
}

async function readTextDocument(id: number): Promise<TextDocumentDetail> {
  return (await documents.getDocument({ id })) as unknown as TextDocumentDetail;
}

/** What a later "Rückgängig" compares against: the version the action left. */
function revisionOf(result: ActionResult): string | null {
  const rev = result.details?.revision;
  return typeof rev === "string" ? rev : null;
}

const CHANGED_SINCE = "Die Notiz wurde inzwischen geändert; rückgängig machen würde das überschreiben. Ändere sie bitte im Dokument selbst.";

/**
 * The note an append or a rewrite means: by id, or by its title among the
 * text documents the user sees — an exact title first, then one that holds
 * the words. Several or none is an error that lists what there is; never a
 * guess, because the write goes to the note it picks.
 */
async function resolveNote(args: Record<string, unknown>): Promise<NoteRow> {
  const id = Number(args.document_id);
  if (Number.isInteger(id) && id > 0) {
    const doc = await readTextDocument(id);
    if (doc.markdown_source == null) {
      throw new Error(`document ${id} is no text document written in the app; only those can be changed as text`);
    }
    return { id: doc.id, title: doc.title ?? "" };
  }
  const wanted = str(args.note)?.replace(/\s+/g, " ");
  if (!wanted) throw new Error("name the note: note (its title) or document_id");
  const res = (await documents.listTextDocuments({ limit: NOTE_LOOKUP_LIMIT })) as unknown as { documents: NoteRow[] };
  const notes = res.documents;
  const key = (s: string) => s.toLocaleLowerCase("de").replace(/\s+/g, " ").trim();
  const exact = notes.filter((n) => key(n.title) === key(wanted));
  if (exact.length === 1) return exact[0]!;
  const words = key(wanted).split(" ").filter(Boolean);
  const holding = (exact.length ? exact : notes).filter((n) => words.every((w) => key(n.title).includes(w)));
  if (holding.length === 1) return holding[0]!;
  const listed = (holding.length ? holding : notes).slice(0, 10).map((n) => `"${n.title}" (document_id ${n.id})`).join(", ");
  if (holding.length > 1) {
    throw new Error(`several notes match "${wanted}": ${listed}. Ask the user which one, or call again with its document_id.`);
  }
  throw new Error(notes.length
    ? `no note is called "${wanted}". The user's notes: ${listed}. Use one of those, or create_text_document for a new note.`
    : `the user has no notes yet. Use create_text_document for a new note.`);
}

export const createTextDocument: WriteToolDefinition = {
  name: "create_text_document",
  summary: "File a new note: a text document in the documents module with a title and Markdown text. Runs at once, the user can undo it. For 'notiere …', 'mach eine Notiz', 'speichere das als Dokument'. To add to an existing note use append_to_text_document. Write the whole text from the user's words and this conversation; never invent facts.",
  permissions: ["module.documents", "documents.upload"],
  immediate: true,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "short German title of the note" },
      markdown: { type: "string", description: "the whole text in Markdown; start with the content, not with the title again" },
    },
    required: ["title", "markdown"],
  },
  async prepare(args) {
    const title = cleanTitle(args.title);
    const markdown = cleanMarkdown(args.markdown, "markdown");
    return {
      summary: `Notiz „${title}“ anlegen`,
      arguments: { title, markdown },
      note: "The user can change it later with \"Bearbeiten\" on the document.",
    };
  },
  async execute(args) {
    const doc = (await documents.createTextDocument({
      title: String(args.title),
      markdown: String(args.markdown),
    })) as unknown as TextDocumentDetail;
    return {
      summary: `Notiz „${doc.title ?? String(args.title)}“ angelegt`,
      route: `/dokumente/${doc.id}`,
      details: { document_id: doc.id, revision: doc.content_revision },
    };
  },
  async undo(_args, result, ctx: ToolContext) {
    if (!ctx.user.permissions.includes("documents.delete")) {
      throw new Error("Zum Rückgängigmachen fehlt dir das Recht, Dokumente zu löschen.");
    }
    const id = Number(result.details?.document_id);
    const doc = await readTextDocument(id);
    if (doc.content_revision !== revisionOf(result)) throw new Error(CHANGED_SINCE);
    await documents.deleteDocument({ id });
    return `Notiz „${doc.title ?? ""}“ wieder gelöscht`;
  },
  preview: previewOf,
};

export const appendToTextDocument: WriteToolDefinition = {
  name: "append_to_text_document",
  summary: "Add text at the end of one of the user's notes; the rest stays. Runs at once, the user can undo it. For 'schreib auf meine Einkaufsliste …', 'ergänze die Notiz …'. Name the note by title (note) or document_id; when none or several fit, the tool lists them. markdown holds only the new text.",
  permissions: ["module.documents", "documents.edit"],
  immediate: true,
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", description: "the note's title as the user names it, e.g. \"Einkaufsliste\"" },
      document_id: { type: "integer", description: "the note's document id, when an earlier result showed it" },
      markdown: { type: "string", description: "only the text to add, in Markdown, e.g. \"- Milch\"" },
    },
    required: ["markdown"],
  },
  async prepare(args) {
    const note = await resolveNote(args);
    const markdown = cleanMarkdown(args.markdown, "markdown");
    return {
      summary: `An Notiz „${note.title}“ anhängen`,
      arguments: { document_id: note.id, title: note.title, markdown },
    };
  },
  async execute(args) {
    const id = Number(args.document_id);
    const before = await readTextDocument(id);
    const doc = (await documents.appendToTextDocument({
      id,
      text: String(args.markdown),
      base_revision: before.content_revision,
    })) as unknown as TextDocumentDetail;
    return {
      summary: `An Notiz „${doc.title ?? String(args.title)}“ angehängt`,
      route: `/dokumente/${doc.id}`,
      details: { document_id: doc.id, revision: doc.content_revision, previous_markdown: before.markdown_source ?? "" },
    };
  },
  async undo(_args, result) {
    const id = Number(result.details?.document_id);
    const previous = result.details?.previous_markdown;
    if (typeof previous !== "string") throw new Error("Der vorige Stand ist nicht mehr bekannt.");
    const doc = await readTextDocument(id);
    if (doc.content_revision !== revisionOf(result)) throw new Error(CHANGED_SINCE);
    await documents.updateTextDocument({ id, title: doc.title ?? "", markdown: previous, base_revision: doc.content_revision });
    return `Notiz „${doc.title ?? ""}“ wieder wie vorher`;
  },
  preview: (args) => ({ title: String(args.title ?? ""), markdown: String(args.markdown ?? "") }),
};

export const rewriteTextDocument: WriteToolDefinition = {
  name: "rewrite_text_document",
  summary: "Propose to replace the whole text of a note (reorder, correct, remove parts); the card waits for \"Ausführen\". Read it first with get_document_text and write the complete new text: what you leave out is gone.",
  permissions: ["module.documents", "documents.edit"],
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", description: "the note's title as the user names it" },
      document_id: { type: "integer", description: "the note's document id, when an earlier result showed it" },
      title: { type: "string", description: "a new title; leave it out to keep the title" },
      markdown: { type: "string", description: "the complete new text in Markdown" },
    },
    required: ["markdown"],
  },
  async prepare(args) {
    const note = await resolveNote(args);
    const title = args.title === undefined ? note.title : cleanTitle(args.title);
    const markdown = cleanMarkdown(args.markdown, "markdown");
    const doc = await readTextDocument(note.id);
    return {
      summary: `Text der Notiz „${note.title}“ ersetzen`,
      arguments: { document_id: note.id, title, markdown, base_revision: doc.content_revision },
      note: "The card shows the new text; a change to the note before \"Ausführen\" makes the card refuse, so nothing is overwritten unseen.",
    };
  },
  async execute(args) {
    const doc = (await documents.updateTextDocument({
      id: Number(args.document_id),
      title: String(args.title),
      markdown: String(args.markdown),
      base_revision: String(args.base_revision),
    })) as unknown as TextDocumentDetail;
    return {
      summary: `Text der Notiz „${doc.title ?? String(args.title)}“ ersetzt`,
      route: `/dokumente/${doc.id}`,
      details: { document_id: doc.id },
    };
  },
  preview: previewOf,
};
