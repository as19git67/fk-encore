/**
 * Letters from selected context (documentation/plans/ki-assistent.md,
 * stage 8, #1534). The model writes the text; the server adds what it knows
 * for certain — the sender from the user's profile, today's date, the
 * enclosures by their titles — and renders a DIN 5008 page. Gaps the model
 * could not fill stay as `[[…]]`; the card shows the letter for editing and
 * refuses to send it off while one is left.
 */

import { eq } from "drizzle-orm";
import { documents } from "~encore/clients";
import db from "../../db/database";
import { assistantLetter, users } from "../../db/schema";
import { documentTitle } from "../briefs";
import { str } from "../format";
import { gapsIn, lines, renderLetterPdf } from "../letter-pdf";
import type {
  LetterAttachment,
  LetterDestination,
  LetterDraft,
  ProposalEdits,
  WriteToolDefinition,
} from "../proposals";
import type { ToolContext } from "../types";

const MAX_ATTACHMENTS = 20;
const MAX_BODY = 12_000;
const DESTINATIONS: LetterDestination[] = ["document", "collection"];

export const RECIPIENT_GAP = "[[Anschrift des Empfängers]]";
export const SUBJECT_GAP = "[[Betreff]]";
export const ADDRESS_GAP = "[[Ihre Anschrift]]";

/** The sender block: the user's name, then the address kept on their profile. */
export async function senderOf(userId: number): Promise<string> {
  const [u] = await db
    .select({ name: users.name, postal_address: users.postal_address })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const address = u?.postal_address?.trim();
  return [u?.name?.trim() || "[[Ihr Name]]", address || ADDRESS_GAP].join("\n");
}

const DATE_RE = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;
const AMOUNT_RE = /\b\d{1,3}(?:\.\d{3})*,\d{2}\s?(?:€|EUR)/g;
/** A reference number: letters, then digits with hyphens or slashes (BV-77-0042, RE-2026-0002, KD/12345). */
const REFERENCE_RE = /\b[A-Z]{1,6}[-/]?\d[\dA-Z/-]{3,}\b/g;
const FACTS_MAX = 8;

/**
 * The dates, amounts and reference numbers the texts read this turn name
 * and the letter does not — in the order the texts name them. The seventh
 * GPU run of 2026-10-28 wrote a letter that named the invoice number but
 * not the deadline the user asked for, and the answer claimed both; the
 * proposal's note now lists what the letter left out, so the next call can
 * carry it.
 */
export function factsLeftOut(texts: string[], letter: string): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const re of [DATE_RE, AMOUNT_RE, REFERENCE_RE]) {
      for (const m of text.matchAll(re)) {
        const fact = m[0];
        if (!letter.includes(fact) && !out.includes(fact)) out.push(fact);
      }
    }
  }
  return out.slice(0, FACTS_MAX);
}

/** The note of a proposal whose letter leaves these facts out; undefined when none. */
export function leftOutNote(facts: string[]): string | undefined {
  if (!facts.length) return undefined;
  return `The document text read this turn also names ${facts.join(", ")}, which the letter does not. If the user asked for one of them (a deadline, an amount, a reference number), call render_letter again with it in the body before you answer; never say the letter names what it does not.`;
}

/** The texts the turn read so far: full document texts and found passages. */
function textsReadThisTurn(ctx: ToolContext): string[] {
  return (ctx.turnResults?.() ?? [])
    .filter((r) => r.tool === "get_document_text" || r.tool === "find_text_in_document")
    .map((r) => r.content);
}

function attachmentsOf(v: unknown): LetterAttachment[] {
  return Array.isArray(v)
    ? v.flatMap((a) => {
        const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
        const id = Number(o.id);
        return Number.isInteger(id) && id > 0 ? [{ id, title: String(o.title ?? `Dokument ${id}`) }] : [];
      })
    : [];
}

function destinationsOf(v: unknown): LetterDestination[] {
  return Array.isArray(v) ? DESTINATIONS.filter((d) => v.includes(d)) : [];
}

function draftOf(args: Record<string, unknown>): LetterDraft {
  const letter = {
    sender: String(args.sender ?? ""),
    recipient: String(args.recipient ?? ""),
    subject: String(args.subject ?? ""),
    body: String(args.body ?? ""),
  };
  return {
    ...letter,
    attachments: attachmentsOf(args.attachments),
    destinations: destinationsOf(args.destinations),
    gaps: gapsIn(letter.sender, letter.recipient, letter.subject, letter.body),
  };
}

