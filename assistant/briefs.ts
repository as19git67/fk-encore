/**
 * The working set of a conversation (#1534): documents, photos and bookings
 * the user handed over — from a selection, a detail page, or a result. The
 * model gets a few lines per object, built here from the services' own
 * endpoints; the full text of a document only when it asks for it with
 * `get_document_text`. Facts in a letter come from these lines, so they name
 * what a letter needs: who, when, which number, how much.
 */

import { documents, finance, photo } from "~encore/clients";
import type { AssistantUser, RefType } from "./types";

export interface ContextRef {
  type: RefType;
  id: number;
}

/** Objects in one working set, at most; a letter is about a handful. */
export const MAX_CONTEXT = 25;
const SUMMARY_CHARS = 400;

const NEEDS: Record<RefType, string[]> = {
  document: ["module.documents", "documents.view"],
  photo: ["module.photos", "photos.view"],
  transaction: ["module.finance", "finance.view"],
};

const LABEL: Record<RefType, string> = { document: "document", photo: "photo", transaction: "booking" };

/** Valid, distinct refs, in the order given, capped. */
export function cleanContext(raw: unknown): ContextRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ContextRef[] = [];
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const type = o.type;
    const id = Number(o.id);
    if ((type !== "document" && type !== "photo" && type !== "transaction") || !Number.isInteger(id) || id <= 0) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
    if (out.length >= MAX_CONTEXT) break;
  }
  return out;
}

function money(amount: number | string, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(Number(amount));
}

interface DocumentDetail {
  id: number;
  title: string | null;
  original_filename?: string;
  doc_date: string | null;
  sender?: string | null;
  correspondent_display?: string | null;
  document_type?: string | null;
  summary?: string | null;
  reference_numbers?: Array<{ kind?: string; value?: string }> | null;
}

/** The title a document goes by in a letter's list of enclosures. */
export function documentTitle(d: { id: number; title: string | null; original_filename?: string }): string {
  return d.title ?? d.original_filename ?? `Dokument ${d.id}`;
}

/** What the model reads about an object, and what the chip above the chat says. */
export interface ContextEntry {
  type: RefType;
  id: number;
  label: string;
  brief: string;
  visible: boolean;
}

function germanDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

async function documentBrief(id: number): Promise<{ brief: string; label: string }> {
  const d = (await documents.getDocument({ id })) as unknown as DocumentDetail;
  const suggestion = (await documents.getDocumentReceiptSuggestion({ id }).catch(() => null)) as unknown as { amount: number | null } | null;
  const refs = (d.reference_numbers ?? [])
    .filter((r) => r.value)
    .map((r) => `${r.kind ?? "ref"} ${r.value}`);
  const summary = (d.summary ?? "").replace(/\s+/g, " ").trim();
  const brief = [
    `document ${d.id}: "${documentTitle(d)}"`,
    `  from: ${d.correspondent_display ?? d.sender ?? "unknown"}; dated: ${d.doc_date?.slice(0, 10) ?? "unknown"}; type: ${d.document_type ?? "unknown"}`,
    refs.length ? `  reference numbers: ${refs.join("; ")}` : "  reference numbers: none recognised",
    suggestion?.amount != null ? `  amount (read from the text): ${money(suggestion.amount)}` : null,
    summary ? `  summary: ${summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS - 1)}…` : summary}` : null,
  ].filter(Boolean).join("\n");
  return { brief, label: documentTitle(d) };
}

interface TransactionView {
  id: number; booking_date: string; amount: string; currency_code: string;
  counterparty: string | null; purpose: string | null; end_to_end_ref?: string | null; mandate_ref?: string | null;
}

async function transactionBrief(id: number): Promise<{ brief: string; label: string }> {
  const t = (await finance.getTransaction({ id })) as unknown as TransactionView;
  const refs = [t.end_to_end_ref ? `end-to-end ${t.end_to_end_ref}` : null, t.mandate_ref ? `mandate ${t.mandate_ref}` : null].filter(Boolean);
  const brief = [
    `booking ${t.id}: ${t.booking_date.slice(0, 10)}, ${money(t.amount, t.currency_code)}, ${t.counterparty ?? "no counterparty"}`,
    t.purpose ? `  purpose: ${t.purpose.replace(/\s+/g, " ").slice(0, 200)}` : null,
    refs.length ? `  references: ${refs.join("; ")}` : null,
  ].filter(Boolean).join("\n");
  return { brief, label: `${germanDay(t.booking_date)} ${t.counterparty ?? "Buchung"} ${money(t.amount, t.currency_code)}` };
}

interface PhotoRow { id: number; taken_at?: string; created_at?: string; location_city?: string; location_country?: string; filename?: string }

async function photoBriefs(ids: number[]): Promise<Map<number, { brief: string; label: string }>> {
  const res = (await photo.getPhotoDetailsBatch({ ids: ids.join(",") })) as unknown as { photos: PhotoRow[] };
  return new Map(res.photos.map((p) => {
    const place = [p.location_city, p.location_country].filter(Boolean).join(", ");
    const taken = p.taken_at ?? p.created_at;
    return [p.id, {
      brief: `photo ${p.id}: taken ${taken?.slice(0, 10) ?? "unknown"}${place ? ` in ${place}` : ""}${p.filename ? ` (${p.filename})` : ""}`,
      label: [`Foto ${germanDay(taken)}`.trim(), place].filter(Boolean).join(", "),
    }];
  }));
}

/**
 * One brief per ref the user may see, in the given order. A ref of a module
 * the user lacks, or one the service refuses, is named as not visible rather
 * than dropped, so the model does not look for it elsewhere.
 */
export async function describeContext(refs: ContextRef[], user: AssistantUser): Promise<ContextEntry[]> {
  const may = (type: RefType) => NEEDS[type].every((p) => user.permissions.includes(p));
  const photos = refs.filter((r) => r.type === "photo" && may("photo")).map((r) => r.id);
  const photoLines = photos.length
    ? await photoBriefs(photos).catch(() => new Map<number, { brief: string; label: string }>())
    : new Map<number, { brief: string; label: string }>();
  const out: ContextEntry[] = [];
  for (const r of refs) {
    const hidden: ContextEntry = { ...r, label: "Nicht sichtbar", brief: `${LABEL[r.type]} ${r.id}: not visible to the user`, visible: false };
    if (!may(r.type)) {
      out.push(hidden);
      continue;
    }
    try {
      const found = r.type === "document" ? await documentBrief(r.id)
        : r.type === "transaction" ? await transactionBrief(r.id)
          : photoLines.get(r.id);
      out.push(found ? { ...r, ...found, visible: true } : hidden);
    } catch {
      out.push(hidden);
    }
  }
  return out;
}

/** The section of the system prompt that hands the model the working set. */
export function contextSection(briefs: string[]): string {
  if (!briefs.length) return "";
  return [
    "Working set — the user selected these for this conversation. \"Diese\", \"die Rechnungen\", \"darauf\" mean them. Facts about them come only from these lines or from tools (get_document_text for a document's full text):",
    ...briefs,
  ].join("\n");
}