function editOf(args: Record<string, unknown>, edits: ProposalEdits): Record<string, unknown> {
  const next = { ...args };
  for (const key of ["sender", "recipient", "subject", "body"] as const) {
    const value = edits[key];
    if (value === undefined) continue;
    if (value.length > MAX_BODY) throw new Error(`${key} is too long`);
    next[key] = value;
  }
  if (edits.destinations) next.destinations = destinationsOf(edits.destinations);
  if (edits.attachment_ids) {
    // Titles of added documents are looked up (and their visibility checked) on execute.
    const known = new Map(attachmentsOf(args.attachments).map((a) => [a.id, a]));
    const ids = [...new Set(edits.attachment_ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_ATTACHMENTS);
    next.attachments = ids.map((id) => known.get(id) ?? { id, title: `Dokument ${id}` });
  }
  return next;
}

/** The name a model leaves as a gap under the closing ("[[Dein Name]]"). */
const NAME_GAP_RE = /\n*\[\[[^\]\n]*name[^\]\n]*\]\]\s*$/i;
const CLOSING_RE = /(?:grüßen|grüße|gruß|hochachtungsvoll)[,.!]?\s*$/i;

/**
 * Signs the letter with the user's name: in place of a name gap at the end,
 * or under a closing formula that has none. A name the model wrote stays.
 */
export function signed(body: string, name: string): string {
  if (!name || name.startsWith("[[")) return body;
  if (NAME_GAP_RE.test(body)) return body.replace(NAME_GAP_RE, `\n${name}`);
  if (CLOSING_RE.test(body)) return `${body.trimEnd()}\n${name}`;
  return body;
}

function firstLine(text: string): string {
  return lines(text)[0] ?? "";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function fileName(subject: string, date: string): string {
  const clean = subject.replace(/\[\[|\]\]/g, "").replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `Brief ${date}${clean ? ` ${clean}` : ""}.pdf`;
}

/** Saves the address the user typed on the card, so the next letter has it. */
async function rememberAddress(userId: number, sender: string): Promise<void> {
  const address = lines(sender).slice(1).join("\n");
  if (!address || gapsIn(address).length) return;
  await db.update(users).set({ postal_address: address }).where(eq(users.id, userId));
}

export const renderLetter: WriteToolDefinition = {
  name: "render_letter",
  summary: "Propose a letter as a DIN 5008 PDF: you write salutation, text and the closing formula; the server adds the user's sender block, today's date, the signature with the user's name and the enclosures. Everything the user wants mentioned goes into body. For any fact you do not have, write a gap naming it in double brackets, e.g. [[Mitgliedsnummer]]. Enclosures default to the documents of the working set.",
  permissions: ["module.assistant"],
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "the recipient's address, one line per row (name, street, postcode and town)" },
      subject: { type: "string" },
      body: { type: "string", description: "salutation, paragraphs separated by a blank line, closing formula (the server signs with the user's name); dates as DD.MM.YYYY. Every fact the user asked to be named (reference numbers, deadlines, amounts) stands here, not only in your reply" },
      attachment_document_ids: {
        type: "array",
        items: { type: "integer" },
        description: "documents enclosed with the letter (ids from the working set or an earlier tool result in this conversation, e.g. the contract a termination refers to); default: the documents of the working set",
      },
    },
    required: ["body"],
  },
  async prepare(args, ctx) {
    const written = str(args.body);
    if (!written) throw new Error("body is required");
    if (written.length > MAX_BODY) throw new Error(`the text is longer than ${MAX_BODY} characters`);
    const recipient = str(args.recipient) ?? RECIPIENT_GAP;
    const subject = str(args.subject) ?? SUBJECT_GAP;
    const sender = await senderOf(Number(ctx.user.userID));
    const body = signed(written, firstLine(sender));

    const askedFor = Array.isArray(args.attachment_document_ids)
      ? args.attachment_document_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : (ctx.context ?? []).filter((r) => r.type === "document").map((r) => r.id);
    const ids = [...new Set(askedFor)].slice(0, MAX_ATTACHMENTS);
    const attachments = await titlesOf(ids, ctx);

    const draft = draftOf({ sender, recipient, subject, body, attachments, destinations: ["document"] });
    const parts = [`Brief „${subject}“ an ${firstLine(recipient) || "?"}`];
    if (attachments.length) parts.push(`${plural(attachments.length, "Anlage", "Anlagen")}`);
    if (draft.gaps.length) parts.push(`${plural(draft.gaps.length, "Lücke", "Lücken")} zum Ausfüllen`);
    const leftOut = factsLeftOut(textsReadThisTurn(ctx), `${subject}\n${written}`);
    const notes = [
      draft.gaps.length
        ? `The card cannot run until the user fills in these gaps on it: ${draft.gaps.join("; ")}. Name them in plain words and say so; do not tell the user to press "Ausführen" before.`
        : "The letter has no gaps; the user can still change it on the card.",
    ];
    const left = leftOutNote(leftOut);
    if (left) notes.push(left);
    return {
      summary: parts.join(", "),
      arguments: { sender, recipient, subject, body, attachments, destinations: ["document"] },
      count: attachments.length || undefined,
      note: notes.join(" "),
    };
  },
  async execute(args, ctx) {
    const drafted = draftOf(args);
    // Enclosures may have been added on the card: only what the user can see goes along.
    const letter = { ...drafted, attachments: await titlesOf(drafted.attachments.map((a) => a.id), ctx) };
    if (letter.gaps.length) {
      throw new Error(`Der Brief hat noch Lücken: ${letter.gaps.join(", ")}. Bitte im Text ausfüllen.`);
    }
    if (!letter.body.trim()) throw new Error("Der Brief hat keinen Text.");
    const userId = Number(ctx.user.userID);
    const [row] = await db
      .insert(assistantLetter)
      .values({
        user_id: userId,
        conversation_id: ctx.conversationId ?? null,
        sender: letter.sender,
        recipient: letter.recipient,
        subject: letter.subject,
        body: letter.body,
        letter_date: ctx.today,
        attachments: letter.attachments,
      })
      .returning({ id: assistantLetter.id });
    await rememberAddress(userId, letter.sender);

    const wanted = new Set(letter.destinations);
    const parts = [`Brief „${letter.subject}“ erstellt`];
    let route: string | undefined;
    let documentId: number | null = null;
    let collectionId: number | null = null;
    if (wanted.has("document") || wanted.has("collection")) {
      const pdf = await renderLetterPdf({ ...letter, date: ctx.today, attachments: letter.attachments.map((a) => a.title) });
      const stored = (await documents.storeGeneratedDocument({
        filename: fileName(letter.subject, ctx.today),
        title: letter.subject,
        pdf_base64: pdf.toString("base64"),
        linked_document_ids: letter.attachments.map((a) => a.id),
      })) as unknown as { id: number };
      documentId = stored.id;
      route = `/dokumente/${documentId}`;
      parts.push("als Dokument abgelegt");
    }
    if (wanted.has("collection") && documentId !== null) {
      const created = (await documents.createCollection({
        title: `Brief: ${letter.subject}`.slice(0, 200),
        document_ids: [documentId, ...letter.attachments.map((a) => a.id)],
      })) as unknown as { id: number };
      collectionId = created.id;
      route = `/dokumente/mappen/${collectionId}`;
      parts.push(letter.attachments.length
        ? `mit ${plural(letter.attachments.length, "Anlage", "Anlagen")} in einer Sammelmappe`
        : "in einer Sammelmappe");
    }
    if (documentId !== null || collectionId !== null) {
      await db
        .update(assistantLetter)
        .set({ document_id: documentId, collection_id: collectionId })
        .where(eq(assistantLetter.id, row.id));
    }
    return {
      summary: parts.join(", "),
      route,
      download: `/assistant/letters/${row.id}/pdf`,
      details: { letter_id: row.id, document_id: documentId, collection_id: collectionId },
    };
  },
  draft: draftOf,
  edit: editOf,
};

/** The enclosures' titles; a document the user cannot see is left out. */
async function titlesOf(ids: number[], ctx: ToolContext): Promise<LetterAttachment[]> {
  if (!ids.length) return [];
  const mayRead = ["module.documents", "documents.view"].every((p) => ctx.user.permissions.includes(p));
  if (!mayRead) return [];
  const out: LetterAttachment[] = [];
  for (const id of ids) {
    try {
      const d = (await documents.getDocument({ id })) as unknown as { id: number; title: string | null; original_filename?: string };
      out.push({ id, title: documentTitle(d) });
    } catch {
      // Not visible: not enclosed.
    }
  }
  return out;
}
